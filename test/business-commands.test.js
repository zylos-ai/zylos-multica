import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runBusinessCLI } from '../src/lib/business-cli.js';

const ids = {
  issue: '10000000-0000-4000-8000-000000000001', project: '20000000-0000-4000-8000-000000000001',
  label: '30000000-0000-4000-8000-000000000001', property: '40000000-0000-4000-8000-000000000001',
  agent: '50000000-0000-4000-8000-000000000001', workspace: '60000000-0000-4000-8000-000000000001',
  resource: '70000000-0000-4000-8000-000000000001', comment: '80000000-0000-4000-8000-000000000001',
  member: '90000000-0000-4000-8000-000000000001', run: 'a0000000-0000-4000-8000-000000000001',
};
const config = { base_url: 'https://multica.example', workspace_id: ids.workspace, workspace_slug: 'workspace', pat: 'fixture-private-pat' };

function fixture() {
  const state = {
    issue: { id: ids.issue, title: 'Original', status: 'in_progress', metadata: {}, properties: {} },
    project: { id: ids.project, title: 'Project', status: 'planned' },
    label: { id: ids.label, name: 'Label', color: '#abcdef', resource_type: 'issue' },
    property: { id: ids.property, name: 'Severity', type: 'select', config: { options: [{ id: 'option-1', name: 'Major', color: '#abcdef' }] } },
    workspace: { id: ids.workspace, name: 'Workspace', slug: 'workspace' },
    resource: { id: ids.resource, resource_type: 'github_repo', resource_ref: { url: 'https://github.com/example/repo', ref: 'main' } },
    comment: { id: ids.comment, content: 'Old', revision: 2 }, subscribers: [], labels: [],
  };
  const calls = [];
  let output = '', errors = '';
  const dependencies = {
    stdout: { write: (chunk) => { output += chunk; } },
    stderr: { write: (chunk) => { errors += chunk; } },
    loadTaskToken: () => 'fixture-task-token',
    request: async (auth, method, endpoint, body, options) => {
      calls.push({ method, endpoint, body: structuredClone(body), options, token: auth.pat });
      const url = new URL(endpoint, config.base_url), p = url.pathname;
      if (p === '/api/agents') return [{ id: ids.agent, name: 'Piper' }];
      if (p === '/api/squads') return [];
      if (p === `/api/workspaces/${ids.workspace}/members`) {
        if (method === 'POST') { state.invite = { ...body }; return state.invite; }
        return [{ user_id: ids.member, name: 'Howard', email: 'owner@example.com' }, ...(state.invite ? [state.invite] : [])];
      }
      if (p === '/api/chat/thread') return { messages: [{ content: 'thread content' }] };
      if (p === `/api/issues/${ids.issue}/timeline`) return { data: state.timeline ?? [], headers: { 'x-timeline-truncated': 'activity' } };
      if (p === `/api/issues/${ids.issue}/comments`) return [state.comment].filter(Boolean);
      if (p === `/api/issues/${ids.issue}/metadata`) return { metadata: state.issue.metadata };
      if (p.startsWith(`/api/issues/${ids.issue}/metadata/`)) {
        const key = decodeURIComponent(p.split('/').at(-1));
        if (method === 'PUT') state.issue.metadata[key] = body.value;
        else delete state.issue.metadata[key];
        return { metadata: state.issue.metadata };
      }
      if (p.startsWith(`/api/issues/${ids.issue}/properties/`)) {
        const key = p.split('/').at(-1);
        if (method === 'PUT') state.issue.properties[key] = body.value;
        else delete state.issue.properties[key];
        return { properties: state.issue.properties };
      }
      if (p === `/api/issues/${ids.issue}/labels`) {
        if (method === 'POST') state.labels = [state.label];
        return { labels: state.labels };
      }
      if (p === `/api/issues/${ids.issue}/labels/${ids.label}`) { state.labels = []; return null; }
      if (p === `/api/issues/${ids.issue}/subscribers`) return state.subscribers;
      if (p === `/api/issues/${ids.issue}/subscribe`) { state.subscribers = [body]; return body; }
      if (p === `/api/issues/${ids.issue}/unsubscribe`) { state.subscribers = []; return {}; }
      if (p.startsWith(`/api/comments/${ids.comment}`)) {
        if (method === 'PUT') { assert.equal(body.expected_revision, state.comment.revision); Object.assign(state.comment, { content: body.content, revision: 3 }); }
        else if (p.endsWith('/keep-replies')) state.comment = null;
        else state.comment.resolved = method === 'POST';
        return state.comment;
      }
      if (p === `/api/projects/${ids.project}/resources`) {
        if (method === 'POST') state.resource = { id: ids.resource, ...body };
        return { resources: [state.resource].filter(Boolean) };
      }
      if (p === `/api/projects/${ids.project}/resources/${ids.resource}`) {
        if (method === 'DELETE') state.resource = null;
        else Object.assign(state.resource, body);
        return state.resource;
      }
      if (p === `/api/issues/${ids.issue}/rerun`) { state.run = { id: ids.run, status: 'queued' }; return state.run; }
      if (p === `/api/tasks/${ids.run}/cancel`) { state.run = { id: ids.run, status: 'cancelled' }; return state.run; }
      if (p === `/api/issues/${ids.issue}/task-runs`) return [state.run].filter(Boolean);
      if (p === '/api/upload-file') {
        assert.equal(auth.pat, 'fixture-task-token');
        assert.equal(options.multipart.get('task_id'), ids.run);
        const file = options.multipart.get('file');
        state.upload = { id: 'attachment-1', filename: file.name, bytes: await file.text(), content_type: 'text/plain', markdown_url: '/api/attachments/attachment-1/download' };
        return state.upload;
      }
      if (p === '/api/attachments/attachment-1') return state.upload;
      for (const [kind, plural] of [['issue', 'issues'], ['project', 'projects'], ['label', 'labels'], ['property', 'properties'], ['workspace', 'workspaces']]) {
        if (p === `/api/${plural}`) {
          if (method === 'POST') { state[kind] = { id: ids[kind], ...body }; return state[kind]; }
          return kind === 'workspace' ? [state[kind]] : { [plural]: [state[kind]].filter(Boolean), total: 1 };
        }
        if (p === `/api/${plural}/${ids[kind]}` || kind === 'issue' && p === '/api/issues/MUL-1') {
          if (method === 'DELETE') state[kind] = null;
          else if (method !== 'GET') Object.assign(state[kind], body);
          return structuredClone(state[kind]);
        }
      }
      throw new Error(`unhandled fixture request ${method} ${endpoint}`);
    },
  };
  return { state, calls, dependencies, output: () => output, errors: () => errors, run: (args) => runBusinessCLI({ ...config }, args, dependencies) };
}

