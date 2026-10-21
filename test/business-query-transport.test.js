import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runBusinessCLI } from '../src/lib/business-cli.js';

const workspace = '60000000-0000-4000-8000-000000000001';
const issue = '10000000-0000-4000-8000-000000000001';
const agent = '50000000-0000-4000-8000-000000000001';
const task = 'a0000000-0000-4000-8000-000000000001';
const config = { base_url: 'https://fixture.invalid', workspace_id: workspace, workspace_slug: 'fixture', pat: 'fixture-private-pat' };

function queryFixture(result = [{ id: 'result' }]) {
  const calls = [], out = [], err = [];
  const dependencies = {
    stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) },
    request: async (auth, method, endpoint, body, options) => {
      calls.push({ auth: { ...auth }, method, endpoint, body, options });
      if (endpoint === `/api/issues/${issue}`) return { id: issue };
      return result;
    },
  };
  return { calls, out, err, dependencies, run: (args) => runBusinessCLI({ ...config }, args, dependencies) };
}

// Paths and query flags follow the pinned v0.6.2 cmd_agent/squad/issue.go.
const queries = [
  { args: ['agent', 'list', '--include-archived'], endpoint: '/api/agents', query: { workspace_id: workspace, include_archived: 'true' } },
  { args: ['agent', 'get', agent], endpoint: `/api/agents/${agent}` },
  { args: ['agent', 'skills', 'list', agent], endpoint: `/api/agents/${agent}/skills` },
  { args: ['squad', 'list'], endpoint: '/api/squads' },
  { args: ['squad', 'get', agent], endpoint: `/api/squads/${agent}` },
  { args: ['squad', 'member', 'list', agent], endpoint: `/api/squads/${agent}/members` },
  ...['children', 'pull-requests', 'usage'].map((name) => ({ args: ['issue', name, issue], endpoint: `/api/issues/${issue}/${name}` })),
  { args: ['issue', 'runs', issue, '--siblings'], endpoint: `/api/issues/${issue}/task-runs`, query: { active: 'true', scope: 'family' } },
  { args: ['issue', 'search', 'a & b/\u4e2d\u6587', '--limit', '7', '--include-closed'], endpoint: '/api/issues/search', query: { q: 'a & b/\u4e2d\u6587', workspace_id: workspace, limit: '7', include_closed: 'true' } },
  { args: ['issue', 'run-messages', task, '--since', '4'], endpoint: `/api/tasks/${task}/messages`, query: { since: '4' } },
  { args: ['issue', 'run-messages', task], endpoint: `/api/tasks/${task}/messages` },
];
for (const item of queries) test(`query contract: ${item.args.join(' ')}`, async () => {
  const h = queryFixture();
  assert.deepEqual(await h.run(item.args), [{ id: 'result' }]);
  const resolvesIssue = item.endpoint.startsWith(`/api/issues/${issue}/`);
  assert.equal(h.calls.length, resolvesIssue ? 2 : 1);
  if (resolvesIssue) assert.equal(h.calls[0].endpoint, `/api/issues/${issue}`);
  const call = h.calls.at(-1), url = new URL(call.endpoint, config.base_url);
  assert.equal(call.method, 'GET');
  assert.equal(call.body, undefined);
  assert.equal(call.options.workspaceHeader, true);
  assert.equal(url.pathname, item.endpoint);
  assert.deepEqual(Object.fromEntries(url.searchParams), item.query ?? {});
  assert.ok(!h.out.join('').includes(config.pat));
});

for (const output of ['json', 'table']) test(`agent tasks pagination (${output}) preserves cursor and usage contract`, async () => {
  const h = queryFixture({ data: [{ id: task }], headers: { 'X-Agent-Tasks-Next-Cursor': 'cursor with spaces' } });
  assert.deepEqual(await h.run(['agent', 'tasks', agent, '--limit', '3', '--before', 'previous/cursor', '--output', output]), [{ id: task }]);
  const call = h.calls[0], url = new URL(call.endpoint, config.base_url);
  assert.equal(url.pathname, `/api/agents/${agent}/tasks`);
  assert.deepEqual(Object.fromEntries(url.searchParams), { limit: '3', before: 'previous/cursor', ...(output === 'json' ? { include_usage: 'true' } : {}) });
  assert.equal(call.options.includeHeaders, true);
  assert.match(h.err.join(''), /--before "cursor with spaces"/);
});

