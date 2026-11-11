// zylos-multica #56: handoff failures are logged with stage and a redacted
// reason, retried within a persisted bound, then terminated exactly once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicTaskWrite, createTaskState } from '../src/lib/task-state.js';
import { createTaskDispatcher, HANDOFF_FAILURE_MIN_ATTEMPTS, HANDOFF_FAILURE_MIN_MS, isExplicitRejection } from '../src/lib/task-dispatch.js';

const PAT = 'mul_component_pat_SECRET_1234';
const CLAIM = 'mat_claim_token_SECRET_5678';
const CLAIM_RAW = 'claim-raw-secret-without-prefix';
const task = { id: 'task', agent_id: 'agent', runtime_id: 'runtime', workspace_id: 'workspace', issue_id: 'issue', dispatched_at: '2026-10-15T01:02:03.123456Z' };
const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon', pat: PAT };

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-handoff-'));
  const events = [];
  const calls = [];
  const logs = [];
  let clock = Date.parse('2026-10-15T01:03:00Z');
  const now = () => clock;
  const request = async (_c, _method, route, body) => {
    const kind = route.split('/').at(-1);
    events.push(kind); calls.push({ route, body });
    if (overrides.request) {
      const value = await overrides.request(kind, body);
      if (value !== undefined) return value;
    }
    if (kind === 'fail') return { ...task, status: 'failed', ...body };
    return { ...task, status: kind === 'start' ? 'running' : 'dispatched' };
  };
  // Real atomic writes; a test may make the state disk fail first.
  const write = (file, value) => { overrides.write?.(file); atomicTaskWrite(file, value); };
  const state = createTaskState(config, { root: path.join(root, 'state'), request, now, write, removeTaskToken() {} });
  const deps = {
    state, request, root: path.join(root, 'dispatch'), now,
    log: (level, message, extra) => logs.push({ level, message, extra }),
    taskSecret: () => CLAIM_RAW,
    snapshot: async value => { if (overrides.snapshot) return overrides.snapshot(); return { task: { id: value.id }, context: { index: '/fixture/context' } }; },
    render: async () => { events.push('render'); return overrides.render ? overrides.render() : 'fixed card'; },
    deliver: async () => { events.push('deliver'); return overrides.deliver ? overrides.deliver() : true; },
  };
  const make = () => createTaskDispatcher(config, deps);
  const entryFile = () => fs.readdirSync(deps.root).map(name => path.join(deps.root, name)).find(name => name.endsWith('.json'));
  return {
    make, state, events, calls, logs, root,
    advance(ms) { clock += ms; },
    entry: () => JSON.parse(fs.readFileSync(entryFile(), 'utf8')),
    count: kind => events.filter(e => e === kind).length,
    async tick(d) { d.resume(); await d.drain(); },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const secretsIn = text => [PAT, CLAIM, CLAIM_RAW, 'SECRET', 'Bearer abc', 'card-argv-body'].filter(secret => text.includes(secret));

test('every handoff stage logs its stage, code and a redacted reason once, without secrets or argv', async t => {
  const leak = `PAT ${PAT} claim ${CLAIM} raw ${CLAIM_RAW} header Bearer abc.def`;
  const card = 'card-argv-body '.repeat(50);
  const cases = [
    { stage: 'render', code: 'ERROR', render: () => { throw Error(`render broke: ${leak}`); } },
    // A NUL is rejected by setAgentDelivery: a real state-write failure.
    { stage: 'state_write', code: 'ERROR', render: () => 'card\0with nul' },
    { stage: 'start', code: 'HTTP_409', request: kind => { if (kind === 'start') throw Object.assign(Error(`POST start -> HTTP 409: ${leak}`), { status: 409 }); } },
    { stage: 'deliver', code: 'EXIT_1', deliver: () => {
      const cmd = `node /c4-receive.js --content ${card}`;
      throw Object.assign(Error(`Command failed: ${cmd}\n${leak}`), { code: 1, cmd });
    } },
    { stage: 'deliver', code: 'C4_DELIVERY_UNCONFIRMED', deliver: () => false },
    { stage: 'mark_delivered', code: 'ERROR', markDelivered: () => { throw Error(`lock failed ${leak}`); } },
  ];
  for (const item of cases) {
    const f = fixture(item); t.after(f.cleanup);
    if (item.markDelivered) f.state.markDelivered = async () => item.markDelivered();
    const d = f.make();
    await d.enqueue(task); await d.drain();
    for (let i = 0; i < 3; i++) { f.advance(30_000); await f.tick(d); }
    const warns = f.logs.filter(l => l.message === 'task handoff deferred');
    assert.equal(warns.length, 1, `${item.stage}: one WARN for 4 identical failures`);
    assert.equal(warns[0].level, 'WARN');
    assert.equal(warns[0].extra.stage, item.stage);
    assert.equal(warns[0].extra.code, item.code);
    assert.equal(warns[0].extra.task_id, task.id);
    assert.ok(warns[0].extra.error.length > 0 && warns[0].extra.error.length <= 200);
    const logged = JSON.stringify(f.logs);
    assert.deepEqual(secretsIn(logged), [], `${item.stage}: ${logged}`);
    assert.doesNotMatch(logged, /c4-receive\.js --content/);
    assert.deepEqual(f.entry().handoff_failure.attempts, 4);
    assert.equal(f.state.get(task.id).report, null);
  }
});

test('the redacted reason keeps the useful part of the error', async t => {
  const f = fixture({ deliver: () => { throw Object.assign(Error('spawn E2BIG'), { code: 'E2BIG', errno: -7, syscall: 'spawn' }); } });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  assert.deepEqual(f.logs[0], { level: 'WARN', message: 'task handoff deferred', extra: { task_id: task.id, stage: 'deliver', code: 'E2BIG', error: 'spawn E2BIG', attempts: 1 } });
});

test('a stage or code change logs again; repeats of the same failure stay silent', async t => {
  let mode = 'exit';
  const f = fixture({ deliver: () => {
    if (mode === 'exit') throw Object.assign(Error('c4 exited'), { code: 1 });
    return false;
  } });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  for (let i = 0; i < 4; i++) { f.advance(10_000); await f.tick(d); }
  mode = 'false';
  for (let i = 0; i < 4; i++) { f.advance(10_000); await f.tick(d); }
  assert.deepEqual(f.logs.map(l => [l.level, l.extra.code, l.extra.attempts]), [['WARN', 'EXIT_1', 1], ['WARN', 'C4_DELIVERY_UNCONFIRMED', 6]]);
});

test('retry bound needs BOTH the minimum attempts and the minimum duration', async t => {
  assert.equal(HANDOFF_FAILURE_MIN_ATTEMPTS, 3);
  assert.equal(HANDOFF_FAILURE_MIN_MS, 600_000);
  // Many fast attempts inside 10 minutes do not terminate.
  const fast = fixture({ deliver: () => false }); t.after(fast.cleanup);
  let d = fast.make(); await d.enqueue(task); await d.drain();
  for (let i = 0; i < 20; i++) { fast.advance(29_000); await fast.tick(d); }
  assert.equal(fast.entry().handoff_failure.attempts, 21);
  assert.equal(fast.state.get(task.id).report, null);
  assert.equal(fast.calls.some(c => c.route.endsWith('/fail')), false);
  // A long outage with only two attempts does not terminate either.
  const slow = fixture({ deliver: () => false }); t.after(slow.cleanup);
  d = slow.make(); await d.enqueue(task); await d.drain();
  slow.advance(3_600_000); await slow.tick(d);
  assert.equal(slow.entry().handoff_failure.attempts, 2);
  assert.equal(slow.calls.some(c => c.route.endsWith('/fail')), false);
  slow.advance(1); await slow.tick(d);
  assert.equal(slow.calls.filter(c => c.route.endsWith('/fail')).length, 1);
});

test('frozen card + confirmed start: bounded deliver failure quiesces and reports environment_prepare_failed once', async t => {
  const f = fixture({ deliver: () => { throw Object.assign(Error('spawn E2BIG'), { code: 'E2BIG' }); } });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  f.advance(300_000); await f.tick(d);
  f.advance(300_000); await f.tick(d); // attempt 3 at exactly 10 minutes
  const fails = f.calls.filter(c => c.route.endsWith('/fail'));
  assert.deepEqual(fails, [{ route: '/api/daemon/tasks/task/fail', body: { error: 'task handoff failed at deliver: E2BIG (3 attempts)', failure_reason: 'environment_prepare_failed' } }]);
  const record = f.state.get(task.id);
  assert.equal(record.execution.quiesced, true);
  assert.equal(record.report.state, 'confirmed');
  const errors = f.logs.filter(l => l.level === 'ERROR');
  assert.deepEqual(errors.map(l => [l.message, l.extra.stage, l.extra.code, l.extra.outcome, l.extra.attempts]),
    [['task handoff failed permanently', 'deliver', 'E2BIG', 'reported_fail', 3]]);
  // Afterwards: no more start/deliver attempts, no more logs.
  const before = { start: f.count('start'), deliver: f.count('deliver'), logs: f.logs.length };
  for (let i = 0; i < 5; i++) { f.advance(600_000); await f.tick(d); }
  assert.deepEqual({ start: f.count('start'), deliver: f.count('deliver'), logs: f.logs.length }, before);
  assert.equal(f.calls.filter(c => c.route.endsWith('/fail')).length, 1);
  assert.equal(f.entry().handoff_failure, undefined, 'report path took over; failure record cleared');
});

test('no frozen card: bounded render failure ends through the prestart abandonment path', async t => {
  const f = fixture({ render: () => { throw Error(`template broke ${CLAIM}`); } });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  f.advance(300_000); await f.tick(d);
  f.advance(300_000); await f.tick(d);
  const record = f.state.get(task.id);
  assert.equal(record.preparation_failure.reason, 'task handoff failed at render: ERROR (3 attempts)');
  assert.equal(record.delivery, undefined);
  assert.equal(record.report.state, 'confirmed');
  assert.deepEqual(f.calls.filter(c => c.route.endsWith('/fail')).map(c => c.body),
    [{ error: 'task handoff failed at render: ERROR (3 attempts)', failure_reason: 'environment_prepare_failed' }]);
  assert.equal(f.count('deliver'), 0);
  assert.equal(f.logs.filter(l => l.level === 'ERROR').length, 1);
  assert.deepEqual(secretsIn(JSON.stringify(f.logs)), []);
  const renders = f.count('render');
  for (let i = 0; i < 3; i++) { f.advance(600_000); await f.tick(d); }
  assert.equal(f.count('render'), renders);
});

test('start never confirmed: bounded start failure stops locally with one ERROR and no platform write', async t => {
  const f = fixture({ request: kind => { if (kind === 'start') throw Object.assign(Error(`POST start -> HTTP 409: task is not dispatched; Bearer ${PAT}`), { status: 409 }); } });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  f.advance(300_000); await f.tick(d);
  f.advance(300_000); await f.tick(d);
  const record = f.state.get(task.id);
  assert.equal(record.start_confirmed, false);
  assert.equal(record.execution.quiesced, true, 'begin() is fenced');
  assert.equal(record.report, null);
  assert.equal(f.calls.some(c => !c.route.endsWith('/start')), false, 'only start requests were made');
  assert.equal(f.entry().handoff_failure.terminal, true);
  const errors = f.logs.filter(l => l.level === 'ERROR');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].extra.outcome, 'stopped_locally');
  assert.equal(errors[0].extra.stage, 'start');
  assert.equal(errors[0].extra.code, 'HTTP_409');
  assert.equal(errors[0].extra.terminal_error, undefined, 'stopped by design, not because a report attempt failed');
  assert.deepEqual(secretsIn(JSON.stringify(f.logs)), []);
  const starts = f.count('start');
  const logs = f.logs.length;
  for (let i = 0; i < 5; i++) { f.advance(600_000); await f.tick(d); }
  const resumed = f.make(); await f.tick(resumed); // restart keeps the stop
  assert.equal(f.count('start'), starts);
  assert.equal(f.logs.length, logs);
  await assert.rejects(f.state.markAccepted(task.id, record.generation), /task start is not confirmed|quiesced/);
});

