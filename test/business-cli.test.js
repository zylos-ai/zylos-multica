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


test('an invalid --output fails before any API call on every command', async () => {
  const argvCases = [
    // Mutating commands: a late argument error after the POST would strand a
    // completed side effect behind a FAILED exit (duplicate-on-retry).
    ['issue', 'create', '--title', 'Title', '--output', 'yaml'],
    ['issue', 'create', '--title', 'Title', '--output'],
    ['issue', 'create', '--title', 'Title', '--output', 'json', '--output', 'json'],
    ['issue', 'comment', 'add', 'PROJ-1', '--content', 'hello', '--output', 'yaml'],
    ['issue', 'comment', 'add', 'PROJ-1', '--content', 'hello', '--output'],
    // Read commands share the same validate-before-request invariant.
    ['issue', 'get', 'PROJ-1', '--output', 'yaml'],
    ['issue', 'list', '--output', 'yaml'],
    ['issue', 'comment', 'list', 'PROJ-1', '--output', 'yaml'],
  ];
  for (const argv of argvCases) {
    const h = harness({ id: 'issue-1' });
    await assert.rejects(runBusinessCLI(config, argv, h.dependencies), /--output/);
    assert.equal(h.calls.length, 0, `no request may precede --output validation for: ${argv.join(' ')}`);
  }

  const chat = harness({ messages: [] });
  chat.dependencies.loadTaskToken = () => 'task-token';
  await assert.rejects(
    runBusinessCLI(config, ['chat', 'history', '--task', 'task-1', '--output', 'yaml'], chat.dependencies),
    /--output/,
  );
  assert.equal(chat.calls.length, 0);
});

test('table output renders remote control characters as inert single-line escapes', async () => {
  const h = harness({
    issues: [{
      id: 'issue-1',
      title: 'evil\u001b]0;pwned\u0007\tcol\r\nforged=row',
    }],
    total: 1,
  });
  await runBusinessCLI(config, ['issue', 'list', '--output', 'table'], h.dependencies);
  const body = h.output();
  const lines = body.trimEnd().split('\n');
  assert.equal(lines.length, 1, 'one record renders exactly one line');
  assert.match(lines[0], /evil\\x1b\]0;pwned\\x07\\tcol\\r\\nforged=row/);
  // No raw C0/C1 byte survives except the structural field-separator tabs
  // and the record-terminating newline.
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(body.replaceAll('\t', '').replaceAll('\n', ''), /[\u0000-\u001f\u007f-\u009f]/);
  assert.ok(lines[0].split('\t').length >= 2, 'structural field separators are preserved');

  const hJson = harness({ issues: [{ id: 'issue-1', title: 'plain' }], total: 1 });
  await runBusinessCLI(config, ['issue', 'list', '--output', 'json'], hJson.dependencies);
  assert.ok(JSON.parse(hJson.output()), 'json output stays structurally valid');
});

test('slug-only config: invalid --output rejects with zero requests, before workspace resolution', async () => {
  // A slug-only config (no cached workspace_id) makes workspace resolution a
  // real GET /api/workspaces — the production first request. Reviewer finding
  // (review of 21e0c75): the previous fixture preloaded both slug and id, so
  // the early return hid that this GET ran before --output validation.
  const slugOnlyConfig = {
    base_url: 'https://multica.example',
    pat: 'secret',
    workspace_slug: 'workspace-1',
  };
  for (const argv of [
    ['issue', 'create', '--title', 'Title', '--output', 'yaml'],
    ['issue', 'comment', 'add', 'PROJ-1', '--content', 'hello', '--output', 'yaml'],
  ]) {
    const h = harness([{ id: 'ws-1', slug: 'workspace-1' }]);
    await assert.rejects(runBusinessCLI({ ...slugOnlyConfig }, argv, h.dependencies), /--output/);
    assert.equal(h.calls.length, 0, `zero requests (incl. GET /api/workspaces) for: ${argv.join(' ')}`);
  }

  // Positive control for the same path: with a valid --output the resolution
  // GET runs first, proving the fixture exercises the production first request.
  const ok = harness(({ apiPath }) => (apiPath === '/api/workspaces'
    ? [{ id: 'ws-1', slug: 'workspace-1' }]
    : { id: 'issue-1' }));
  await runBusinessCLI({ ...slugOnlyConfig }, ['issue', 'create', '--title', 'Title', '--output', 'json'], ok.dependencies);
  assert.equal(ok.calls[0].apiPath, '/api/workspaces', 'slug-only config really resolves the workspace first');
});
