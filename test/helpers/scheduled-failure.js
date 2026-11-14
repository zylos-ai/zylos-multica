import assert from 'node:assert/strict';
import path from 'node:path';
import { mock } from 'node:test';
import { createTaskDispatcher } from '../../src/lib/task-dispatch.js';
import { createTaskState } from '../../src/lib/task-state.js';

const seen = [];
mock.module('../../src/lib/task-dispatch.js', { namedExports: {
  createTaskDispatcher(...args) {
    const dispatcher = createTaskDispatcher(...args);
    const failScheduled = dispatcher.failScheduled;
    dispatcher.failScheduled = (endpoint, error) => {
      seen.push(endpoint);
      return failScheduled(endpoint, error);
    };
    return dispatcher;
  },
} });
const { createBridge } = await import('../../src/index.js');
const config = { base_url: 'https://fixture.invalid', workspace_id: 'workspace', daemon_id: 'daemon' };
const task = { id: 'scheduled-task', issue_id: '11111111-1111-4111-8111-111111111111',
  agent_id: 'agent', runtime_id: 'runtime', workspace_id: 'workspace', dispatched_at: '2026-01-01T00:00:00Z' };
const calls = [];
const request = async (_config, method, route, body) => {
  calls.push({ method, route, body });
  if (route.endsWith('/start')) return { ...task, status: 'running' };
  assert.equal(route, '/api/daemon/tasks/scheduled-task/fail');
  assert.equal(method, 'POST');
  return { ...task, status: 'failed', error: body.error, failure_reason: body.failure_reason };
};
const state = createTaskState(config, { root: path.join(process.env.ZYLOS_DIR, 'state'), request, removeTaskToken() {} });
const { generation } = await state.registerClaim(task);
const endpoint = `${task.id}@${generation}|issue:${task.issue_id}`;
await state.setAgentDelivery(task.id, generation, { content: 'scheduled fixture', endpoint, dueAt: '2030-01-01T00:00:00Z' });
await state.start(task.id, generation);
const bridge = createBridge(config, {
  request, createTaskState: () => state,
  preparationRoot: path.join(process.env.ZYLOS_DIR, 'preparations'),
  createWakeupChannel: () => ({ start() {}, stop() {} }),
  runScript: async (_script, args) => {
    assert.deepEqual(args, ['list', '--json', '--reply-channel', 'multica']);
    return { ok: true, stderr: '', stdout: JSON.stringify([{ id: 'schedule', type: 'one-time', status: 'failed',
      last_error: 'Missed execution window', reply_channel: 'multica', reply_endpoint: endpoint, next_run_at: 10 }]) };
  },
});
try {
  await bridge.reconcileScheduledTasks();
  assert.deepEqual(seen, [endpoint]);
  const failed = calls.filter(call => call.route.endsWith('/fail'));
  assert.equal(failed.length, 1);
  assert.equal(failed[0].body.failure_reason, 'runtime_offline');
  assert.equal(failed[0].body.error, 'scheduler handoff failed: Missed execution window');
  const record = state.get(task.id);
  assert.equal(record.delivery.endpoint, endpoint);
  assert.equal(record.report.state, 'confirmed');
  assert.equal(record.execution.quiesced, true);
  console.log('full endpoint and runtime_offline confirmed');
} finally {
  bridge.stop();
}