test('agent tasks default page is bounded and no cursor warning appears without header', async () => {
  const h = queryFixture({ data: [], headers: {} });
  await h.run(['agent', 'tasks', agent]);
  assert.equal(new URL(h.calls[0].endpoint, config.base_url).searchParams.get('limit'), '50');
  assert.equal(h.err.join(''), '');
});

test('workspace member list resolves a slug-only configuration before constructing member endpoint', async () => {
  const h = queryFixture(), original = h.dependencies.request;
  h.dependencies.request = async (...args) => {
    if (args[2] === '/api/workspaces') {
      h.calls.push({ method: args[1], endpoint: args[2] });
      return [{ id: workspace, slug: 'fixture' }];
    }
    return original(...args);
  };
  await runBusinessCLI({ ...config, workspace_id: undefined }, ['workspace', 'member', 'list'], h.dependencies);
  assert.deepEqual(h.calls.map((c) => c.endpoint), ['/api/workspaces', `/api/workspaces/${workspace}/members`]);
});

test('unknown configured workspace cannot reach member endpoint', async () => {
  const h = queryFixture([{ id: workspace, slug: 'other' }]);
  await assert.rejects(runBusinessCLI({ ...config, workspace_id: undefined }, ['workspace', 'member', 'list'], h.dependencies), /not found/);
  assert.deepEqual(h.calls.map((c) => c.endpoint), ['/api/workspaces']);
});

test('chat thread resolves configured workspace before sending task-authenticated request', async () => {
  const calls = [];
  const result = await runBusinessCLI({ ...config, workspace_id: undefined }, ['chat', 'thread', '--task', task], {
    stdout: { write() {} }, loadTaskToken: () => 'fixture-task-token',
    request: async (auth, method, endpoint, _body, options) => {
      calls.push({ token: auth.pat, method, endpoint, workspace: auth.workspace_id, options });
      return endpoint === '/api/workspaces' ? [{ id: workspace, slug: 'fixture' }] : { messages: [] };
    },
  });
  assert.deepEqual(result, { messages: [] });
  assert.equal(calls[0].endpoint, '/api/workspaces');
  assert.equal(calls[1].endpoint, '/api/chat/thread');
  assert.equal(calls[1].token, 'fixture-task-token');
  assert.equal(calls[1].workspace, workspace);
});

for (const args of [
  ['agent', 'tasks', agent, '--limit', '0'], ['agent', 'tasks', agent, '--before'],
  ['agent', 'tasks', agent, '--limit', '1.5'], ['agent', 'tasks', agent, '--output', 'xml'],
  ['issue', 'search', 'q', '--limit', '0'], ['issue', 'search'],
  ['issue', 'run-messages', task, '--since', '-1'], ['issue', 'run-messages', 'short'],
  ['issue', 'children', issue, '--unexpected'], ['squad', 'member', 'list'],
]) test(`query rejects before workspace lookup: ${args.join(' ')}`, async () => {
  const h = queryFixture();
  await assert.rejects(runBusinessCLI({ ...config, workspace_id: undefined }, args, h.dependencies));
  assert.equal(h.calls.length, 0);
});

async function uploadFixture(t, handler) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-http-upload-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'binary\u0000report\r\nbytes');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const request = { method: req.method, url: req.url, headers: req.headers, bytes: Buffer.concat(chunks) };
    requests.push(request);
    handler(request, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const stdout = [], stderr = [];
  const dependencies = { cwd, stdout: { write: (s) => stdout.push(s) }, stderr: { write: (s) => stderr.push(s) }, loadTaskToken: () => 'fixture-task-token' };
  const localConfig = { ...config, base_url: `http://127.0.0.1:${server.address().port}` };
  return { requests, stdout, stderr, dependencies, localConfig, run: (args = ['attachment', 'upload', 'report.txt', '--task', task]) => runBusinessCLI(localConfig, args, dependencies) };
}

