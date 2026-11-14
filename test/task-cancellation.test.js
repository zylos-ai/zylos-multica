import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicTaskWrite, createTaskState } from '../src/lib/task-state.js';
import { CANCELLATION_POLL_MS, createTaskCancellationMonitor } from '../src/lib/task-cancellation.js';
import { buildTaskEndpoint, sessionGroupForEndpoint } from '../src/lib/session-group.js';
import { createTaskDispatcher } from '../src/lib/task-dispatch.js';
import { createBridge } from '../src/index.js';

const config = { base_url: 'https://example.invalid', workspace_id: 'workspace', daemon_id: 'daemon' };
const issueId = '11111111-1111-4111-8111-111111111111';
const chatId = '22222222-2222-4222-8222-222222222222';
const issue = { id: issueId, status: 'in_progress', assignee_type: 'agent', assignee_id: '33333333-3333-4333-8333-333333333333' };

async function fixture(t, { taskFields = {}, baseline = true, legacy = false, dueAt, accepted = true, delivered = true, scheduled } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cancellation-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const task = { id: 'task', workspace_id: config.workspace_id, agent_id: 'mentioned-agent', runtime_id: 'runtime',
    issue_id: issueId, dispatched_at: '2026-11-14T00:00:00.123456Z', ...taskFields };
  const options = { root: path.join(root, 'state'), removeTaskToken() {},
    request: async () => ({ ...task, status: 'running' }) };
  const state = createTaskState(config, options);
  const record = await state.registerClaim(task);
  const endpoint = legacy ? `${task.id}@${record.generation}` : buildTaskEndpoint(task, record.generation);
  await state.setAgentDelivery(task.id, record.generation, { content: 'original card', endpoint, ...(dueAt ? { dueAt } : {}) });
  if (baseline && task.issue_id) await state.captureIssueAssignment(task.id, record.generation, issue);
  await state.start(task.id, record.generation);
  if (delivered) await state.markDelivered(task.id, record.generation, { scheduled });
  if (accepted) await state.markAccepted(task.id, record.generation);
  let clock = 0;
  let taskStatus = 'running';
  let currentIssue = { ...issue };
  const calls = [], notices = [], logs = [];
  const request = async (_config, method, route, body, opts) => {
    calls.push({ method, route, body, opts });
    return route.endsWith('/status') ? { status: taskStatus } : currentIssue;
  };
  const monitorOptions = { state, request, now: () => clock, wallNow: () => 1000,
    deliver: async (content, endpoint) => { notices.push({ content, endpoint }); return true; },
    log: (...args) => logs.push(args) };
  return { root, state, options, task, generation: record.generation, endpoint, calls, notices, logs, monitorOptions,
    makeMonitor: extra => createTaskCancellationMonitor(config, { ...monitorOptions, ...extra }),
    advance: () => { clock += CANCELLATION_POLL_MS; }, status: value => { taskStatus = value; },
    issue: value => { currentIssue = value; } };
}

test('cancelled active task notifies once across repeated polling and restart with the frozen route', async t => {
  const f = await fixture(t);
  f.status('cancelled');
  const monitor = f.makeMonitor();
  await monitor.poll();
  f.advance(); await monitor.poll();
  const restarted = createTaskState(config, f.options);
  await f.makeMonitor({ state: restarted }).poll();
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].endpoint, f.endpoint);
  assert.equal(sessionGroupForEndpoint(f.notices[0].endpoint), `issue-${issueId}`);
  assert.match(f.notices[0].content, /Stop work/);
  assert.match(f.notices[0].content, /Task ID: task/);
  assert.ok(f.notices[0].content.includes(`Issue ID: ${issueId}`));
  assert.equal(restarted.get(f.task.id).cancellation_notice.outcome, 'accepted');
  assert.equal(restarted.get(f.task.id).execution.quiesced, false);
  await assert.rejects(restarted.markAccepted(f.task.id, f.generation), /cancellation notice/);
  await assert.rejects(restarted.start(f.task.id, f.generation), /cancellation notice/);
  assert.equal(restarted.assertCurrent({ taskId: f.task.id, generation: f.generation, requireRunning: true }).task_id, f.task.id);
  await restarted.acknowledgeStopped(f.task.id, f.generation);
  assert.equal(restarted.get(f.task.id).execution.quiesced, true);
});

