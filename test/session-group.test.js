import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildTaskEndpoint, parseTaskEndpoint, sessionGroupForEndpoint, isValidSessionGroup } from '../src/lib/session-group.js';
const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const issue = '11111111-1111-4111-8111-111111111111';
const chat = '22222222-2222-4222-8222-222222222222';
const cli = endpoint => spawnSync(process.execPath, ['scripts/session-group.js', endpoint], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
for (const [endpoint, group] of [
  [`task@${generation}|issue:${issue}`, `issue-${issue}`],
  [`task@${generation}|chat:${chat}`, `chat-${chat}`],
  [`task|chat:${chat}`, `chat-${chat}`],
  [`task@${generation}`, ''], ['task', ''],
]) test(`session group is deterministic for ${endpoint}`, () => {
  assert.equal(sessionGroupForEndpoint(endpoint), group);
  if (group) assert.equal(isValidSessionGroup(group), true);
  const result = cli(endpoint);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, group);
});
for (const endpoint of ['', '../task', 'task@bad', `task@${generation}|issue:bad`, `task@${generation}|unknown:${issue}`, `task@${generation}|issue:${issue}|chat:${chat}`, `task@${generation}|chat:${chat}\n`, '|issue:' + issue]) {
  test(`unrecognized endpoint fails closed: ${JSON.stringify(endpoint)}`, () => {
    assert.throws(() => sessionGroupForEndpoint(endpoint));
    const result = cli(endpoint);
    // A known-bad resolver that returns the total-session empty string must fail this assertion.
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  });
}
test('builder gives issue precedence and retains task/generation identity', () => {
  const endpoint = buildTaskEndpoint({ id: 'task', issue_id: issue, chat_session_id: chat }, generation);
  assert.equal(endpoint, `task@${generation}|issue:${issue}`);
  assert.deepEqual(parseTaskEndpoint(endpoint), { taskId: 'task', generation, routeType: 'issue', routeId: issue });
  assert.equal(buildTaskEndpoint({ id: 'next-task', issue_id: issue }, generation).split('|')[1], endpoint.split('|')[1]);
  assert.throws(() => buildTaskEndpoint({ id: 'task', issue_id: 'bad' }, generation));
  assert.throws(() => parseTaskEndpoint(`task|chat:${chat}`));
  assert.equal(parseTaskEndpoint(`task|chat:${chat}`, { allowLegacy: true }).taskId, 'task');
});
test('explicit historical endpoints remain in their total session without a state lookup', () => {
  const endpoint = `task@${generation}`;
  assert.equal(buildTaskEndpoint({ id: 'task', issue_id: issue, execution_endpoint: endpoint }, generation), endpoint);
  assert.throws(() => buildTaskEndpoint({ id: 'other', execution_endpoint: endpoint }, generation));
  assert.equal(sessionGroupForEndpoint(endpoint), '');
});
test('Core session group grammar rejects unsafe or oversized groups', () => {
  for (const group of ['', '-bad', 'with space', 'a'.repeat(96)]) assert.equal(isValidSessionGroup(group), false);
});
