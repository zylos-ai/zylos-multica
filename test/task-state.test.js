import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createTaskState, atomicTaskWrite, withTaskLock } from '../src/lib/task-state.js';
import { parseTaskEndpoint } from '../src/lib/task-report.js';

const config = { base_url: 'https://example.test', workspace_id: 'ws', daemon_id: 'daemon', pat: 'never-save-pat' };
const task = { id: 'task', workspace_id: 'ws', agent_id: 'agent', runtime_id: 'runtime', issue_id: 'issue', dispatched_at: '2026-10-15T08:00:00.123456Z', auth_token: 'mat_never-save-token' };
const remote = (status, extra = {}) => ({ id: task.id, workspace_id: 'ws', agent_id: 'agent', runtime_id: 'runtime', issue_id: 'issue', chat_session_id: '', dispatched_at: '2026-10-15T08:00:00Z', status, ...extra });
async function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [], removed = [];
  let clock = 10000;
  const options = { root, now: () => clock, removeTaskToken: id => removed.push(id), request: async (_config, method, route, body, opts) => {
    calls.push({ method, route, body, opts });
    if (route.endsWith('/start')) return remote('running');
    if (route.endsWith('/complete')) return remote('completed', { result: { ...body } });
    if (route.endsWith('/fail')) return remote('failed', { error: body.error, failure_reason: body.failure_reason || '' });
    return [];
  }, ...overrides };
  const state = createTaskState(config, options);
  const registered = await state.registerClaim(task);
  const generation = registered.generation;
  const begin = async () => { await state.start(task.id, generation); await state.markAccepted(task.id, generation); await state.markQuiesced(task.id, generation); calls.length = 0; };
  return { root, options, state, generation, calls, removed, begin, advance: ms => { clock += ms; } };
}

test('claims and starts persist without credentials; timestamp retains microseconds, duplicate acceptance suppressed', async t => {
  const f = await fixture(t);
  assert.equal((await f.state.registerClaim(task)).generation, f.generation);
  await f.state.start(task.id, f.generation);
  assert.deepEqual(f.calls[0].body, { runtime_id: 'runtime', dispatched_at: task.dispatched_at });
  assert.equal(await f.state.markAccepted(task.id, f.generation), true);
  assert.equal(await f.state.markAccepted(task.id, f.generation), false);
  assert.equal(f.state.assertCurrent({ taskId: task.id, generation: f.generation, requireRunning: true }).generation, f.generation);
  const stored = fs.readdirSync(f.root).filter(n => n.endsWith('.json'));
  assert.equal(stored.length, 1);
  assert.equal(fs.statSync(f.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(f.root, stored[0])).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(path.join(f.root, stored[0]), 'utf8'), /never-save/);
});

test('start response lost remains blocked until exact claim acknowledgement; old claim 409 never starts execution', async t => {
  let fail = true;
  const bodies = [];
  const f = await fixture(t, { request: async (_c, _m, _p, body) => { bodies.push(body); if (fail) throw Object.assign(new Error('lost or stale'), { status: 409 }); return remote('running'); } });
  await assert.rejects(f.state.start(task.id, f.generation));
  assert.equal(f.state.get(task.id).start_unknown, true);
  assert.throws(() => f.state.assertCurrent({ taskId: task.id, generation: f.generation, requireRunning: true }), /not confirmed/);
  fail = false;
  await f.state.start(task.id, f.generation);
  assert.equal(f.state.get(task.id).start_confirmed, true);
  assert.ok(bodies.every(body => body.dispatched_at === task.dispatched_at));
});