test('chat and pre-migration cards retain their original scoped or total-session addresses', async t => {
  for (const settings of [{ taskFields: { issue_id: '', chat_session_id: chatId } }, { legacy: true }]) {
    const f = await fixture(t, settings);
    f.status('cancelled'); await f.makeMonitor().poll();
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].endpoint, f.endpoint);
    assert.equal(sessionGroupForEndpoint(f.endpoint), settings.legacy ? '' : `chat-${chatId}`);
  }
});

test('issue cancellation and custom cancelled categories notify even when task remains running', async t => {
  for (const changed of [{ status: 'cancelled' }, { status: 'abandoned', status_category: 'cancelled' }]) {
    const f = await fixture(t);
    f.issue({ ...issue, ...changed }); await f.makeMonitor().poll();
    assert.equal(f.notices.length, 1);
    assert.equal(f.state.get(f.task.id).cancellation_notice.reason, 'issue_cancelled');
  }
});

test('assignment compares original type and id rather than the mentioned executing agent', async t => {
  const f = await fixture(t);
  const monitor = f.makeMonitor();
  await monitor.poll();
  assert.equal(f.notices.length, 0); // Assigned Agent differs from task.agent_id already.
  f.advance(); f.issue({ ...issue, assignee_type: 'member' }); await monitor.poll();
  assert.equal(f.notices.length, 1);
  assert.equal(f.state.get(f.task.id).cancellation_notice.reason, 'issue_reassigned');
  const other = await fixture(t);
  other.issue({ ...issue, assignee_id: '44444444-4444-4444-8444-444444444444' }); await other.makeMonitor().poll();
  assert.equal(other.notices.length, 1);
  const unassigned = await fixture(t);
  unassigned.issue({ ...issue, assignee_type: null, assignee_id: null }); await unassigned.makeMonitor().poll();
  assert.equal(unassigned.notices.length, 1);
});

test('old records establish a baseline on first successful read and detect only subsequent changes', async t => {
  const f = await fixture(t, { baseline: false });
  f.issue({ ...issue, assignee_id: '55555555-5555-4555-8555-555555555555' });
  const monitor = f.makeMonitor(); await monitor.poll();
  assert.equal(f.notices.length, 0);
  assert.equal(f.state.get(f.task.id).issue_assignment.id, '55555555-5555-4555-8555-555555555555');
  // A stale dispatch snapshot must not overwrite the established baseline.
  await f.state.captureIssueAssignment(f.task.id, f.generation, issue);
  f.advance(); f.issue({ ...issue, assignee_id: '66666666-6666-4666-8666-666666666666' }); await monitor.poll();
  assert.equal(f.notices.length, 1);
});

test('stopped, undelivered, other-daemon and frozen-report tasks are not polled', async t => {
  for (const change of [r => { r.execution.quiesced = true; }, r => { r.delivery.delivered = false; },
    r => { r.daemon_id = 'other'; }, r => { r.report = { state: 'pending_unknown' }; },
    r => { r.report = { state: 'confirmed' }; }]) {
    const f = await fixture(t); const record = f.state.get(f.task.id); change(record);
    const file = fs.readdirSync(f.options.root).find(name => name.endsWith('.json'));
    atomicTaskWrite(path.join(f.options.root, file), record);
    f.status('cancelled'); await f.makeMonitor().poll();
    assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 0);
  }
});

test('completed and failed remote tasks skip issue cancellation and reassignment checks', async t => {
  for (const status of ['completed', 'failed']) {
    const f = await fixture(t); f.status(status); f.issue({ ...issue, status: 'cancelled' });
    await f.makeMonitor().poll();
    assert.equal(f.calls.length, 1); assert.equal(f.notices.length, 0);
  }
});

test('query failures and invalid response shapes do not produce cancellation notices', async t => {
  for (const response of [null, {}, { status: 42 }, { status: 'unknown' }]) {
    const f = await fixture(t);
    await f.makeMonitor({ request: async () => response }).poll();
    assert.equal(f.notices.length, 0);
  }
  for (const failedRoute of ['/status', `/api/issues/${issueId}`]) {
    const f = await fixture(t);
    await f.makeMonitor({ request: async (_c, _m, route) => {
      if (route.endsWith(failedRoute)) throw Error('platform unavailable');
      return { status: 'running' };
    } }).poll();
    assert.equal(f.notices.length, 0);
    assert.equal(f.state.get(f.task.id).cancellation_notice, undefined);
  }
  const f = await fixture(t);
  f.issue({ ...issue, id: 'wrong', status: 'cancelled' }); await f.makeMonitor().poll();
  assert.equal(f.notices.length, 0);
  for (const fields of [{ assignee_type: 'unexpected' }, { assignee_id: 'invalid' }, { assignee_id: null }, { assignee_type: null }]) {
    const malformed = await fixture(t); malformed.issue({ ...issue, ...fields }); await malformed.makeMonitor().poll();
    assert.equal(malformed.notices.length, 0);
  }
});

