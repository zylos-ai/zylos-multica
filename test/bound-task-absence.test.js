import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createTaskState } from '../src/lib/task-state.js';
import { reportFromCLI } from '../src/lib/task-report.js';
import { finishAbandonment } from '../src/lib/agent-execution.js';

const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' };
const task = { id: 'task', workspace_id: 'workspace', agent_id: 'agent', runtime_id: 'runtime', dispatched_at: '2026-10-15T01:02:03.123456Z' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-bound-absence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const options = { root, request: async (_config, _method, route, body) => {
    calls.push(route);
    return { ...task, status: route.endsWith('/start') ? 'running' : 'completed', result: body };
  }, removeTaskToken() { calls.push('remove-token'); } };
  return { root, options, calls, state: createTaskState(config, options) };
}

test('every existing generation-bound lifecycle operation ignores absent state without requests or JSON recreation', async t => {
  const f = fixture(t);
  const state = f.state;
  assert.equal(state.get('missing'), null);
  assert.equal(state.assertCurrent({ taskId: 'missing', generation: 'generation' }), null);
  const operations = [
    () => state.captureIssueAssignment('missing', 'generation', { id: 'issue' }),
    () => state.notifyCancellation('missing', 'generation', 'task_cancelled', () => { throw Error('must not deliver'); }),
    () => state.withRecovery('missing', 'generation', 'target', 'target-generation', () => { throw Error('must not recover'); }),
    () => state.abandonPreparation('missing', 'generation', 'stopped'),
    () => state.startAbandonedPreparation('missing', 'generation'),
    () => state.start('missing', 'generation'),
    () => state.setAgentDelivery('missing', 'generation', {}),
    () => state.acknowledgeLegacyStopped('missing', 'generation'),
    () => state.acknowledgeStopped('missing', 'generation'),
    () => state.setDelivery('missing', 'generation', {}),
    () => state.markDelivered('missing', 'generation'),
    () => state.markQuiesced('missing', 'generation'),
    () => state.report('missing', 'generation', 'complete', { output: 'done' }),
    () => state.report('missing', 'generation', 'fail', { error: 'stopped' }),
    () => state.reconcile('missing', { generation: 'generation', replay: true }),
  ];
  for (const operation of operations) assert.equal(await operation(), null);
  assert.equal(await state.markAccepted('missing', 'generation'), false);
  assert.equal(await state.quiesceUnaccepted('missing', 'generation'), false);
  assert.equal(await state.removeSettled('missing', 'generation', () => { throw Error('must not remove preparation'); }), false);
  assert.deepEqual(state.list(), []);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readdirSync(f.root).some(name => name.endsWith('.json')), false);
});

test('missing state still creates a first claim while a present stale generation rejects', async t => {
  const f = fixture(t);
  const record = await f.state.registerClaim(task);
  assert.ok(record.generation);
  assert.equal((await f.state.registerClaim(task)).generation, record.generation);
  assert.throws(() => f.state.assertCurrent({ taskId: task.id, generation: 'stale' }), /stale task generation/);
  await assert.rejects(f.state.start(task.id, 'stale'), /stale task generation/);
  await assert.rejects(f.state.notifyCancellation(task.id, 'stale', 'task_cancelled', () => true), /stale task generation/);
  assert.deepEqual(f.calls, []);
});

for (const action of ['progress', 'complete', 'fail', 'reconcile']) {
  test(`generation-bound ${action} ignores absent state before reply guard or transport`, async t => {
    const f = fixture(t);
    assert.equal(await reportFromCLI(config, 'missing@11111111-1111-4111-8111-111111111111', action, 'done mention://ignored', {
      ...f.options, loadTaskReplyContext() { throw Error('must not read legacy context'); },
    }), null);
    assert.deepEqual(f.calls, []);
    assert.equal(fs.existsSync(path.join(f.root, 'reply-guard')), false);
  });
}

test('abandonment ignores missing state initially and between lifecycle steps', async t => {
  const f = fixture(t);
  assert.equal(await finishAbandonment(f.state, 'missing', 'generation', 'stopped', { config }), null);
  const unexpected = () => { throw Error('unexpected subsequent lifecycle operation'); };
  assert.equal(await finishAbandonment({ get: () => ({}), acknowledgeLegacyStopped: async () => null,
    abandonPreparation: unexpected }, 'missing', 'generation', 'stopped', { acknowledgedStopped: true }), null);
  assert.equal(await finishAbandonment({ get: () => ({}), abandonPreparation: async () => null,
    startAbandonedPreparation: unexpected }, 'missing', 'generation', 'stopped'), null);
  assert.equal(await finishAbandonment({ get: () => ({}), abandonPreparation: async () => ({}),
    startAbandonedPreparation: async () => null, report: unexpected }, 'missing', 'generation', 'stopped'), null);
  assert.deepEqual(f.calls, []);
});

test('present running generation-bound progress still reaches the report transport', async t => {
  const f = fixture(t);
  const received = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    received.push({ route: req.url, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    res.end('{"status":"running"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const liveConfig = { ...config, base_url: `http://127.0.0.1:${server.address().port}`, pat: 'fixture' };
  const state = createTaskState(liveConfig, f.options);
  const record = await state.registerClaim(task);
  await state.start(task.id, record.generation);
  await reportFromCLI(liveConfig, `${task.id}@${record.generation}`, 'progress', 'working', f.options);
  assert.deepEqual(received, [{ route: '/api/daemon/tasks/task/progress', body: { summary: 'working' } }]);
});

test('removeSettled only removes settled matching state after synchronous preparation removal succeeds', async t => {
  const f = fixture(t);
  const record = await f.state.registerClaim(task);
  let callbacks = 0;
  const allow = () => { callbacks++; return true; };
  assert.equal(await f.state.removeSettled(task.id, record.generation, allow), false);
  await f.state.start(task.id, record.generation);
  await f.state.markQuiesced(task.id, record.generation);
  await f.state.report(task.id, record.generation, 'complete', { output: 'done' });
  assert.equal(await f.state.removeSettled(task.id, 'stale', allow), false);
  assert.equal(callbacks, 0);
  assert.equal(await f.state.removeSettled(task.id, record.generation, () => false), false);
  assert.ok(f.state.get(task.id));
  await assert.rejects(f.state.removeSettled(task.id, record.generation, () => { throw Error('preparation removal failed'); }), /preparation removal failed/);
  assert.ok(f.state.get(task.id));
  assert.equal(await f.state.removeSettled(task.id, record.generation, () => {
    assert.ok(f.state.get(task.id), 'state remains until preparation callback finishes');
    return allow();
  }), true);
  assert.equal(callbacks, 1);
  assert.equal(f.state.get(task.id), null);
  assert.ok(fs.readdirSync(f.root).some(name => name.endsWith('.lock')), 'OS lock files remain');
});

test('state listing ignores a file removed after directory enumeration', async t => {
  const f = fixture(t); await f.state.registerClaim(task);
  const open = fs.openSync;
  let removed = false;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (!removed && typeof file === 'string' && file.endsWith('.json')) { removed = true; fs.unlinkSync(file); }
    return open(file, ...args);
  });
  assert.deepEqual(f.state.list(), []); assert.equal(removed, true);
});