test('freeze precedes POST; confirmed receipt precedes token cleanup; output preserved byte-for-byte', async t => {
  let f;
  f = await fixture(t, { removeTaskToken: () => assert.equal(createTaskState(config, f.options).get(task.id).report.state, 'confirmed') });
  await f.begin();
  f.options.request = async (_c, _m, route, body) => {
    if (route.endsWith('/start')) return remote('running');
    const disk = f.state.get(task.id);
    assert.equal(disk.report.state, 'pending_unknown');
    assert.deepEqual(disk.report.payload, body);
    return remote('completed', { result: { ...body, pr_url: '', session_id: '', work_dir: '' } });
  };
  const fresh = createTaskState(config, f.options);
  const result = await fresh.report(task.id, f.generation, 'complete', { output: '  answer\n\n' });
  assert.equal(result.report.state, 'confirmed');
  assert.equal(result.report.payload.output, '  answer\n\n');
});

test('failed pending write sends zero requests; active token and execution state retained', async t => {
  const f = await fixture(t);
  await f.begin();
  const fail = createTaskState(config, { ...f.options, write: (file, record) => { if (record.report) throw new Error('disk full'); atomicTaskWrite(file, record); } });
  await assert.rejects(fail.report(task.id, f.generation, 'complete', { output: 'done' }), /disk full/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.removed.length, 0);
  assert.equal(f.state.get(task.id).report, null);
});

test('lost completion response reads authority after restart without duplicate POST', async t => {
  const f = await fixture(t);
  await f.begin();
  let posts = 0;
  const recovered = createTaskState(config, { ...f.options, request: async (_c, method, route, body) => {
    if (route.endsWith('/start')) return remote('running');
    if (method === 'POST') { posts++; throw new Error('response lost'); }
    return [remote('completed', { result: { output: 'done' } })];
  } });
  assert.equal((await recovered.report(task.id, f.generation, 'complete', { output: 'done' })).report.state, 'confirmed');
  const restarted = createTaskState(config, f.options);
  assert.equal((await restarted.reconcile(task.id, { generation: f.generation, replay: true })).report.state, 'confirmed');
  assert.equal(posts, 1);
});

test('agent history pagination follows cursor and keeps issue failure/unavailable outcomes pending', async t => {
  const f = await fixture(t);
  await f.begin();
  const routes = [];
  const recovered = createTaskState(config, { ...f.options, request: async (_c, method, route, body, opts) => {
    routes.push(route);
    if (route.endsWith('/start')) return remote('running');
    if (method === 'POST') throw new Error('lost');
    if (route.includes('task-runs')) return [];
    assert.equal(opts.includeHeaders, true);
    return route.includes('before=') ? { data: [remote('completed', { result: { output: 'done' } })], headers: {} }
      : { data: [{ id: 'other' }], headers: { 'x-agent-tasks-next-cursor': 'opaque+/=' } };
  } });
  assert.equal((await recovered.report(task.id, f.generation, 'complete', { output: 'done' })).report.state, 'confirmed');
  assert.match(routes.at(-1), /before=opaque%2B%2F%3D/);
});

test('permission denial retains frozen report and token; changed payload, new claim and stale writer make zero POSTs', async t => {
  const f = await fixture(t);
  await f.begin();
  let posts = 0;
  const pending = createTaskState(config, { ...f.options, request: async (_c, method, route) => { if (route.endsWith('/start')) return remote('running'); if (method === 'POST') posts++; throw new Error('403'); } });
  assert.equal((await pending.report(task.id, f.generation, 'complete', { output: 'done' })).report.state, 'pending_unknown');
  posts = 0;
  await assert.rejects(pending.report(task.id, f.generation, 'complete', { output: 'different' }), /conflicts/);
  await assert.rejects(pending.report(task.id, 'old-generation', 'complete', { output: 'done' }), /stale/);
  await assert.rejects(pending.reconcile(task.id, { generation: 'old-generation', replay: true }), /stale/);
  await assert.rejects(pending.registerClaim({ ...task, dispatched_at: '2026-10-15T08:00:00.999999Z' }), /claim changed/);
  assert.equal(posts, 0);
  assert.equal(f.removed.length, 0);
  assert.equal(pending.get(task.id).report.payload.output, 'done');
});