const writeCases = [
  { name: 'status', args: ['issue', 'status', 'MUL-1', 'done'], path: `/api/issues/${ids.issue}`, body: { status: 'done', suppress_run: true }, read: ['issue', 'get', 'MUL-1'], check: (r) => assert.equal(r.status, 'done') },
  { name: 'update', args: ['issue', 'update', 'MUL-1', '--title', 'Changed', '--priority', 'urgent'], path: `/api/issues/${ids.issue}`, body: { title: 'Changed', priority: 'urgent', suppress_run: true }, read: ['issue', 'get', 'MUL-1'], check: (r) => { assert.equal(r.title, 'Changed'); assert.equal(r.priority, 'urgent'); } },
  { name: 'assign', args: ['issue', 'assign', 'MUL-1', '--to', 'Piper'], path: `/api/issues/${ids.issue}`, body: { assignee_type: 'agent', assignee_id: ids.agent, suppress_run: true }, read: ['issue', 'get', 'MUL-1'], check: (r) => assert.equal(r.assignee_id, ids.agent) },
  { name: 'unassign', args: ['issue', 'assign', 'MUL-1', '--unassign'], path: `/api/issues/${ids.issue}`, body: { assignee_type: null, assignee_id: null, suppress_run: true }, read: ['issue', 'get', 'MUL-1'], check: (r) => assert.equal(r.assignee_id, null) },
  ...['project', 'label'].flatMap((group) => [
    { name: `${group} create`, args: [group, 'create', ...(group === 'project' ? ['--title', 'Created'] : ['--name', 'Created', '--color', '#123456'])], method: 'POST', path: `/api/${group}s`, read: [group, 'get', ids[group]], check: (r) => assert.equal(r[group === 'project' ? 'title' : 'name'], 'Created') },
    { name: `${group} update`, args: [group, 'update', ids[group], group === 'project' ? '--title' : '--name', 'Updated'], path: `/api/${group}s/${ids[group]}`, read: [group, 'get', ids[group]], check: (r) => assert.equal(r[group === 'project' ? 'title' : 'name'], 'Updated') },
    { name: `${group} delete`, args: [group, 'delete', ids[group]], method: 'DELETE', path: `/api/${group}s/${ids[group]}`, read: [group, 'list'], check: (r) => assert.deepEqual(r, []) },
  ]),
  { name: 'project status', args: ['project', 'status', ids.project, 'completed'], path: `/api/projects/${ids.project}`, read: ['project', 'get', ids.project], check: (r) => assert.equal(r.status, 'completed') },
  { name: 'project resource add', args: ['project', 'resource', 'add', ids.project, '--url', 'https://github.com/example/new'], method: 'POST', path: `/api/projects/${ids.project}/resources`, read: ['project', 'resource', 'list', ids.project], check: (r) => assert.equal(r[0].resource_ref.url, 'https://github.com/example/new') },
  { name: 'project resource update', args: ['project', 'resource', 'update', ids.project, ids.resource, '--default-branch-hint', 'dev'], path: `/api/projects/${ids.project}/resources/${ids.resource}`, read: ['project', 'resource', 'list', ids.project], check: (r) => { assert.equal(r[0].resource_ref.default_branch_hint, 'dev'); assert.equal(r[0].resource_ref.url, 'https://github.com/example/repo'); assert.equal(r[0].resource_ref.ref, 'main'); } },
  { name: 'project resource remove', args: ['project', 'resource', 'remove', ids.project, ids.resource], method: 'DELETE', path: `/api/projects/${ids.project}/resources/${ids.resource}`, read: ['project', 'resource', 'list', ids.project], check: (r) => assert.deepEqual(r, []) },
  { name: 'issue label add', args: ['issue', 'label', 'add', 'MUL-1', ids.label], method: 'POST', path: `/api/issues/${ids.issue}/labels`, read: ['issue', 'label', 'list', 'MUL-1'], check: (r) => assert.equal(r[0].id, ids.label) },
  { name: 'issue label remove', args: ['issue', 'label', 'remove', 'MUL-1', ids.label], method: 'DELETE', path: `/api/issues/${ids.issue}/labels/${ids.label}`, setup: (s) => { s.labels = [s.label]; }, read: ['issue', 'label', 'list', 'MUL-1'], check: (r) => assert.deepEqual(r, []) },
  ...['add', 'remove'].map((action) => ({ name: `subscriber ${action}`, args: ['issue', 'subscriber', action, 'MUL-1', '--user', 'Howard'], method: 'POST', path: `/api/issues/${ids.issue}/${action === 'add' ? 'subscribe' : 'unsubscribe'}`, read: ['issue', 'subscriber', 'list', 'MUL-1'], check: (r) => action === 'add' ? assert.deepEqual(r, [{ user_type: 'member', user_id: ids.member }]) : assert.deepEqual(r, []) })),
  { name: 'metadata set', args: ['issue', 'metadata', 'set', 'MUL-1', '--key', '_build', '--value', '42'], path: `/api/issues/${ids.issue}/metadata/_build`, body: { value: 42 }, read: ['issue', 'metadata', 'get', 'MUL-1', '--key', '_build'], check: (r) => assert.equal(r, 42) },
  { name: 'metadata delete', args: ['issue', 'metadata', 'delete', 'MUL-1', '--key', 'build'], method: 'DELETE', path: `/api/issues/${ids.issue}/metadata/build`, setup: (s) => { s.issue.metadata.build = true; }, read: ['issue', 'metadata', 'list', 'MUL-1'], check: (r) => assert.deepEqual(r, {}) },
  { name: 'comment update', args: ['issue', 'comment', 'update', ids.comment, '--content', 'New', '--expected-revision', '2'], path: `/api/comments/${ids.comment}`, body: { content: 'New', expected_revision: 2 }, read: ['issue', 'comment', 'list', 'MUL-1'], check: (r) => assert.equal(r[0].content, 'New') },
  { name: 'comment delete', args: ['issue', 'comment', 'delete', ids.comment], method: 'DELETE', path: `/api/comments/${ids.comment}/keep-replies`, read: ['issue', 'comment', 'list', 'MUL-1'], check: (r) => assert.deepEqual(r, []) },
  ...['resolve', 'unresolve'].map((action) => ({ name: `comment ${action}`, args: ['issue', 'comment', action, ids.comment], method: action === 'resolve' ? 'POST' : 'DELETE', path: `/api/comments/${ids.comment}/resolve`, read: ['issue', 'comment', 'list', 'MUL-1'], check: (r) => assert.equal(r[0].resolved, action === 'resolve') })),
  { name: 'property create', args: ['property', 'create', '--name', 'New', '--type', 'number'], method: 'POST', path: '/api/properties', read: ['property', 'get', ids.property], check: (r) => assert.equal(r.type, 'number') },
  { name: 'property update', args: ['property', 'update', 'Severity', '--option', 'Major:#123456'], method: 'PATCH', path: `/api/properties/${ids.property}`, read: ['property', 'get', ids.property], check: (r) => { assert.equal(r.config.options[0].color, '#123456'); assert.equal(r.config.options[0].id, 'option-1'); } },
  ...['archive', 'unarchive'].map((action) => ({ name: `property ${action}`, args: ['property', action, 'Severity'], method: 'PATCH', path: `/api/properties/${ids.property}`, read: ['property', 'get', ids.property], check: (r) => assert.equal(r.archived, action === 'archive') })),
  { name: 'issue property set', args: ['issue', 'property', 'set', 'MUL-1', '--name', 'Severity', '--value', 'Major'], path: `/api/issues/${ids.issue}/properties/${ids.property}`, body: { value: 'option-1' }, read: ['issue', 'property', 'list', 'MUL-1'], check: (r) => { assert.equal(r[0].value, 'option-1'); assert.equal(r[0].display, 'Major'); } },
  { name: 'issue property unset', args: ['issue', 'property', 'unset', 'MUL-1', '--name', 'Severity'], method: 'DELETE', path: `/api/issues/${ids.issue}/properties/${ids.property}`, setup: (s) => { s.issue.properties[ids.property] = 'option-1'; }, read: ['issue', 'property', 'list', 'MUL-1'], check: (r) => assert.deepEqual(r, []) },
  { name: 'workspace create', args: ['workspace', 'create', '--name', 'New', '--slug', 'new'], method: 'POST', path: '/api/workspaces', read: ['workspace', 'get', ids.workspace], check: (r) => assert.equal(r.slug, 'new') },
  { name: 'workspace update', args: ['workspace', 'update', '--name', 'Renamed'], method: 'PATCH', path: `/api/workspaces/${ids.workspace}`, read: ['workspace', 'get'], check: (r) => assert.equal(r.name, 'Renamed') },
  { name: 'workspace invite', args: ['workspace', 'member', 'invite', 'friend@example.com', '--role', 'admin'], method: 'POST', path: `/api/workspaces/${ids.workspace}/members`, read: ['workspace', 'member', 'list'], check: (r) => assert.equal(r.at(-1).email, 'friend@example.com') },
  { name: 'rerun', args: ['issue', 'rerun', 'MUL-1'], method: 'POST', path: `/api/issues/${ids.issue}/rerun`, read: ['issue', 'runs', 'MUL-1'], check: (r) => assert.equal(r[0].status, 'queued') },
  { name: 'cancel-task', args: ['issue', 'cancel-task', ids.run], method: 'POST', path: `/api/tasks/${ids.run}/cancel`, read: ['issue', 'runs', 'MUL-1'], check: (r) => assert.equal(r[0].status, 'cancelled') },
];

