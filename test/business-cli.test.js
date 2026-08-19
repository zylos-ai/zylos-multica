import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runBusinessCLI } from '../src/lib/business-cli.js';

const config = {
  base_url: 'https://multica.example',
  pat: 'secret',
  workspace_slug: 'workspace-1',
  workspace_id: 'workspace-1',
};

function harness(response = {}) {
  const calls = [];
  const authTokens = [];
  let output = '';
  const stdout = new PassThrough();
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk) => { output += chunk; });
  return {
    calls,
    output: () => output,
    dependencies: {
      stdout,
      request: async (requestConfig, method, apiPath, body, options) => {
        authTokens.push(requestConfig.pat);
        calls.push({ method, apiPath, body, options });
        return typeof response === 'function' ? response({ method, apiPath, body, options }) : response;
      },
    },
    authTokens,
  };
}

test('issue create preserves file text and binds existing attachments', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-cli-'));
  fs.writeFileSync(path.join(cwd, 'description.md'), 'Line 1\\literal\nLine 2\n');
  const h = harness({ id: 'issue-1' });
  h.dependencies.cwd = cwd;
  await runBusinessCLI(config, [
    'issue', 'create', '--title', 'Title', '--description-file', 'description.md',
    '--attachment-id', 'att-1', '--attachment-id', 'att-1', '--attachment-id', 'att-2',
  ], h.dependencies);
  assert.deepEqual(h.calls[0], {
    method: 'POST',
    apiPath: '/api/issues',
    body: {
      title: 'Title',
      description: 'Line 1\\literal\nLine 2',
      attachment_ids: ['att-1', 'att-2'],
    },
    options: { workspaceHeader: true },
  });
});

test('issue create rejects symlink escapes before making a request', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-cli-guard-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-cli-outside-'));
  fs.writeFileSync(path.join(outside, 'description.md'), 'secret');
  fs.symlinkSync(path.join(outside, 'description.md'), path.join(cwd, 'escape.md'));
  const h = harness();
  h.dependencies.cwd = cwd;
  await assert.rejects(
    runBusinessCLI(config, ['issue', 'create', '--title', 'X', '--description-file', 'escape.md'], h.dependencies),
    /outside the current working directory/,
  );
  assert.equal(h.calls.length, 0);
});

test('issue get and list encode references and preserve paging/sort semantics', async () => {
  const h = harness(({ apiPath }) => apiPath.startsWith('/api/issues?')
    ? { issues: [{ id: '1' }], total: 3 }
    : { id: 'resolved' });
  await runBusinessCLI(config, ['issue', 'get', 'MUL-7'], h.dependencies);
  await runBusinessCLI(config, [
    'issue', 'list', '--status', 'in_progress', '--limit', '1', '--offset', '1',
    '--sort', 'created_at', '--direction', 'desc', '--output', 'json',
  ], h.dependencies);
  assert.equal(h.calls[0].apiPath, '/api/issues/MUL-7');
  const listUrl = new URL(h.calls[1].apiPath, 'https://multica.example');
  assert.equal(listUrl.searchParams.get('workspace_id'), 'workspace-1');
  assert.equal(listUrl.searchParams.get('status'), 'in_progress');
  assert.equal(listUrl.searchParams.get('limit'), '1');
  assert.equal(listUrl.searchParams.get('offset'), '1');
  assert.equal(listUrl.searchParams.get('sort'), 'created_at');
  assert.equal(listUrl.searchParams.get('direction'), 'desc');
  assert.match(h.output(), /"has_more": true/);
  await assert.rejects(
    runBusinessCLI(config, ['issue', 'list', '--direction', 'desc'], h.dependencies),
    /requires a non-position --sort/,
  );
});

test('issue comment add/list implement text decoding and bounded thread paging', async () => {
  const h = harness(({ method, apiPath }) => method === 'GET' && /^\/api\/issues\/MUL-8$/.test(apiPath)
    ? { id: 'issue-8', identifier: 'MUL-8' }
    : []);
  await runBusinessCLI(config, [
    'issue', 'comment', 'add', 'MUL-8', '--content', 'Line 1\\nLine 2', '--parent', 'comment-1',
  ], h.dependencies);
  await runBusinessCLI(config, [
    'issue', 'comment', 'list', 'MUL-8', '--thread', 'comment-1', '--tail', '30',
    '--before', 'cursor-time', '--before-id', 'cursor-id', '--summary', '--output', 'json',
  ], h.dependencies);
  assert.deepEqual(h.calls[1].body, { content: 'Line 1\nLine 2', parent_id: 'comment-1' });
  assert.equal(h.calls[1].apiPath, '/api/issues/issue-8/comments');
  const listUrl = new URL(h.calls[3].apiPath, 'https://multica.example');
  assert.equal(listUrl.searchParams.get('thread'), 'comment-1');
  assert.equal(listUrl.searchParams.get('tail'), '30');
  assert.equal(listUrl.searchParams.get('before'), 'cursor-time');
  assert.equal(listUrl.searchParams.get('before_id'), 'cursor-id');
  assert.equal(listUrl.searchParams.get('summary'), 'true');
  assert.equal(listUrl.searchParams.has('fold'), false);
  await assert.rejects(
    runBusinessCLI(config, ['issue', 'comment', 'list', 'MUL-8', '--tail', '3'], h.dependencies),
    /--tail requires --thread/,
  );
});

test('chat history requires a task and uses only its scoped token', async () => {
  const h = harness({ messages: [] });
  h.dependencies.loadTaskToken = (taskId) => {
    assert.equal(taskId, 'chat-task-1');
    return 'mat_task_scoped';
  };
  await runBusinessCLI(config, [
    'chat', 'history', '--task', 'chat-task-1', '--limit', '20', '--before', 'opaque',
  ], h.dependencies);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].apiPath, '/api/chat/history?limit=20&before=opaque');
  assert.deepEqual(h.calls[0].options, { workspaceHeader: true });
  assert.deepEqual(h.authTokens, ['mat_task_scoped']);
  assert.notEqual(h.authTokens[0], config.pat);
  await assert.rejects(
    runBusinessCLI(config, ['chat', 'history'], h.dependencies),
    /--task is required/,
  );
});
