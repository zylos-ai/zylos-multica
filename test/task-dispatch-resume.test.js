import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { atomicTaskWrite, createTaskState } from '../src/lib/task-state.js';
import { createTaskDispatcher } from '../src/lib/task-dispatch.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-resume-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' };
  const scope = 'https://example.test|workspace';
  const stateRoot = path.join(root, 'state');
  const dispatchRoot = path.join(root, 'dispatch');
  const metrics = { writes: 0, syncs: 0, spawns: 0, removed: 0, deliveries: 0, requests: 0 };
  const records = new Map();
  const options = { root: stateRoot, now: () => 100_000,
    write(file, value) { metrics.writes++; atomicTaskWrite(file, value); },
    removeTaskToken() { metrics.removed++; },
    async request(_config, method, route, body) {
      metrics.requests++;
      const id = route.includes('/issues/') ? route.split('/')[3] : route.split('/').at(-2);
      const record = records.get(id);
      assert.ok(record, route);
      const remote = { id, workspace_id: 'workspace', agent_id: 'agent', runtime_id: 'runtime', issue_id: id,
        status: route.endsWith('/start') ? 'running' : route.endsWith('/fail') ? 'failed' : 'completed',
        result: { output: 'done' }, ...body };
      return method === 'GET' ? [remote] : remote;
    },
  };
  const state = createTaskState(config, options);
  function make(selectedState = state) {
    return createTaskDispatcher(config, { state: selectedState, root: dispatchRoot, now: () => 100_000,
      snapshot: async task => ({ task }), render: async () => 'card',
      deliver: async () => { metrics.deliveries++; return true; },
    });
  }
  make(); // Create the private preparation directory before seeding it.
  function seed(id, changes = {}, entryChanges = {}) {
    const generation = crypto.randomUUID();
    const record = { schema: 1, origin: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon',
      task_id: id, agent_id: 'agent', runtime_id: 'runtime', issue_id: id, chat_session_id: '', generation,
      dispatched_at: '2026-10-15T01:02:03.123456Z', start_confirmed: true,
      execution: { accepted: true, quiesced: true }, report: { state: 'confirmed', token_cleanup_pending: false }, ...changes };
    records.set(id, record);
    const stateKey = crypto.createHash('sha256').update(JSON.stringify(['https://example.test', 'workspace', id])).digest('hex');
    fs.writeFileSync(path.join(stateRoot, `${stateKey}.json`), JSON.stringify(record));
    const entry = { scope, task: { id }, generation, ...entryChanges };
    const dispatchKey = crypto.createHash('sha256').update(`${scope}|${id}`).digest('hex');
    const entryFile = path.join(dispatchRoot, `${dispatchKey}.json`);
    fs.writeFileSync(entryFile, JSON.stringify(entry));
    return { record, entryFile };
  }
  const originalSync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', function (...args) { metrics.syncs++; return originalSync.apply(this, args); });
  const originalSpawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', function (...args) { metrics.spawns++; return originalSpawn.apply(this, args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { root, config, state, options, make, seed, metrics };
}

test('resume skips retained closed reports without locks, writes or token work, including after restart', async t => {
  const f = fixture(t);
  const states = ['confirmed', 'conflict', 'superseded'];
  for (let i = 0; i < 555; i++) f.seed(`closed-${i}`, { report: { state: states[i % states.length], token_cleanup_pending: false } });
  for (let round = 0; round < 2; round++) {
    const state = createTaskState(f.config, f.options);
    const dispatcher = f.make(state);
    dispatcher.resume(); await dispatcher.drain();
  }
  for (const field of ['spawns', 'writes', 'syncs', 'removed', 'requests', 'deliveries']) assert.equal(f.metrics[field], 0, field);
  assert.equal(fs.readdirSync(f.state.root).filter(name => name.endsWith('.lock')).length, 0);
  assert.equal(f.state.list().length, 555);
});

test('closed reports retain pending or unrecorded cleanup and clear a transient handoff failure once', async t => {
  const f = fixture(t);
  f.seed('pending-cleanup', { report: { state: 'conflict', token_cleanup_pending: true } });
  f.seed('unrecorded-cleanup', { report: { state: 'superseded' } });
  const failure = f.seed('deferred', {}, { handoff_failure: { attempts: 1, stage: 'reconcile', code: 'DISK' } });
  const dispatcher = f.make(); dispatcher.resume(); await dispatcher.drain();
  assert.equal(f.metrics.removed, 2);
  assert.equal(f.metrics.writes, 2);
  assert.equal(f.metrics.syncs, 6); // Two state updates and one preparation update.
  assert.equal(f.metrics.spawns, 3);
  assert.equal(JSON.parse(fs.readFileSync(failure.entryFile)).handoff_failure, undefined);
  for (const id of ['pending-cleanup', 'unrecorded-cleanup']) assert.equal(f.state.get(id).report.token_cleanup_pending, false);
  const previous = { ...f.metrics };
  const restarted = f.make(); restarted.resume(); await restarted.drain();
  for (const field of Object.keys(previous)) assert.equal(f.metrics[field], previous[field], field);
});