for (const item of writeCases) test(`write/readback: ${item.name}`, async () => {
  const h = fixture(); item.setup?.(h.state);
  await h.run(item.args);
  const mutations = h.calls.filter((call) => call.method !== 'GET');
  assert.equal(mutations.length, 1, 'one mutation, no blind retries');
  assert.equal(mutations[0].method, item.method ?? 'PUT');
  assert.equal(mutations[0].endpoint, item.path);
  if (item.body) assert.deepEqual(mutations[0].body, item.body);
  item.check(await h.run(item.read));
  assert.ok(!h.output().includes(config.pat));
});

const rejects = [
  ['project', 'resource', 'update', ids.project, ids.resource, '--type', 'github_repo', '--url', 'x'],
  ['project', 'resource', 'update', ids.project, ids.resource, '--url', ''],
  ['issue', 'status', 'MUL-1', 'bad status'], ['issue', 'status', 'MUL-1', 'done', '--start', '--no-start'],
  ['issue', 'update', 'MUL-1', '--priority', 'invalid'], ['issue', 'update', 'MUL-1', '--stage', '0'],
  ['issue', 'update', 'MUL-1', '--position', 'NaN'], ['issue', 'update', 'MUL-1'],
  ['issue', 'assign', 'MUL-1'], ['issue', 'assign', 'MUL-1', '--to-id', 'bad'],
  ['issue', 'assign', 'MUL-1', '--to', 'Piper', '--unassign'],
  ['issue', 'status', 'MUL-1', 'done', '--duplicate-of', 'MUL-2'],
  ['project', 'create'], ['project', 'update', ids.project], ['project', 'status', ids.project, 'wrong'],
  ['label', 'create', '--name', 'A'], ['label', 'update', ids.label, '--color', 'red'],
  ['project', 'resource', 'add', ids.project], ['project', 'resource', 'update', ids.project, ids.resource],
  ['property', 'create', '--name', 'A', '--type', 'unknown'], ['property', 'update', 'Severity'],
  ['property', 'create', '--name', 'A', '--type', 'text', '--option', 'Wrong'],
  ['issue', 'metadata', 'set', 'MUL-1', '--key', '1bad', '--value', 'true'],
  ['issue', 'metadata', 'set', 'MUL-1', '--key', 'ok', '--value', 'false', '--type', 'number'],
  ['issue', 'comment', 'update', ids.comment, '--content', 'X'],
  ['issue', 'subscriber', 'add', 'MUL-1', '--user', 'Howard', '--user-id', ids.member],
  ['issue', 'property', 'set', 'MUL-1', '--name', 'Severity'],
  ['workspace', 'create', '--name', 'X'], ['workspace', 'update'],
  ['workspace', 'member', 'invite', 'friend@example.com', '--role', 'owner'],
  ['workspace', 'create', '--name', 'A', '--slug', 'a', '--description-stdin', '--context-stdin'],
];
for (const args of rejects) test(`reject before network: ${args.join(' ')}`, async () => {
  const h = fixture();
  await assert.rejects(runBusinessCLI({ ...config, workspace_id: undefined, workspace_slug: 'workspace' }, args, h.dependencies));
  assert.equal(h.calls.length, 0);
});

