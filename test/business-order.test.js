import assert from 'node:assert/strict';
import test from 'node:test';
import { runBusinessCLI } from '../src/lib/business-cli.js';

const id = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const workspace = '30000000-0000-4000-8000-000000000003';
const config = { base_url: 'https://fixture.invalid', workspace_id: workspace, pat: 'fixture-pat' };
function harness({ repeated = false, missing = false, empty = false } = {}) {
  const calls = [];
  const issue = { id, status: 'todo', project_id: 'project', position: 1 };
  const run = (args) => runBusinessCLI({ ...config }, args, {
    stdout: { write() {} }, stderr: { write() {} },
    ensureWorkspaceResolved: async () => {},
    request: async (_config, method, endpoint, body) => {
      calls.push({ method, endpoint, body });
      const url = new URL(endpoint, config.base_url);
      if (url.pathname === `/api/issues/${other}`) return { id: other, status: 'todo', project_id: 'project', position: 10 };
      if (url.pathname === `/api/issues/${id}/wakeups`) return [{ id: 'wake', kind: 'event' }];
      if (url.pathname === `/api/issues/${id}/wakeups/wake/runs`) return [{ id: 'run' }];
      if (url.pathname === `/api/issues/${id}`) {
        if (method === 'PUT') Object.assign(issue, body);
        return { ...issue };
      }
      if (url.pathname === '/api/issues') {
        assert.equal(url.searchParams.get('project_id'), 'project');
        assert.equal(url.searchParams.get('sort'), 'position');
        assert.equal(url.searchParams.get('limit'), '100');
        const offset = Number(url.searchParams.get('offset'));
        const rows = missing ? [{ id: other, position: 10 }] : empty ? [issue] : [issue, { id: other, position: 10 }];
        return { issues: repeated || offset === 0 ? rows : [], total: rows.length };
      }
      throw new Error(`unexpected ${endpoint}`);
    },
  });
  return { calls, run };
}

test('reorder reads through unreliable totals and writes a suppressed position once', async () => {
  const h = harness();
  const result = await h.run(['issue', 'reorder', id, '--bottom']);
  assert.equal(result.position, 11);
  assert.equal(h.calls.filter((call) => call.endpoint.startsWith('/api/issues?')).length, 2);
  assert.deepEqual(h.calls.filter((call) => call.method === 'PUT').map((call) => call.body), [{ position: 11, suppress_run: true }]);
  assert.equal((await h.run(['issue', 'get', id])).position, 11);
});
for (const mode of ['top', 'before', 'after']) test(`reorder ${mode} computes neighbour position`, async () => {
  const h = harness();
  const result = await h.run(['issue', 'reorder', id, `--${mode}`, ...(['before', 'after'].includes(mode) ? [other] : [])]);
  assert.equal(result.position, mode === 'after' ? 11 : 9);
});
for (const options of [{ repeated: true }, { missing: true }]) test(`reorder rejects unstable column ${JSON.stringify(options)}`, async () => {
  const h = harness(options);
  await assert.rejects(h.run(['issue', 'reorder', id, '--bottom']), /column|repeated/);
  assert.ok(h.calls.every((call) => call.method === 'GET'));
});
test('single issue reorder is a no-op', async () => {
  const h = harness({ empty: true });
  assert.equal((await h.run(['issue', 'reorder', id, '--top'])).position, 1);
  assert.ok(h.calls.every((call) => call.method === 'GET'));
});
for (const flags of [[], ['--top', '--bottom'], ['--top=false'], ['--before', ''], ['--before', id]]) {
  test(`invalid reorder does not write ${JSON.stringify(flags)}`, async () => {
    const h = harness();
    await assert.rejects(h.run(['issue', 'reorder', id, ...flags]));
    assert.ok(h.calls.every((call) => call.method === 'GET'));
  });
}
test('wakeup list/get/runs query exact paths and missing wakeup fails', async () => {
  const h = harness();
  assert.deepEqual(await h.run(['issue', 'wakeup', 'list', id]), [{ id: 'wake', kind: 'event' }]);
  assert.equal((await h.run(['issue', 'wakeup', 'get', id, 'wake'])).kind, 'event');
  assert.deepEqual(await h.run(['issue', 'wakeup', 'runs', id, 'wake']), [{ id: 'run' }]);
  await assert.rejects(h.run(['issue', 'wakeup', 'get', id, 'absent']), /not found/);
  assert.ok(h.calls.every((call) => call.method === 'GET'));
});

test('workspace references accept exact slug and compact UUID prefix, reject name/substring', async () => {
  const calls = [];
  const run = (ref) => runBusinessCLI({ ...config }, ['workspace', 'get', ref], {
    stdout: { write() {} }, request: async (_config, method, endpoint) => {
      calls.push({ method, endpoint });
      return endpoint === '/api/workspaces' ? [{ id: workspace, slug: 'workspace', name: 'Friendly name' }] : { id: workspace };
    },
  });
  assert.equal((await run('WORKSPACE')).id, workspace);
  assert.equal((await run('300000000000')).id, workspace);
  await assert.rejects(run('space'), /not found/);
  await assert.rejects(run('Friendly name'), /not found/);
});
test('workspace invitation normalizes role and email', async () => {
  const calls = [];
  await runBusinessCLI({ ...config }, ['workspace', 'member', 'invite', ' Friend@Example.COM ', '--role', ' ADMIN '], {
    ensureWorkspaceResolved: async () => {},
    stdout: { write() {} }, request: async (_config, method, endpoint, body) => { calls.push({ method, endpoint, body }); return body; },
  });
  assert.deepEqual(calls[0].body, { email: 'friend@example.com', role: 'admin' });
});