test('real HTTP upload has a generated multipart boundary, exact bytes, workspace and task authentication', async (t) => {
  const h = await uploadFixture(t, (_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: 'attachment-1', content_type: 'text/plain', markdown_url: '/download/attachment-1' })); });
  assert.equal((await h.run()).id, 'attachment-1');
  assert.equal(h.requests.length, 1);
  const req = h.requests[0];
  assert.equal(req.url, '/api/upload-file'); assert.equal(req.method, 'POST');
  assert.equal(req.headers.authorization, 'Bearer fixture-task-token');
  assert.equal(req.headers['x-workspace-id'], workspace);
  const boundary = req.headers['content-type'].match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
  assert.ok(boundary);
  const raw = req.bytes.toString();
  assert.ok(raw.startsWith(`--${boundary}\r\n`)); assert.ok(raw.trimEnd().endsWith(`--${boundary}--`));
  assert.match(raw, /name="file"; filename="report.txt"/);
  assert.ok(req.bytes.includes(Buffer.from('binary\u0000report\r\nbytes')));
  assert.ok(raw.includes(`name="task_id"\r\n\r\n${task}\r\n`));
  assert.ok(!raw.includes(config.pat));
  assert.ok(!h.stdout.join('').includes('fixture-task-token'));
});

test('upload HTTP error redacts task token and performs no retry', async (t) => {
  const h = await uploadFixture(t, (_req, res) => { res.statusCode = 403; res.end('rejected fixture-task-token'); });
  await assert.rejects(h.run(), (error) => {
    assert.equal(error.status, 403); assert.match(error.message, /\[REDACTED\]/);
    assert.ok(!error.message.includes('fixture-task-token')); return true;
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.stdout.join(''), '');
});

test('upload missing token or missing task rejects without contacting HTTP server', async (t) => {
  const h = await uploadFixture(t, () => { throw new Error('unexpected request'); });
  await assert.rejects(h.run(['attachment', 'upload', 'report.txt']), /--task/);
  h.dependencies.loadTaskToken = () => { throw new Error('task token unavailable'); };
  await assert.rejects(h.run(), /task token unavailable/);
  assert.equal(h.requests.length, 0);
});

test('upload malformed success is reported without retry or successful receipt', async (t) => {
  const h = await uploadFixture(t, (_req, res) => res.end('{}'));
  await assert.rejects(h.run(), /missing attachment id/);
  assert.equal(h.requests.length, 1); assert.equal(h.stdout.join(''), '');
});

test('ordinary HTTP query errors redact the PAT and do not retry', async (t) => {
  const h = await uploadFixture(t, (_req, res) => { res.statusCode = 401; res.end(`invalid ${config.pat}`); });
  await assert.rejects(runBusinessCLI(h.localConfig, ['agent', 'list'], h.dependencies), (error) => {
    assert.equal(error.status, 401); assert.match(error.message, /\[REDACTED\]/);
    assert.ok(!error.message.includes(config.pat)); return true;
  });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].headers.authorization, `Bearer ${config.pat}`);
  assert.equal(h.stdout.join(''), '');
});

test('ordinary HTTP query rejects invalid JSON without exposing the response body', async (t) => {
  const h = await uploadFixture(t, (_req, res) => res.end(`not-json ${config.pat}`));
  await assert.rejects(runBusinessCLI(h.localConfig, ['agent', 'list'], h.dependencies), (error) => {
    assert.match(error.message, /invalid JSON/); assert.ok(!error.message.includes(config.pat)); return true;
  });
  assert.equal(h.requests.length, 1); assert.equal(h.stdout.join(''), '');
});
