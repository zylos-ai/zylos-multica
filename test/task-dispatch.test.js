import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskState } from '../src/lib/task-state.js';
import { createTaskDispatcher } from '../src/lib/task-dispatch.js';
const task = { id: 'task', agent_id: 'agent', runtime_id: 'runtime', workspace_id: 'workspace', issue_id: 'issue', dispatched_at: '2026-10-15T01:02:03.123456Z' };
function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-dispatch-'));
  const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' };
  const events = [];
  const calls = [];
  let clock = Date.parse('2026-10-15T01:03:00Z');
  const now = () => clock;
  const request = async (_c, _method, route, body) => {
    const kind = route.split('/').at(-1); events.push(kind === 'prepare-lease' ? 'lease' : kind);
    calls.push({ route, body });
    if (kind === 'start') assert.equal(body.dispatched_at, task.dispatched_at);
    if (overrides.request) return overrides.request(kind === 'prepare-lease' ? 'lease' : kind, body);
    if (kind === 'fail') return { ...task, status: 'failed', ...body };
    return { ...task, status: kind === 'start' ? 'running' : 'dispatched' };
  };
  const state = createTaskState(config, { root: path.join(root, 'state'), request, now, removeTaskToken() {} });
  const deps = { state, request, root: path.join(root, 'dispatch'), leaseIntervalMs: 10, now,
    snapshot: async value => ({ task: value, context: { index: '/fixture/context' }, ...(overrides.dueAt ? { dueAt: overrides.dueAt } : {}) }),
    render: async () => 'fixed card',
    worktrees: { prepare: async (_task, _resources, options) => { events.push('prepare'); await overrides.prepare?.(options); }, inspect: () => ({ bindings: [] }), quiesce: async () => { events.push('quiesce'); }, releasePreparation: async () => { events.push('release'); } },
    deliver: async () => { events.push('deliver'); return overrides.deliver ? overrides.deliver() : true; },
  };
  const make = () => createTaskDispatcher(config, deps);
  return { make, state, events, calls, root, advance(ms) { clock += ms; } };
}
test('original claim start is confirmed before C4 handoff and frozen delivery survives restart', async () => {
  const f = fixture(); const d = f.make();
  await d.enqueue(task); await d.drain();
  assert.deepEqual(f.events, ['lease', 'prepare', 'start', 'deliver']);
  const record = f.state.get(task.id);
  assert.equal(record.delivery.content, 'fixed card');
  assert.equal(record.delivery.endpoint, `${task.id}@${record.generation}`);
  const resumed = f.make(); resumed.resume(); await resumed.drain();
  assert.equal(f.events.filter(e => e === 'deliver').length, 1);
});
test('lost start response resumes exact start without renewing an already-started lease', async () => {
  let starts = 0;
  const f = fixture({ request(kind) {
    if (kind === 'start' && ++starts === 1) throw Error('response lost after commit');
    if (kind === 'lease' && starts) throw Error('already started');
    return { ...task, status: kind === 'start' ? 'running' : 'dispatched' };
  } });
  const d = f.make(); await d.enqueue(task); await d.drain();
  assert.equal(f.events.includes('deliver'), false);
  const resumed = f.make(); resumed.resume(); await resumed.drain();
  assert.deepEqual(f.events, ['lease', 'prepare', 'start', 'start', 'deliver']);
});
test('long asynchronous preparation renews the per-task lease', async () => {
  const f = fixture({ prepare: () => new Promise(resolve => setTimeout(resolve, 45)) });
  const d = f.make(); await d.enqueue(task); await d.drain();
  assert.ok(f.events.filter(e => e === 'lease').length >= 3);
  assert.equal(f.events.at(-1), 'deliver');
});
test('lease failure aborts preparation and never begins business or C4 handoff', async () => {
  let leases = 0;
  const f = fixture({ request(kind) { if (kind === 'lease' && ++leases > 1) throw Error('lease lost'); return task; },
    prepare: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })),
  });
  const d = f.make(); await d.enqueue(task); await d.drain();
  assert.equal(f.events.includes('start'), false); assert.equal(f.events.includes('deliver'), false);
});
test('uncertain handoff retries frozen card, but accepted execution is never repeated', async () => {
  let deliveries = 0; const f = fixture({ deliver: () => ++deliveries > 1 });
  const d = f.make(); await d.enqueue(task); await d.drain();
  const generation = f.state.get(task.id).generation;
  assert.equal(await f.state.markAccepted(task.id, generation), true);
  assert.equal(await f.state.markAccepted(task.id, generation), false);
  const resumed = f.make(); resumed.resume(); await resumed.drain();
  assert.equal(deliveries, 1);
});
test('stale exact claim fails before delivery even when preparation succeeds', async () => {
  const f = fixture({ request(kind) { if (kind === 'start') throw Object.assign(Error('stale'), { status: 409 }); return task; } });
  const d = f.make(); await d.enqueue(task); await d.drain();
  assert.equal(f.events.includes('deliver'), false);
  assert.equal(f.state.get(task.id).start_unknown, true);
});

