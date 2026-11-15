import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import { createBridge } from '../src/index.js';
import { createTaskState } from '../src/lib/task-state.js';
import { createTaskDispatcher, SETTLED_CLEANUP_LIMIT } from '../src/lib/task-dispatch.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' };
  const logs = [], deliveries = [];
  const state = createTaskState(config, { root: path.join(root, 'state'), request: async (_config, _method, route) => {
    assert.ok(route.endsWith('/start'));
    const id = route.split('/').at(-2);
    const record = state.get(id);
    return { ...record, id, status: 'running' };
  } });
  const preparationRoot = path.join(root, 'preparations');
  const make = () => createTaskDispatcher(config, { state, root: preparationRoot,
    snapshot: async task => ({ task }), render: async () => 'card',
    log: (...args) => logs.push(args), deliver: async delivery => { deliveries.push(delivery); return true; } });
  make();
  function seed(id, changes = {}, entryChanges = {}) {
    const generation = crypto.randomUUID();
    const record = { schema: 1, origin: config.base_url, workspace_id: config.workspace_id, daemon_id: 'daemon',
      task_id: id, generation, execution: { accepted: true, quiesced: true },
      report: { generation, state: 'confirmed', token_cleanup_pending: false }, ...changes };
    const stateFile = path.join(state.root, `${crypto.createHash('sha256').update(JSON.stringify([config.base_url, config.workspace_id, id])).digest('hex')}.json`);
    const preparationFile = path.join(preparationRoot, `${crypto.createHash('sha256').update(`${config.base_url}|${config.workspace_id}|${id}`).digest('hex')}.json`);
    fs.writeFileSync(stateFile, JSON.stringify(record));
    fs.writeFileSync(preparationFile, JSON.stringify({ scope: `${config.base_url}|${config.workspace_id}`, task: { id }, generation, ...entryChanges }));
    return { stateFile, preparationFile, record };
  }
  return { config, state, make, seed, logs, deliveries, preparationRoot };
}

test('settled cleanup deletes both records in preparation-first order for each closed outcome', async t => {
  const f = fixture(t);
  const files = ['confirmed', 'conflict', 'superseded'].map(status => f.seed(status, { report: { state: status, token_cleanup_pending: false } }));
  const unlink = fs.unlinkSync;
  const removed = [];
  t.mock.method(fs, 'unlinkSync', file => { removed.push(file); return unlink(file); });
  await f.make().pruneSettled();
  for (const pair of files) {
    assert.equal(fs.existsSync(pair.preparationFile), false);
    assert.equal(f.state.get(pair.record.task_id), null);
    assert.ok(removed.indexOf(pair.preparationFile) < removed.indexOf(pair.stateFile));
  }
  assert.deepEqual(f.logs.map(row => row.slice(0, 2)), [['INFO', 'settled task records removed']]);
  assert.equal(f.logs[0][2].count, 3);
  const oldDaemon = f.seed('old-daemon', { daemon_id: 'retired-daemon' });
  await f.make().pruneSettled();
  assert.equal(fs.existsSync(oldDaemon.stateFile), false);
});

test('cleanup retains active, uncertain, uncleaned, mismatched and failed handoffs', async t => {
  const f = fixture(t);
  const cases = [
    ['active', { report: null }, {}], ['pending', { report: { state: 'pending', token_cleanup_pending: false } }, {}],
    ['uncertain', { report: { state: 'pending_unknown', token_cleanup_pending: false } }, {}],
    ['token', { report: { state: 'confirmed', token_cleanup_pending: true } }, {}],
    ['unknown-token', { report: { state: 'confirmed' } }, {}],
    ['generation', {}, { generation: crypto.randomUUID() }], ['handoff', {}, { handoff_failure: { attempts: 1 } }],
  ].map(([id, record, entry]) => f.seed(id, record, entry));
  await f.make().pruneSettled();
  for (const pair of cases) { assert.ok(fs.existsSync(pair.stateFile)); assert.ok(fs.existsSync(pair.preparationFile)); }
  assert.equal(f.logs.length, 0);
});

test('state deletion failure leaves a safe preparation-free state and the next poll finishes', async t => {
  const f = fixture(t); const pair = f.seed('half');
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => { if (file === pair.stateFile) throw Object.assign(Error('disk unavailable'), { code: 'EIO' }); return unlink(file); });
  const d = f.make(); await d.pruneSettled();
  assert.equal(fs.existsSync(pair.preparationFile), false); assert.ok(f.state.get('half'));
  assert.equal(f.logs.filter(row => row[0] === 'WARN').length, 1);
  t.mock.restoreAll(); f.logs.length = 0;
  assert.doesNotThrow(() => d.resume()); await d.drain(); await d.pruneSettled();
  assert.equal(f.state.get('half'), null);
  assert.equal(f.logs.filter(row => row[0] === 'WARN' || row[0] === 'ERROR').length, 0);
});