test('poll cadence throttles wakeups and shares each issue read across active tasks', async t => {
  const f = await fixture(t);
  const task = { ...f.task, id: 'second-task' };
  const secondState = createTaskState(config, { ...f.options, request: async () => ({ ...task, status: 'running' }) });
  const record = await secondState.registerClaim(task);
  await secondState.setAgentDelivery(task.id, record.generation, { content: 'second', endpoint: buildTaskEndpoint(task, record.generation) });
  await secondState.start(task.id, record.generation); await secondState.markDelivered(task.id, record.generation);
  const monitor = f.makeMonitor(); await monitor.poll(); await monitor.poll();
  assert.equal(f.calls.filter(call => call.route.endsWith('/status')).length, 2);
  assert.equal(f.calls.filter(call => call.route.includes('/api/issues/')).length, 1);
  assert.ok(f.calls.every(call => call.opts.timeoutMs === 5000));
  f.advance(); await monitor.poll();
  assert.equal(f.calls.filter(call => call.route.endsWith('/status')).length, 4);
  assert.equal(f.calls.filter(call => call.route.includes('/api/issues/')).length, 2);
});

test('future scheduler handoff is skipped until due, while accepted work is checked immediately', async t => {
  for (const [dueAt, accepted, scheduled, expected] of [['2030-01-01T00:00:00Z', false, undefined, 0],
    ['2030-01-01T00:00:00Z', false, true, 0], ['2030-01-01T00:00:00Z', false, false, 1],
    ['1970-01-01T00:00:00Z', false, true, 1], ['2030-01-01T00:00:00Z', true, true, 1]]) {
    const f = await fixture(t, { dueAt, accepted, scheduled }); f.status('cancelled'); await f.makeMonitor().poll();
    assert.equal(f.notices.length, expected); assert.equal(f.calls.length, expected);
  }
});

test('unconfirmed C4 outcomes consume one durable attempt without pretending delivery succeeded', async t => {
  for (const throws of [false, true]) {
    const f = await fixture(t); f.status('cancelled'); let attempts = 0;
    const deliver = async () => { attempts++; if (throws) throw Error('timeout after commit'); return false; };
    await f.makeMonitor({ deliver }).poll();
    await f.makeMonitor({ state: createTaskState(config, f.options), deliver }).poll();
    assert.equal(attempts, 1);
    assert.equal(f.state.get(f.task.id).cancellation_notice.outcome, 'unconfirmed');
    await assert.rejects(f.state.start(f.task.id, f.generation), /cancellation notice/);
    assert.equal(f.logs[0][0], 'WARN');
  }
});

test('reservation write failure sends nothing and stale generations cannot reserve a notice', async t => {
  const f = await fixture(t); let attempts = 0;
  const failing = createTaskState(config, { ...f.options, write(file, value) {
    if (value.cancellation_notice) throw Error('disk full'); atomicTaskWrite(file, value);
  } });
  await assert.rejects(failing.notifyCancellation(f.task.id, f.generation, 'task_cancelled', async () => { attempts++; return true; }), /disk full/);
  assert.equal(attempts, 0);
  assert.equal(f.state.get(f.task.id).cancellation_notice, undefined);
  await assert.rejects(f.state.notifyCancellation(f.task.id, 'stale', 'task_cancelled', async () => { attempts++; }), /stale/);
  assert.equal(attempts, 0);
});

test('concurrent cancellation attempts serialize on the existing task lock', async t => {
  const f = await fixture(t); let attempts = 0;
  await Promise.all([f.state, createTaskState(config, f.options)].map(state =>
    state.notifyCancellation(f.task.id, f.generation, 'task_cancelled', async () => { attempts++; return true; })));
  assert.equal(attempts, 1);
});

test('dispatcher captures issue assignment before delivery and stops redelivering after a notice', async t => {
  const f = await fixture(t, { baseline: false, accepted: false });
  let deliveries = 0;
  const dispatcher = createTaskDispatcher(config, { state: f.state, root: path.join(f.root, 'dispatch'), now: () => Date.now() + 120000,
    snapshot: async () => ({ task: f.task, issue }), render: () => 'card',
    deliver: async () => { deliveries++; assert.equal(f.state.get(f.task.id).issue_assignment.id, issue.assignee_id); return true; } });
  t.after(() => dispatcher.stop());
  await dispatcher.enqueue(f.task); await dispatcher.drain();
  assert.equal(deliveries, 1);
  await f.state.notifyCancellation(f.task.id, f.generation, 'task_cancelled', async () => true);
  dispatcher.resume(); await dispatcher.drain();
  assert.equal(deliveries, 1);
});