test('unaccepted C4 delivery retries the frozen card after 60 seconds and stops after admission', async () => {
  const f = fixture(); const d = f.make();
  await d.enqueue(task); await d.drain();
  const first = f.state.get(task.id);
  f.advance(59_999); d.resume(); await d.drain();
  assert.equal(f.events.filter(e => e === 'deliver').length, 1);
  f.advance(1); d.resume(); await d.drain();
  const second = f.state.get(task.id);
  assert.equal(f.events.filter(e => e === 'deliver').length, 2);
  assert.equal(second.delivery.content, first.delivery.content);
  assert.equal(second.delivery.endpoint, first.delivery.endpoint);
  assert.equal(second.delivery.delivered_at - first.delivery.delivered_at, 60_000);
  await f.state.markAccepted(task.id, first.generation);
  f.advance(60_000); d.resume(); await d.drain();
  assert.equal(f.events.filter(e => e === 'deliver').length, 2);
});
test('future scheduled delivery is not redelivered until its due time', async () => {
  const f = fixture({ dueAt: '2026-10-15T01:05:00Z' }); const d = f.make();
  await d.enqueue(task); await d.drain();
  f.advance(119_999); d.resume(); await d.drain();
  assert.equal(f.events.filter(e => e === 'deliver').length, 1);
  f.advance(1); d.resume(); await d.drain();
  assert.equal(f.events.filter(e => e === 'deliver').length, 2);
});
test('scheduler failure parses generation endpoint and fails only the bound plain API task id', async () => {
  const f = fixture({ dueAt: '2026-10-15T01:05:00Z' }); const d = f.make();
  await d.enqueue(task); await d.drain();
  const record = f.state.get(task.id);
  const result = await d.failScheduled(record.delivery.endpoint, 'scheduler unavailable');
  assert.equal(result.report.state, 'confirmed');
  assert.equal(result.execution.quiesced, true);
  assert.equal(f.events.includes('quiesce'), true);
  assert.deepEqual(f.calls.filter(c => c.route.endsWith('/fail')), [{
    route: '/api/daemon/tasks/task/fail', body: { error: 'scheduler unavailable', failure_reason: 'runtime_offline' },
  }]);
});
test('scheduler failure cannot quiesce or fail an admitted task, and rejects a stale generation', async () => {
  const f = fixture({ dueAt: '2026-10-15T01:05:00Z' }); const d = f.make();
  await d.enqueue(task); await d.drain();
  const record = f.state.get(task.id);
  await assert.rejects(d.failScheduled('task@aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'stale'), /unknown scheduled task generation/);
  await f.state.markAccepted(task.id, record.generation);
  await d.failScheduled(record.delivery.endpoint, 'late scheduler failure');
  assert.equal(f.events.includes('quiesce'), false);
  assert.equal(f.calls.some(c => c.route.endsWith('/fail')), false);
  assert.equal(f.state.get(task.id).execution.quiesced, false);
});
test('scheduler failure loses admission race without quiescing or reporting the accepted work', async () => {
  const f = fixture({ dueAt: '2026-10-15T01:05:00Z' }); const d = f.make();
  await d.enqueue(task); await d.drain();
  const record = f.state.get(task.id);
  const quiesceUnaccepted = f.state.quiesceUnaccepted.bind(f.state);
  f.state.quiesceUnaccepted = async (taskId, generation) => {
    assert.equal(await f.state.markAccepted(taskId, generation), true);
    return quiesceUnaccepted(taskId, generation);
  };
  await d.failScheduled(record.delivery.endpoint, 'scheduler raced begin');
  assert.equal(f.events.includes('quiesce'), false);
  assert.equal(f.calls.some(c => c.route.endsWith('/fail')), false);
  assert.equal(f.state.get(task.id).execution.quiesced, false);
});

test('permanent preparation failure starts only to fail and never delivers; restart is idempotent', async () => {
  const f = fixture({ prepare() { throw Object.assign(Error('secret raw diagnostic'), { code: 'PREPARATION_PERMANENT', preparationReason: 'authentication required or denied' }); } });
  const d = f.make(); await d.enqueue(task); await d.drain();
  const r = f.state.get(task.id);
  assert.equal(r.report.state, 'confirmed');
  assert.equal(r.report.payload.failure_reason, 'environment_prepare_failed');
  assert.match(r.report.payload.error, /authentication required or denied/);
  assert.equal(r.execution.quiesced, true);
  assert.equal(r.delivery, undefined);
  assert.deepEqual(f.events, ['lease', 'prepare', 'release', 'start', 'start', 'fail']);
  const restarted = f.make(); restarted.resume(); await restarted.drain();
  assert.equal(f.events.filter(e => e === 'fail').length, 1);
  assert.equal(f.events.includes('deliver'), false);
  await assert.rejects(f.state.markAccepted(task.id, r.generation), /frozen terminal|quiesced/);
});
test('transient preparation retries have durable exponential backoff and terminate after three attempts', async () => {
  const f = fixture({ prepare() { throw Object.assign(Error('network'), { code: 'PREPARATION_TRANSIENT', preparationReason: 'network or timeout' }); } });
  let d = f.make(); await d.enqueue(task); await d.drain();
  assert.equal(f.state.get(task.id).report, null);
  d = f.make(); d.resume(); await d.drain();
  assert.equal(f.events.filter(e => e === 'prepare').length, 1);
  f.advance(15_000); d.resume(); await d.drain();
  f.advance(29_999); d.resume(); await d.drain();
  assert.equal(f.events.filter(e => e === 'prepare').length, 2);
  f.advance(1); d.resume(); await d.drain();
  assert.equal(f.events.filter(e => e === 'prepare').length, 3);
  assert.equal(f.state.get(task.id).report.state, 'confirmed');
  assert.match(f.state.get(task.id).report.payload.error, /3 attempts/);
});
test('busy or unconfirmed-stop preparation remains waiting without spending retry budget', async () => {
  for (const code of ['WORKTREE_BUSY', 'PROCESS_STOP_UNCONFIRMED']) {
    const f = fixture({ prepare() { throw Object.assign(Error('waiting'), { code }); } });
    const d = f.make(); await d.enqueue(task); await d.drain();
    for (let i = 0; i < 4; i++) { f.advance(60_000); d.resume(); await d.drain(); }
    assert.equal(f.state.get(task.id).report, null);
    assert.equal(f.state.get(task.id).preparation_failure, undefined);
    assert.equal(f.events.includes('release'), false);
  }
});
test('C4 failures are handoff failures, never charged to preparation retry budget', async () => {
  const f = fixture({ deliver: () => false }); const d = f.make();
  await d.enqueue(task); await d.drain();
  for (let i = 0; i < 4; i++) { f.advance(60_000); d.resume(); await d.drain(); }
  assert.equal(f.events.filter(e => e === 'prepare').length, 1);
  assert.equal(f.events.filter(e => e === 'deliver').length, 5);
  assert.equal(f.state.get(task.id).report, null);
});

test('snapshot failure terminates without persisting raw claim or attempting Git preparation', async () => {
  const f = fixture(); const record = await f.state.registerClaim(task);
  const d = createTaskDispatcher({ base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' }, {
    state: f.state, root: path.join(f.root, 'dispatch'),
    snapshot: async () => { throw Error('raw credential-secret'); },
    worktrees: { releasePreparation: async () => {} },
  });
  await d.enqueue({ ...task, auth_token: 'credential-secret' }); await d.drain();
  assert.equal(f.state.get(task.id).report.state, 'confirmed');
  assert.equal(f.state.get(task.id).generation, record.generation);
  assert.doesNotMatch(JSON.stringify(f.state.get(task.id)), /credential-secret/);
  assert.equal(fs.readdirSync(path.join(f.root, 'dispatch')).length, 0);
});