const httpError = status => Object.assign(Error(`POST /start -> HTTP ${status}`), { status });

test('only an explicit rejection counts as refused', () => {
  for (const status of [400, 401, 403, 404, 409, 410, 422]) assert.equal(isExplicitRejection(httpError(status)), true, String(status));
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(isExplicitRejection(httpError(status)), false, String(status));
  assert.equal(isExplicitRejection(Object.assign(Error('start response did not confirm original claim'), { code: 'START_NOT_CONFIRMED' })), true);
  for (const error of [Error('fetch failed'), Object.assign(Error('aborted'), { name: 'TimeoutError' }), Object.assign(Error('x'), { code: 'ECONNRESET' }), undefined]) {
    assert.equal(isExplicitRejection(error), false);
  }
});

test('start answered for another state stops locally like a rejection', async t => {
  const f = fixture({ request: kind => (kind === 'start' ? { ...task, status: 'cancelled' } : undefined) });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  f.advance(300_000); await f.tick(d);
  f.advance(300_000); await f.tick(d);
  const errors = f.logs.filter(l => l.level === 'ERROR');
  assert.deepEqual(errors.map(l => [l.extra.stage, l.extra.code, l.extra.outcome]), [['start', 'START_NOT_CONFIRMED', 'stopped_locally']]);
  assert.equal(f.calls.some(c => !c.route.endsWith('/start')), false);
});