for (const [status, extra, expected] of [
  ['completed', { result: { output: 'another result' } }, 'conflict'],
  ['completed', { result: { output: 'done', branch_name: 'other' } }, 'conflict'],
  ['cancelled', {}, 'superseded'], ['failed', {}, 'superseded'],
  ['dispatched', {}, 'pending_not_running'], ['queued', {}, 'pending_not_running'],
  ['running', {}, 'pending_unknown'], ['completed', {}, 'pending_unknown'],
  ['completed', { id: 'another', result: { output: 'done' } }, 'pending_unknown'],
]) test(`HTTP 200 ${status} -> ${expected}: ${JSON.stringify(extra)}`, async t => {
  const f = await fixture(t); await f.begin();
  const state = createTaskState(config, { ...f.options, request: async (_c, _m, route) => route.endsWith('/start') ? remote('running') : remote(status, extra) });
  const result = await state.report(task.id, f.generation, 'complete', { output: 'done' });
  assert.equal(result.report.state, expected);
  assert.equal(f.removed.length, ['confirmed', 'conflict', 'superseded'].includes(expected) ? 1 : 0);
});

test('running readback replay requires precise start gate, frozen payload and backoff; fail is never blindly replayed', async t => {
  for (const action of ['complete', 'fail']) {
    const f = await fixture(t); await f.begin();
    const calls = [];
    let allowStart = true;
    const state = createTaskState(config, { ...f.options, request: async (_c, method, route, body) => {
      calls.push({ method, route, body });
      if (method === 'GET') return [remote('running')];
      if (route.endsWith('/start')) { assert.equal(body.dispatched_at, task.dispatched_at); if (!allowStart) throw new Error('409'); return remote('running'); }
      throw new Error('lost');
    } });
    await state.report(task.id, f.generation, action, { [action === 'complete' ? 'output' : 'error']: 'done' });
    allowStart = false; calls.length = 0;
    await state.reconcile(task.id, { generation: f.generation, replay: true });
    assert.ok(calls.every(c => c.method === 'GET')); // bounded backoff
    f.advance(10000); calls.length = 0;
    await state.reconcile(task.id, { generation: f.generation, replay: true });
    assert.equal(calls.filter(c => c.route.endsWith(`/${action}`)).length, 0);
    if (action === 'complete') assert.equal(calls.filter(c => c.route.endsWith('/start')).length, 1);
    allowStart = true; calls.length = 0;
    await state.reconcile(task.id, { generation: f.generation, replay: true });
    assert.equal(calls.filter(c => c.route.endsWith(`/${action}`)).length, action === 'complete' ? 1 : 0);
    if (action === 'complete') assert.deepEqual(calls.find(c => c.route.endsWith('/complete')).body, { output: 'done' });
  }
});

test('invalid text and missing quiescence fail before POST; cleanup failure does not replay', async t => {
  const f = await fixture(t);
  await f.state.start(task.id, f.generation); f.calls.length = 0;
  await assert.rejects(f.state.report(task.id, f.generation, 'complete', { output: 'done' }), /stopped/);
  await f.state.markQuiesced(task.id, f.generation);
  for (const output of ['a\0b', '\ud800']) await assert.rejects(f.state.report(task.id, f.generation, 'complete', { output }), /invalid/);
  assert.equal(f.calls.length, 0);
  const state = createTaskState(config, { ...f.options, removeTaskToken: () => { throw new Error('disk'); } });
  const result = await state.report(task.id, f.generation, 'complete', { output: 'done' });
  assert.equal(result.report.token_cleanup_pending, true);
  f.calls.length = 0;
  await state.reconcile(task.id, { generation: f.generation, replay: true });
  assert.equal(f.calls.length, 0);
});