test('preparation deletion failure preserves state and does not prevent later cleanup or dispatch', async t => {
  const f = fixture(t); const broken = f.seed('broken'); f.seed('healthy');
  const active = f.seed('active', { report: null, start_confirmed: true, execution: { accepted: false, quiesced: false } });
  const record = f.state.get('active');
  record.delivery = { delivered: true, delivered_at: Date.now(), content: 'card', resource_model: 'agent-owned-v1' };
  fs.writeFileSync(active.stateFile, JSON.stringify(record));
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', file => { if (file === broken.preparationFile) throw Object.assign(Error('disk unavailable'), { code: 'EIO' }); return unlink(file); });
  const d = f.make(); await d.pruneSettled();
  assert.ok(f.state.get('broken')); assert.ok(fs.existsSync(broken.preparationFile)); assert.equal(f.state.get('healthy'), null);
  assert.doesNotThrow(() => d.resume()); await d.drain();
  assert.equal(f.logs.filter(row => row[0] === 'ERROR').length, 0);
  assert.equal(f.logs.filter(row => row[0] === 'WARN').length, 1);
  await d.enqueue({ id: 'new-task', workspace_id: 'workspace', agent_id: 'agent', runtime_id: 'runtime', dispatched_at: '2026-11-15T01:02:03Z' });
  await d.drain();
  assert.equal(f.deliveries.length, 1);
});

test('missing state is ignored by resume and scheduled failures without failure bookkeeping', async t => {
  const f = fixture(t); const pair = f.seed('removed'); fs.unlinkSync(pair.stateFile);
  const d = f.make(); d.resume(); await d.drain(); await d.failScheduled(`removed@${pair.record.generation}`, 'late');
  assert.equal(JSON.parse(fs.readFileSync(pair.preparationFile)).handoff_failure, undefined);
  assert.equal(f.logs.length, 0);
});

test('cleanup bounds each poll over 2000 records and yields while a claim can continue', async t => {
  const f = fixture(t);
  for (let i = 0; i < 2000; i++) f.seed(`settled-${i}`);
  const d = f.make(); const start = performance.now();
  const pending = d.pruneSettled(); const synchronousMs = performance.now() - start;
  let yielded = false; const immediate = new Promise(resolve => setImmediate(() => { yielded = true; resolve(); }));
  await pending; const elapsedMs = performance.now() - start;
  assert.equal(yielded, true); await immediate;
  assert.equal(f.state.list().length, 2000 - SETTLED_CLEANUP_LIMIT);
  assert.equal(fs.readdirSync(f.preparationRoot).length, 2000 - SETTLED_CLEANUP_LIMIT);
  assert.equal(f.logs[0][2].count, SETTLED_CLEANUP_LIMIT);
  t.diagnostic(JSON.stringify({ records: 2000, limit: SETTLED_CLEANUP_LIMIT, synchronousMs, elapsedMs }));
});

// Covers poll/cleanup overlap and shutdown at the bridge boundary. Run for cleanup
// wiring or lifecycle changes; unrelated changes can skip. Private fixture roots,
// mock API/scripts, no real service, database, tmux socket or platform credentials.
test('bridge keeps claiming while cleanup waits and drains cleanup on shutdown', { timeout: 10_000 }, async t => {
  const f = fixture(t); f.seed('finished');
  let release, entered, claims = 0, done = false;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const remove = f.state.removeSettled.bind(f.state);
  t.mock.method(f.state, 'removeSettled', async (...args) => { entered(); await gate; return remove(...args); });
  const bridge = createBridge({ ...f.config, runtime: { name: 'fixture' } }, {
    createWakeupChannel: () => ({ start() {}, stop() {} }),
    createTaskState: () => f.state, preparationRoot: f.preparationRoot,
    ensureWorkspaceResolved: async () => {},
    runScript: async () => ({ ok: true, stdout: '[]', stderr: '' }),
    request: async (_config, _method, route) => {
      if (route === '/api/daemon/register') return { runtimes: [{ id: 'runtime', provider: 'zylos' }], repos: [], settings: null };
      if (route === '/api/daemon/tasks/claim') { claims++; bridge.stop(); return { tasks: [] }; }
      return {};
    },
  });
  const running = bridge.run().then(() => { done = true; });
  t.after(async () => { release(); bridge.stop(); await running; });
  await started; await new Promise(resolve => setImmediate(resolve));
  assert.equal(claims, 1); assert.equal(done, false);
  release(); await running;
  assert.equal(f.state.get('finished'), null); assert.equal(done, true);
});