test('a transient start failure past the bound keeps retrying and the card is delivered once start recovers', async t => {
  let failing = true;
  const f = fixture({ request: kind => { if (kind === 'start' && failing) throw httpError(503); } });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  for (let i = 0; i < 3; i++) { f.advance(300_000); await f.tick(d); } // 15 minutes, 4 attempts
  assert.equal(f.entry().handoff_failure.attempts, 4);
  assert.equal(f.entry().handoff_failure.terminal, undefined);
  assert.equal(f.state.get(task.id).execution.quiesced, false);
  failing = false;
  f.advance(300_000); await f.tick(d);
  const record = f.state.get(task.id);
  assert.equal(record.delivery.delivered, true);
  assert.equal(record.report, null);
  assert.equal(f.count('deliver'), 1);
  assert.equal(f.entry().handoff_failure, undefined);
  assert.deepEqual(f.logs.map(l => [l.level, l.extra.stage, l.extra.code]), [['WARN', 'start', 'HTTP_503']]);
});

test('a transient failure of the terminal path keeps retrying; a rejection there stops locally', async t => {
  // Card frozen and start confirmed; the fail report itself fails with a plain (transient) error.
  const transient = fixture({ deliver: () => false }); t.after(transient.cleanup);
  let reportFailures = 0;
  const report = transient.state.report.bind(transient.state);
  transient.state.report = async (...args) => {
    if (reportFailures < 3) { reportFailures += 1; throw Error(`report lock failed ${CLAIM}`); }
    return report(...args);
  };
  let d = transient.make(); await d.enqueue(task); await d.drain();
  transient.advance(300_000); await transient.tick(d);
  transient.advance(300_000); await transient.tick(d); // bound: quiesced, report throws
  assert.equal(transient.state.get(task.id).execution.quiesced, true);
  assert.equal(transient.entry().handoff_failure.fail_reason, 'task handoff failed at deliver: C4_DELIVERY_UNCONFIRMED (3 attempts)');
  assert.equal(transient.logs.filter(l => l.level === 'ERROR').length, 0);
  transient.advance(300_000); await transient.tick(d); // step and bound both retry the report: 2 more failures
  assert.equal(reportFailures, 3);
  assert.equal(transient.entry().handoff_failure.terminal, undefined);
  d = transient.make(); transient.advance(300_000); await transient.tick(d); // after a restart the report gets through
  assert.deepEqual(transient.calls.filter(c => c.route.endsWith('/fail')).map(c => c.body),
    [{ error: 'task handoff failed at deliver: C4_DELIVERY_UNCONFIRMED (3 attempts)', failure_reason: 'environment_prepare_failed' }]);
  assert.equal(transient.state.get(task.id).report.state, 'confirmed');
  const errors = transient.logs.filter(l => l.level === 'ERROR');
  assert.deepEqual(errors.map(l => [l.message, l.extra.outcome]), [['task handoff failed permanently', 'reported_fail']]);
  assert.equal(transient.entry().handoff_failure, undefined);
  const deliveries = transient.count('deliver');
  for (let i = 0; i < 3; i++) { transient.advance(600_000); await transient.tick(d); }
  assert.equal(transient.count('deliver'), deliveries);
  assert.deepEqual(secretsIn(JSON.stringify(transient.logs)), []);
  // No frozen card: the bound starts the prestart abandonment, whose start Multica refuses.
  let renders = 0;
  const rejected = fixture({
    render: () => { renders += 1; throw Error('template broke'); },
    request: kind => { if (kind === 'start') throw httpError(409); },
  });
  t.after(rejected.cleanup);
  d = rejected.make(); await d.enqueue(task); await d.drain();
  rejected.advance(300_000); await rejected.tick(d);
  rejected.advance(300_000); await rejected.tick(d);
  const error = rejected.logs.find(l => l.level === 'ERROR');
  assert.equal(error.extra.outcome, 'stopped_locally');
  assert.equal(error.extra.terminal_error.code, 'HTTP_409');
  const record = rejected.state.get(task.id);
  assert.equal(record.preparation_failure.reason, 'task handoff failed at render: ERROR (3 attempts)');
  assert.equal(record.report, null);
  assert.equal(rejected.entry().handoff_failure.terminal, true);
  const starts = rejected.count('start');
  for (let i = 0; i < 3; i++) { rejected.advance(600_000); await rejected.tick(d); }
  assert.equal(rejected.count('start'), starts);
  assert.equal(renders, 3);
});