test('run suppression requires explicit opt-in for status/update/assign', async () => {
  for (const args of [['issue', 'status', 'MUL-1', 'done'], ['issue', 'update', 'MUL-1', '--title', 'X'], ['issue', 'assign', 'MUL-1', '--to', 'Piper']]) {
    for (const start of [false, true]) {
      const h = fixture(); await h.run([...args, ...(start ? ['--start'] : [])]);
      assert.equal(h.calls.find((call) => call.method === 'PUT').body.suppress_run, !start);
    }
  }
});

test('unknown/ambiguous actor and property values never mutate', async () => {
  for (const args of [['issue', 'assign', 'MUL-1', '--to', 'Nobody'], ['issue', 'property', 'set', 'MUL-1', '--name', 'Severity', '--value', 'Unknown']]) {
    const h = fixture(); await assert.rejects(h.run(args));
    assert.equal(h.calls.filter((call) => call.method !== 'GET').length, 0);
  }
});

test('chat thread uses its task token and bounded query', async () => {
  const h = fixture(); await h.run(['chat', 'thread', 'thread-1', '--task', ids.run, '--limit', '5', '--before', 'cursor']);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].token, 'fixture-task-token');
  assert.equal(h.calls[0].endpoint, '/api/chat/thread?id=thread-1&limit=5&before=cursor');
});