test('later polls continue the backlog and an empty cleanup emits no summary', async t => {
  const f = fixture(t);
  for (let i = 0; i <= SETTLED_CLEANUP_LIMIT; i++) f.seed(`backlog-${i}`);
  const d = f.make(); await d.pruneSettled();
  assert.equal(f.state.list().length, 1);
  await d.pruneSettled(); assert.equal(f.state.list().length, 0);
  assert.deepEqual(f.logs.map(row => row[2].count), [SETTLED_CLEANUP_LIMIT, 1]);
  await d.pruneSettled(); assert.equal(f.logs.length, 2);
});

test('step ignores state removed between scheduling and its initial read', async t => {
  const f = fixture(t); const pair = f.seed('racing', { report: null });
  const get = f.state.get.bind(f.state); let reads = 0;
  t.mock.method(f.state, 'get', id => {
    if (++reads === 2) fs.unlinkSync(pair.stateFile);
    return get(id);
  });
  const d = f.make(); d.resume(); await d.drain();
  assert.equal(f.logs.length, 0); assert.equal(f.deliveries.length, 0);
});

test('step ignores state removed after start without delivering or recording failure', async t => {
  const f = fixture(t); const pair = f.seed('racing', { report: null, execution: { accepted: false, quiesced: false } });
  const record = f.state.get('racing');
  record.start_confirmed = true;
  record.delivery = { resource_model: 'agent-owned-v1', content: 'card', delivered: false };
  fs.writeFileSync(pair.stateFile, JSON.stringify(record));
  t.mock.method(f.state, 'start', async () => { fs.unlinkSync(pair.stateFile); return null; });
  const d = f.make(); d.resume(); await d.drain();
  assert.equal(f.logs.length, 0); assert.equal(f.deliveries.length, 0);
});

test('failure bookkeeping does not recreate a missing task after delivery failure', async t => {
  const f = fixture(t); const pair = f.seed('racing', { report: null, execution: { accepted: false, quiesced: false } });
  const record = f.state.get('racing');
  record.start_confirmed = true;
  record.delivery = { resource_model: 'agent-owned-v1', content: 'card', delivered: false };
  fs.writeFileSync(pair.stateFile, JSON.stringify(record));
  t.mock.method(f.state, 'start', async () => record);
  const d = createTaskDispatcher(f.config, { state: f.state, root: f.preparationRoot,
    log: (...args) => f.logs.push(args), deliver: async () => {
      fs.unlinkSync(pair.stateFile); fs.unlinkSync(pair.preparationFile); throw Error('lost delivery response');
    } });
  d.resume(); await d.drain();
  assert.equal(f.logs.length, 0); assert.equal(fs.existsSync(pair.preparationFile), false);
});

test('successful dispatch ignores a preparation removed before failure clearing', async t => {
  const f = fixture(t); const pair = f.seed('racing', { report: null, execution: { accepted: false, quiesced: false } });
  const record = f.state.get('racing');
  record.start_confirmed = true;
  record.delivery = { resource_model: 'agent-owned-v1', content: 'card', delivered: false };
  fs.writeFileSync(pair.stateFile, JSON.stringify(record));
  t.mock.method(f.state, 'start', async () => record);
  const d = createTaskDispatcher(f.config, { state: f.state, root: f.preparationRoot,
    log: (...args) => f.logs.push(args), deliver: async () => { fs.unlinkSync(pair.preparationFile); return true; } });
  d.resume(); await d.drain();
  assert.equal(f.logs.length, 0); assert.equal(fs.existsSync(pair.preparationFile), false);
});

test('resume ignores a preparation removed after directory enumeration', async t => {
  const f = fixture(t); const pair = f.seed('racing', { report: null });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === pair.preparationFile) fs.unlinkSync(file);
    return read(file, ...args);
  });
  const d = f.make(); assert.doesNotThrow(() => d.resume()); await d.drain();
  assert.equal(f.logs.length, 0);
});

test('step ignores state removed while assignment capture was waiting', async t => {
  const f = fixture(t); const pair = f.seed('racing', { report: null }, { issue: { id: 'issue' } });
  t.mock.method(f.state, 'captureIssueAssignment', async () => { fs.unlinkSync(pair.stateFile); return null; });
  const d = f.make(); d.resume(); await d.drain();
  assert.equal(f.logs.length, 0); assert.equal(f.deliveries.length, 0);
});