test('a local reconcile error on a pending fail report keeps retrying and reconciles once it recovers', async t => {
  const REASON = 'task handoff failed at deliver: E2BIG (3 attempts)';
  let diskDown = false;
  let failPosts = 0;
  let remote = null;
  const f = fixture({
    deliver: () => { throw Object.assign(Error('spawn E2BIG'), { code: 'E2BIG' }); },
    // The first fail POST gets no answer and the history has no row yet, so the report stays pending_unknown.
    request: kind => {
      if (kind === 'fail' && ++failPosts === 1) throw Error('socket hang up');
      if (kind === 'task-runs') return remote ? [remote] : [];
    },
    write: () => { if (diskDown) throw Object.assign(Error(`EIO: i/o error, write ${CLAIM}`), { code: 'EIO' }); },
  });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  f.advance(300_000); await f.tick(d);
  f.advance(300_000); await f.tick(d); // bound: quiesced, fail POST uncertain
  assert.equal(f.state.get(task.id).report.state, 'pending_unknown');
  assert.deepEqual(f.logs.filter(l => l.level === 'ERROR').map(l => l.extra.outcome), ['fail_report_pending']);
  // The state disk fails for 15 minutes; every reconcile throws EIO.
  diskDown = true;
  for (let i = 0; i < 3; i++) { f.advance(300_000); await f.tick(d); }
  diskDown = false;
  assert.equal(f.entry().handoff_failure.terminal, undefined, 'never stopped locally');
  assert.equal(f.entry().handoff_failure.stage, 'reconcile');
  assert.equal(f.entry().handoff_failure.attempts, 6);
  // Multica recorded the fail; the next reconcile reads it back.
  remote = { ...task, status: 'failed', error: REASON, failure_reason: 'environment_prepare_failed' };
  f.advance(300_000); await f.tick(d);
  assert.equal(f.state.get(task.id).report.state, 'confirmed');
  assert.equal(f.entry().handoff_failure, undefined);
  assert.equal(failPosts, 1, 'a fail POST with an unknown outcome is never blindly repeated');
  assert.deepEqual(f.logs.filter(l => l.level === 'ERROR').map(l => l.extra.outcome), ['fail_report_pending']);
  const reconcileWarns = f.logs.filter(l => l.level === 'WARN' && l.extra.stage === 'reconcile');
  assert.deepEqual(reconcileWarns.map(l => [l.extra.code, l.extra.attempts]), [['EIO', 4]]);
  assert.deepEqual(secretsIn(JSON.stringify(f.logs)), []);
});