test('timeline preserves truncation warning and applies filters before tail', async () => {
  const h = fixture(); h.state.timeline = [
    { type: 'activity', action: 'status_changed', created_at: '2026-01-01T00:00:00Z', id: 'old' },
    { type: 'comment', created_at: '2026-01-02T00:00:00Z', id: 'comment' },
    { type: 'activity', action: 'status_changed', created_at: '2026-01-03T00:00:00Z', id: 'new' },
  ];
  const result = await h.run(['issue', 'timeline', 'MUL-1', '--action', 'status_changed', '--since', '2026-01-01T00:00:00Z', '--tail', '1']);
  assert.deepEqual(result.map((row) => row.id), ['new']); assert.match(h.errors(), /truncated/);
  assert.equal(h.calls.at(-1).endpoint, `/api/issues/${ids.issue}/timeline`);
});

test('multipart upload writes once with task binding and readback; external paths reject', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-upload-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'report.txt'), 'report bytes');
  const h = fixture(); h.dependencies.cwd = cwd;
  const result = await h.run(['attachment', 'upload', 'report.txt', '--task', ids.run]);
  assert.equal(result.id, 'attachment-1');
  const readback = await h.dependencies.request(config, 'GET', '/api/attachments/attachment-1');
  assert.equal(readback.bytes, 'report bytes');
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1);
  fs.symlinkSync('/etc/hosts', path.join(cwd, 'outside'));
  h.calls.length = 0;
  await assert.rejects(h.run(['attachment', 'upload', 'outside', '--task', ids.run]), /outside/);
  assert.equal(h.calls.length, 0);
});