test('stop invalidates a held platform read before reserving or delivering a notice', async t => {
  const f = await fixture(t); let release;
  const held = new Promise(resolve => { release = resolve; });
  const monitor = f.makeMonitor({ request: () => held });
  const polling = monitor.poll();
  assert.equal(monitor.poll(), polling);
  monitor.stop(); release({ status: 'cancelled' }); await polling;
  assert.equal(f.notices.length, 0);
  assert.equal(f.state.get(f.task.id).cancellation_notice, undefined);
});

test('scheduler failure records immediate C4 fallback so future work can receive a cancellation notice before admission', async t => {
  const f = await fixture(t, { dueAt: '2030-01-01T00:00:00Z', accepted: false, delivered: false });
  let schedules = 0; let direct = 0;
  const bridge = createBridge({ ...config, runtime: { name: 'Agent' } }, {
    createWakeupChannel: () => ({ start() {}, stop() {} }), createTaskState: () => f.state,
    preparationRoot: path.join(f.root, 'dispatch'), now: () => 1000,
    request: async () => ({ ...issue, due_at: '2030-01-01T00:00:00Z' }),
    storeTaskToken() {}, storeTaskContext: () => ({ index: path.join(f.root, 'index.md') }), storeTaskAttachments() {},
    runScript: async (_script, args) => {
      if (args[0] === 'add') { schedules++; return { ok: false, stderr: 'scheduler unavailable' }; }
      direct++; return { ok: true, stdout: '{"ok":true}', stderr: '' };
    },
  });
  t.after(() => bridge.stop());
  await bridge.handleTask({ ...f.task, start_claim_supported: true, auth_token: 'mat_fixture' });
  for (let i = 0; i < 100 && f.state.get(f.task.id).delivery.scheduled !== false; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(schedules, 1); assert.equal(direct, 1);
  assert.equal(f.state.get(f.task.id).delivery.scheduled, false);
  f.status('cancelled'); await f.makeMonitor().poll(); assert.equal(f.notices.length, 1);
});

test('slow cancellation reads leave claims responsive and stop or config reload invalidates the pending sweep', async t => {
  for (const action of ['stop', 'reload']) {
    const f = await fixture(t); let release; let queries = 0; let claims = 0; let notices = 0;
    const held = new Promise(resolve => { release = resolve; });
    const cfg = { ...config, workspace_slug: 'workspace', poll_interval_s: 15, runtime: { name: 'Agent' } };
    const bridge = createBridge(cfg, {
      createWakeupChannel: () => ({ start() {}, stop() {} }), createTaskState: () => f.state,
      preparationRoot: path.join(f.root, 'dispatch'),
      request: async (_c, _m, route) => {
        if (route.endsWith('/status')) { queries++; return held; }
        if (route.endsWith('/register')) return { runtimes: [{ id: 'runtime', type: 'zylos' }] };
        if (route.endsWith('/claim')) { claims++; return { tasks: [] }; }
        return {};
      },
      runScript: async (_script, args) => {
        if (args[0] !== 'list') { notices++; return { ok: true, stdout: '{"ok":true}', stderr: '' }; }
        return { ok: true, stderr: '', stdout: JSON.stringify([{ id: 'schedule', type: 'one-time', status: 'failed', last_error: '',
          reply_channel: 'multica', reply_endpoint: f.endpoint, next_run_at: 1 }]) };
      },
    });
    t.after(async () => { bridge.stop(); release({ status: 'cancelled' }); await bridge.drainCancellationChecks(); });
    // Existing accepted-task scheduler reconciliation initializes the same state
    // factory without starting any dispatch jobs or touching the real scheduler.
    await bridge.reconcileScheduledTasks();
    await bridge.tick(); await bridge.tick();
    assert.equal(claims, 2); assert.equal(queries, 1);
    if (action === 'reload') bridge.updateConfig({ ...cfg, pat: 'replacement' });
    else bridge.stop();
    release({ status: 'cancelled' }); await bridge.drainCancellationChecks();
    assert.equal(notices, 0);
    assert.equal(f.state.get(f.task.id).cancellation_notice, undefined);
  }
});