// The #42 prestart termination (here from a context snapshot failure) retries
// its claim-confirming start on every tick, so it reaches the same bound.
const snapshotFailure = { snapshot: () => { throw Error('issue context unavailable'); } };
const SNAPSHOT_REASON = 'preparation failed: task context materialization failed; inspect retained task context';

test('prestart termination refused at the bound stops locally, keeps its frozen reason, and never starts again', async t => {
  const f = fixture({ ...snapshotFailure, request: kind => { if (kind === 'start') throw httpError(409); } });
  t.after(f.cleanup);
  let d = f.make(); await d.enqueue(task); await d.drain();
  f.advance(300_000); await f.tick(d);
  assert.equal(f.logs.filter(l => l.level === 'ERROR').length, 0);
  f.advance(300_000); await f.tick(d);
  const record = f.state.get(task.id);
  assert.equal(record.preparation_failure.reason, SNAPSHOT_REASON);
  assert.equal(record.report, null);
  assert.equal(f.calls.some(c => !c.route.endsWith('/start')), false);
  const errors = f.logs.filter(l => l.level === 'ERROR');
  assert.deepEqual(errors.map(l => [l.extra.stage, l.extra.code, l.extra.outcome, l.extra.terminal_error]), [['abandon', 'HTTP_409', 'stopped_locally', undefined]]);
  assert.equal(f.entry().handoff_failure.terminal, true);
  const starts = f.count('start');
  assert.equal(starts, 3);
  for (let i = 0; i < 5; i++) { f.advance(600_000); await f.tick(d); }
  d = f.make(); await f.tick(d); // restart
  await f.tick(d);
  assert.equal(f.count('start'), starts, 'no /start after the local stop, also after a restart');
  assert.equal(f.entry().handoff_failure.terminal, true);
  assert.equal(f.logs.length, 1 + errors.length + 1, 'snapshot WARN, deferred WARN, one ERROR');
});