test('resource optional fields clear while required reference fields survive readback', async () => {
  const h = fixture();
  h.state.resource.resource_ref.default_branch_hint = 'main';
  await h.run(['project', 'resource', 'update', ids.project, ids.resource, '--default-branch-hint', '', '--ref', '']);
  const rows = await h.run(['project', 'resource', 'list', ids.project]);
  assert.deepEqual(rows[0].resource_ref, { url: 'https://github.com/example/repo' });
  assert.equal(h.calls.filter((call) => call.method === 'PUT').length, 1);
});

test('resource shortcuts reject the wrong type before mutation', async () => {
  const h = fixture();
  await assert.rejects(h.run(['project', 'resource', 'update', ids.project, ids.resource, '--local-path', '/work']), /resource type/);
  assert.ok(h.calls.every((call) => call.method === 'GET'));
});

test('archived property rejects before mutation and unset returns acknowledgment', async () => {
  const h = fixture(); h.state.property.archived = true;
  await assert.rejects(h.run(['issue', 'property', 'set', 'MUL-1', '--name', 'Severity', '--value', 'Major']), /archived/);
  assert.ok(h.calls.every((call) => call.method === 'GET'));
  assert.deepEqual(await h.run(['issue', 'property', 'unset', 'MUL-1', '--name', 'Severity']), { deleted: true });
});

test('write response loss is never automatically retried', async () => {
  const h = fixture(), original = h.dependencies.request;
  h.dependencies.request = async (...args) => { if (args[1] !== 'GET') { await original(...args); throw new Error('response lost'); } return original(...args); };
  await assert.rejects(h.run(['issue', 'status', 'MUL-1', 'done']), /response lost/);
  assert.equal(h.calls.filter((call) => call.method === 'PUT').length, 1);
  assert.equal((await h.run(['issue', 'get', 'MUL-1'])).status, 'done');
});

if (!process.env.MULTICA_MUTANT_CHILD) test('known-bad mutants: missing suppression and disabled validation are detected', (t) => {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const [name, from, to] of [
    ['run-suppression', 'suppress_run: suppress', 'suppress_run: false'],
    ['validation', "if (!choices.includes(item)) throw new Error", 'if (false) throw new Error'],
    ['option-ids', '...(old ? { id: old.id } : {})', '...{}'],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `multica-mutant-${name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.cpSync(path.join(sourceRoot, 'src'), path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'test')); fs.copyFileSync(fileURLToPath(import.meta.url), path.join(root, 'test/business-commands.test.js'));
    fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const file = path.join(root, 'src/lib/business-commands.js'), text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes(from), `${name} mutation anchor exists`); fs.writeFileSync(file, text.replace(from, to));
    const env = { ...process.env, MULTICA_MUTANT_CHILD: '1' };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', 'test/business-commands.test.js'], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${name} must fail behavioral tests`);
    assert.match(result.stdout, /not ok/, `${name} failure must be a behavioral assertion`);
  }
});