test('resume reconciles every pending report state and finishes preparation failures without a snapshot', async t => {
  const f = fixture(t);
  for (const reportState of ['pending', 'pending_unknown', 'pending_not_running']) {
    f.seed(reportState, { report: { state: reportState, action: 'complete', payload: { output: 'done' } } });
  }
  const abandoned = f.seed('abandoned', { report: null, start_confirmed: false,
    execution: { accepted: false, quiesced: true }, preparation_failure: { reason: 'context unavailable' } });
  fs.unlinkSync(abandoned.entryFile);
  const dispatcher = f.make(); dispatcher.resume(); await dispatcher.drain();
  for (const id of ['pending', 'pending_unknown', 'pending_not_running', 'abandoned']) {
    assert.equal(f.state.get(id).report.state, 'confirmed', id);
    assert.equal(f.state.get(id).report.token_cleanup_pending, false, id);
  }
  assert.equal(f.metrics.removed, 4);
  assert.equal(f.metrics.deliveries, 0);
});

test('resume preserves scheduled and active handoffs while locally terminal failures remain stopped', async t => {
  const f = fixture(t);
  for (const [id, delivered, dueAt] of [['scheduled', true, '2030-01-01T00:00:00Z'], ['due', true, '1970-01-01T00:00:00Z'], ['undelivered', false, undefined]]) {
    const entry = f.seed(id, { report: null, execution: { accepted: false, quiesced: false } }, { ...(dueAt ? { dueAt } : {}) });
    const record = entry.record;
    record.delivery = { resource_model: 'agent-owned-v1', endpoint: `${id}@${record.generation}`, content: 'card', delivered, delivered_at: 0, ...(dueAt ? { dueAt } : {}) };
    // Persist the complete synthetic durable fixture before invoking product code.
    const stateFile = fs.readdirSync(f.state.root).find(name => name.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(f.state.root, name))).task_id === id);
    fs.writeFileSync(path.join(f.state.root, stateFile), JSON.stringify(record));
  }
  f.seed('accepted', { report: null, execution: { accepted: true, quiesced: false } });
  f.seed('quiesced', { report: null, execution: { accepted: false, quiesced: true } });
  f.seed('cancelled', { report: null, execution: { accepted: false, quiesced: false }, cancellation_notice: { outcome: 'accepted' } });
  f.seed('locally-stopped', { report: null }, { handoff_failure: { terminal: true } });
  const dispatcher = f.make(); dispatcher.resume(); await dispatcher.drain();
  assert.equal(f.metrics.deliveries, 2);
  assert.equal(f.metrics.requests, 2);
  assert.equal(f.metrics.spawns, 4);
  assert.equal(f.state.get('scheduled').delivery.delivered_at, 0);
  for (const id of ['due', 'undelivered']) assert.equal(f.state.get(id).delivery.delivered_at, 100_000);
});

test('resume completes frozen legacy abandonment and a handoff failure awaiting its fail report', async t => {
  const f = fixture(t);
  f.seed('legacy-abandonment', { report: null, start_confirmed: false,
    execution: { accepted: false, quiesced: true } }, { preparationRetry: { terminal: true, error: 'preparation unavailable' } });
  const decided = f.seed('handoff-failure', { report: null, execution: { accepted: false, quiesced: true } }, {
    handoff_failure: { fail_reason: 'handoff unavailable', stage: 'deliver', code: 'C4_DELIVERY_UNCONFIRMED', attempts: 3 },
  });
  const dispatcher = f.make(); dispatcher.resume(); await dispatcher.drain();
  for (const id of ['legacy-abandonment', 'handoff-failure']) {
    const report = f.state.get(id).report;
    assert.equal(report.state, 'confirmed', id);
    assert.equal(report.action, 'fail', id);
    assert.equal(report.token_cleanup_pending, false, id);
  }
  assert.equal(JSON.parse(fs.readFileSync(decided.entryFile)).handoff_failure, undefined);
  assert.equal(f.metrics.deliveries, 0);
});

test('resume retains state-read and stale-generation failure bookkeeping before filtering settled records', async t => {
  const f = fixture(t);
  const unreadable = f.seed('unreadable', { report: null });
  const stale = f.seed('stale', {}, { generation: crypto.randomUUID() });
  const get = f.state.get;
  t.mock.method(f.state, 'get', id => { if (id === 'unreadable') throw new Error('cannot read task state'); return get(id); });
  const dispatcher = f.make();
  assert.doesNotThrow(() => dispatcher.resume());
  await dispatcher.drain();
  for (const entry of [unreadable, stale]) {
    const failure = JSON.parse(fs.readFileSync(entry.entryFile)).handoff_failure;
    assert.equal(failure.stage, 'state_read');
    assert.equal(failure.attempts, 1);
  }
  assert.equal(JSON.parse(fs.readFileSync(stale.entryFile)).handoff_failure.code, 'STALE_PREPARATION');
});
