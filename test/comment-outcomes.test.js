import assert from 'node:assert/strict';
import test from 'node:test';
import { runBusinessCLI } from '../src/lib/business-cli.js';

async function addComment(receipt, output = 'table') {
  const calls = [];
  let text = '';
  const result = await runBusinessCLI({ workspace_id: 'workspace', pat: 'owner' }, [
    'issue', 'comment', 'add', 'MUL-1', '--task', 'task', '--parent', 'parent',
    '--content', 'Update', '--output', output,
  ], {
    stdout: { write: (chunk) => { text += chunk; } },
    ensureWorkspaceResolved: async () => {},
    loadTaskToken: () => 'task-token',
    request: async (config, method, path, body) => {
      calls.push({ config, method, path, body });
      return method === 'POST' ? receipt : { id: 'issue' };
    },
  });
  const writes = calls.filter(({ method }) => method === 'POST');
  assert.equal(writes.length, 1, 'saved comments must never be retried for admission outcomes');
  assert.equal(writes[0].config.pat, 'task-token');
  assert.deepEqual(writes[0].body, { content: 'Update', parent_id: 'parent' });
  assert.strictEqual(result, receipt);
  return text;
}

test('saved comment separates every target admission result from write success', async () => {
  const outcomes = ['queued', 'coalesced', 'deferred', 'steered', 'blocked'].map((status, i) => ({
    target_type: i % 2 ? 'squad' : 'agent', target_id: `target-${i}`, status,
    reason_code: status === 'blocked' ? 'runtime_offline' : status,
  }));
  const text = await addComment({ id: 'comment', trigger_outcomes: outcomes });
  assert.match(text, /^Comment saved\./);
  assert.match(text, /not all implicit triggers/);
  for (const outcome of outcomes) {
    assert.ok(text.includes(`target_id=${outcome.target_id}\tstatus=${outcome.status}\treason_code=${outcome.reason_code}`));
  }
  assert.match(text, /new task queued; execution not completed/);
  assert.match(text, /existing pending run/);
  assert.match(text, /admitted but not started/);
  assert.match(text, /delivery not verified/);
  assert.match(text, /trigger refused; comment remains saved; do not retry the comment/);
  assert.doesNotMatch(text, /\[object Object\]/);
});

test('missing, empty and malformed receipts remain unknown instead of negative or successful triggers', async () => {
  for (const receipt of [{ id: 'comment' }, { trigger_outcomes: [] }, { trigger_outcomes: null }, { trigger_outcomes: {} }]) {
    assert.match(await addComment(receipt), /whether a target was triggered is unknown/);
  }
  const text = await addComment({ trigger_outcomes: [null, {}, {
    target_type: 'squad', target_id: 'future-target', status: 'future-status', reason_code: 'future-reason',
  }] });
  assert.match(text, /status=\(not reported\)/);
  assert.match(text, /future-target\tstatus=future-status\treason_code=future-reason/);
  assert.match(text, /unknown trigger outcome; no success or failure inferred/);
});

test('JSON remains the complete original receipt and unknown reasons remain visible', async () => {
  const receipt = { id: 'comment', extension: { preserved: true }, trigger_outcomes: [{
    target_type: 'agent', target_id: 'agent', status: 'blocked', reason_code: 'new_reason', extra: 7,
  }] };
  assert.equal(await addComment(receipt, 'json'), `${JSON.stringify(receipt, null, 2)}\n`);
  assert.match(await addComment(receipt), /reason_code=new_reason/);
});

test('remote trigger fields cannot inject terminal controls or forge table rows', async () => {
  const text = await addComment({ trigger_outcomes: [{
    target_type: 'agent', target_id: 'evil\nID', status: 'blocked', reason_code: '\x1b[31m\tbad',
  }] });
  assert.ok(text.includes('target_id=evil\\nID'));
  assert.ok(text.includes('reason_code=\\x1b[31m\\tbad'));
  assert.doesNotMatch(text, /\x1b/);
});