test('prestart termination with a transient start failure keeps retrying and reports its frozen reason once start recovers', async t => {
  let failing = true;
  const f = fixture({ ...snapshotFailure, request: kind => { if (kind === 'start' && failing) throw httpError(503); } });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  for (let i = 0; i < 3; i++) { f.advance(300_000); await f.tick(d); }
  assert.equal(f.entry().handoff_failure.terminal, undefined);
  assert.equal(f.logs.filter(l => l.level === 'ERROR').length, 0);
  failing = false;
  f.advance(300_000); await f.tick(d);
  assert.deepEqual(f.calls.filter(c => c.route.endsWith('/fail')).map(c => c.body), [{ error: SNAPSHOT_REASON, failure_reason: 'environment_prepare_failed' }]);
  assert.equal(f.state.get(task.id).report.state, 'confirmed');
  assert.equal(f.entry().handoff_failure, undefined);
});

test('a task admitted by the agent is never failed by the bound', async t => {
  const f = fixture({ deliver: () => false }); t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task); await d.drain();
  f.advance(300_000); await f.tick(d);
  const quiesceUnaccepted = f.state.quiesceUnaccepted.bind(f.state);
  f.state.quiesceUnaccepted = async (taskId, generation) => {
    await f.state.markAccepted(taskId, generation); // begin() wins the race
    return quiesceUnaccepted(taskId, generation);
  };
  f.advance(300_000); await f.tick(d);
  assert.equal(f.logs.find(l => l.level === 'ERROR').extra.outcome, 'left_to_agent');
  assert.equal(f.calls.some(c => c.route.endsWith('/fail')), false);
  assert.equal(f.state.get(task.id).execution.quiesced, false);
  f.advance(60_000); await f.tick(d);
  assert.equal(f.entry().handoff_failure, undefined, 'admitted task clears the failure record');
});

test('failure count and first-failure time survive a daemon restart; a success resets them', async t => {
  let failing = true;
  const f = fixture({ deliver: () => !failing }); t.after(f.cleanup);
  let d = f.make(); await d.enqueue(task); await d.drain();
  const first = f.entry().handoff_failure;
  f.advance(120_000); d = f.make(); await f.tick(d);
  assert.deepEqual(f.entry().handoff_failure, { ...first, attempts: 2, last_at: first.last_at + 120_000 });
  failing = false;
  f.advance(1_000); d = f.make(); await f.tick(d);
  assert.equal(f.entry().handoff_failure, undefined);
  assert.equal(f.state.get(task.id).delivery.delivered, true);
  assert.equal(f.logs.filter(l => l.level === 'ERROR').length, 0);
});

test('shutdown abort is not counted as a handoff failure', async t => {
  let release;
  const f = fixture({ render: () => new Promise(resolve => { release = () => resolve('card'); }) });
  t.after(f.cleanup);
  const d = f.make(); await d.enqueue(task);
  await new Promise(resolve => setImmediate(resolve));
  d.stop(); release(); await d.drain();
  assert.equal(f.entry().handoff_failure, undefined);
  assert.equal(f.logs.length, 0);
});

test('snapshot failure logs a redacted reason, then terminates as before', async t => {
  const f = fixture(); t.after(f.cleanup);
  const d = createTaskDispatcher(config, {
    state: f.state, root: path.join(f.root, 'dispatch'), log: (level, message, extra) => f.logs.push({ level, message, extra }),
    snapshot: async () => { throw Error(`issue fetch 500 for token ${CLAIM_RAW} / ${CLAIM}`); },
  });
  await d.enqueue({ ...task, auth_token: CLAIM_RAW }); await d.drain();
  assert.deepEqual(f.logs[0], { level: 'WARN', message: 'task context snapshot failed; abandoning preparation',
    extra: { task_id: task.id, code: 'ERROR', error: 'issue fetch 500 for token [REDACTED] / mat_[REDACTED]' } });
  assert.equal(f.state.get(task.id).report.state, 'confirmed');
});