test('two independent state instances serialize report; second payload cannot overwrite first', async t => {
  const f = await fixture(t); await f.begin();
  let signalEntered, release;
  const entered = new Promise(r => { signalEntered = r; });
  const held = new Promise(r => { release = r; });
  let posts = 0;
  const state = createTaskState(config, { ...f.options, request: async (_c, _m, route, body) => { if (route.endsWith('/start')) return remote('running'); posts++; signalEntered(); await held; return remote('completed', { result: body }); } });
  const first = state.report(task.id, f.generation, 'complete', { output: 'first' });
  await entered;
  const second = createTaskState(config, f.options).report(task.id, f.generation, 'complete', { output: 'second' });
  release();
  await first;
  await assert.rejects(second, /conflicts/);
  assert.equal(posts, 1);
});

test('real reporter SIGKILL releases OS mutex but never marks execution quiesced', async t => {
  const f = await fixture(t);
  const module = new URL('../src/lib/task-state.js', import.meta.url).href;
  const lockfile = path.join(f.root, 'crash.lock');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withTaskLock} from ${JSON.stringify(module)}; await withTaskLock(${JSON.stringify(lockfile)}, async()=>{console.log('held'); await new Promise(()=>{});});`], { stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep the child alive with the inherited flock pipe (not an invented PID TTL).
  await once(child.stdout, 'data');
  let acquired = false;
  const waiting = withTaskLock(lockfile, async () => { acquired = true; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(acquired, false, 'second process must wait for live holder');
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  await waiting;
  assert.equal(acquired, true);
  assert.equal(f.state.get(task.id).execution.quiesced, false);
});

test('endpoint requires caller generation and rejects ambiguous routes', () => {
  const gen = '12345678-1234-4234-8234-123456789abc';
  assert.deepEqual(parseTaskEndpoint(`task@${gen}`), { taskId: 'task', generation: gen });
  for (const value of ['task', 'task@bad', `a@b@${gen}`, `../task@${gen}`, `task @${gen}`]) assert.throws(() => parseTaskEndpoint(value));
  assert.deepEqual(parseTaskEndpoint('task', { allowLegacy: true }), { taskId: 'task' });
});

test('delivery card is durable before start, immutable, and replay acceptance is separate from delivery receipt', async t => {
  const f = await fixture(t);
  const delivery = { content: 'frozen task card', endpoint: `task@${f.generation}`, dueAt: '2030-01-01T00:00:00Z' };
  await f.state.setDelivery(task.id, f.generation, delivery);
  const fresh = createTaskState(config, f.options);
  assert.deepEqual(fresh.list()[0].delivery, { ...delivery, delivered: false });
  await assert.rejects(fresh.markDelivered(task.id, f.generation), /not confirmed/);
  await assert.rejects(fresh.setDelivery(task.id, f.generation, { ...delivery, content: 'changed' }), /conflicts/);
  await fresh.start(task.id, f.generation);
  await fresh.markDelivered(task.id, f.generation);
  assert.equal(fresh.get(task.id).execution.accepted, false);
  assert.equal(await fresh.markAccepted(task.id, f.generation), true);
  assert.equal(await fresh.markAccepted(task.id, f.generation), false);
  assert.equal((await fresh.setDelivery(task.id, f.generation, delivery)).delivery.delivered, true);
});

test('exact submitted metadata confirms only when result and task metadata agree', async t => {
  const f = await fixture(t); await f.begin();
  const payload = { output: 'done', work_dir: '/private/worktree', branch_name: 'branch', pr_url: 'https://example.test/pr/1' };
  const state = createTaskState(config, { ...f.options, request: async (_c, _m, route) => route.endsWith('/start') ? remote('running') : remote('completed', { result: payload, work_dir: payload.work_dir, branch_name: payload.branch_name }) });
  assert.equal((await state.report(task.id, f.generation, 'complete', payload)).report.state, 'confirmed');
});

test('completed response with wrong submitted top-level metadata remains a conflict', async t => {
  const f = await fixture(t); await f.begin();
  const payload = { output: 'done', work_dir: '/private/worktree' };
  const state = createTaskState(config, { ...f.options, request: async (_c, _m, route) => route.endsWith('/start') ? remote('running') : remote('completed', { result: payload, work_dir: '/another' }) });
  const result = await state.report(task.id, f.generation, 'complete', payload);
  assert.equal(result.report.state, 'conflict');
  assert.deepEqual(result.report.differences, ['task.work_dir']);
});

test('all successful pages without a task and repeated cursors remain pending, never success or automatic POST replay', async t => {
  for (const repeat of [true, false]) {
    const f = await fixture(t); await f.begin();
    let posts = 0;
    const state = createTaskState(config, { ...f.options, request: async (_c, method, route) => {
      if (route.endsWith('/start')) return remote('running');
      if (method === 'POST') { posts++; throw new Error('lost'); }
      if (route.includes('task-runs')) return [];
      return { data: [], headers: repeat ? { 'x-agent-tasks-next-cursor': 'again' } : {} };
    } });
    const result = await state.report(task.id, f.generation, 'complete', { output: 'done' });
    assert.equal(result.report.state, 'pending_unknown');
    assert.equal(posts, 1);
    assert.equal(f.removed.length, 0);
  }
});

test('initial terminal report revalidates original claim; cached start cannot complete or fail a redispatched task', async t => {
  for (const action of ['complete', 'fail']) {
    const f = await fixture(t); await f.begin();
    const calls = [];
    const state = createTaskState(config, { ...f.options, request: async (_c, method, route, body) => {
      calls.push({ method, route, body });
      if (route.endsWith('/start')) {
        assert.equal(body.dispatched_at, task.dispatched_at);
        assert.equal(f.state.get(task.id).report.action, action, 'pending must already be durable');
        throw Object.assign(new Error('original claim was superseded'), { status: 409 });
      }
      if (method === 'GET') return [remote('running')]; // seconds cannot prove same claim
      return remote(action === 'complete' ? 'completed' : 'failed', { result: body, error: body.error, failure_reason: body.failure_reason });
    } });
    const payload = { [action === 'complete' ? 'output' : 'error']: 'done' };
    const result = await state.report(task.id, f.generation, action, payload);
    assert.equal(result.report.state, 'pending_unknown');
    assert.equal(result.report.attempts, 0);
    assert.equal(calls.filter(call => call.route.endsWith(`/${action}`)).length, 0);
    assert.equal(f.removed.length, 0);
    assert.deepEqual(f.state.get(task.id).report.payload[action === 'complete' ? 'output' : 'error'], 'done');
  }
});

test('failed report checks every submitted observable metadata field before confirmation', async t => {
  for (const changed of [null, 'work_dir', 'branch_name', 'durable_work_dir']) {
    const f = await fixture(t); await f.begin();
    const payload = { error: 'failed', work_dir: '/expected', branch_name: 'expected', durable_work_dir: '/durable' };
    const fields = { error: 'failed', failure_reason: 'agent_error', work_dir: '/expected', branch_name: 'expected', durable_work_dir: '/durable' };
    if (changed) fields[changed] = 'different';
    const state = createTaskState(config, { ...f.options, request: async (_c, _m, route) => route.endsWith('/start') ? remote('running') : remote('failed', fields) });
    const result = await state.report(task.id, f.generation, 'fail', payload);
    assert.equal(result.report.state, changed ? 'conflict' : 'confirmed');
    if (changed) assert.deepEqual(result.report.differences, [`task.${changed}`]);
  }
});

test('failure session mutations absent from authority response are rejected before pending or POST', async t => {
  const f = await fixture(t); await f.begin();
  for (const extra of [{ session_id: 'session' }, { session_rollout_missing: true }, { retired_session_id: 'retired' }]) {
    await assert.rejects(f.state.report(task.id, f.generation, 'fail', { error: 'failed', ...extra }), /invalid terminal field/);
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.state.get(task.id).report, null);
  assert.equal(f.removed.length, 0);
});
