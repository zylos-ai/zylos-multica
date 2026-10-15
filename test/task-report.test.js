import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { createTaskState } from '../src/lib/task-state.js';
import { reportFromCLI } from '../src/lib/task-report.js';

test('plain terminal endpoint remains usable for legacy tasks but rejects a bound task', async t => {
  const calls = [], removed = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ route: req.url, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json'); res.end('{"status":"completed"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { base_url: `http://127.0.0.1:${server.address().port}`, workspace_id: 'ws', daemon_id: 'daemon', pat: 'fixture' };
  const options = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'multica-report-')), removeTaskToken: id => removed.push(id) };
  await reportFromCLI(config, 'legacy', 'complete', 'done', options);
  assert.deepEqual(calls, [{ route: '/api/daemon/tasks/legacy/complete', body: { output: 'done' } }]);
  assert.deepEqual(removed, ['legacy']);
  await createTaskState(config, options).registerClaim({ id: 'bound', workspace_id: 'ws', runtime_id: 'runtime', agent_id: 'agent', dispatched_at: '2026-10-15T01:02:03.123456Z' });
  await assert.rejects(reportFromCLI(config, 'bound', 'complete', 'wrong', options), /Bound task reporting requires/);
  assert.equal(calls.length, 1);
});

test('single binding reports work directory and branch without claiming a replacement durable directory', async () => {
  const config = { base_url: 'https://example.test', workspace_id: 'ws', daemon_id: 'daemon' };
  const task = { id: 'bound', workspace_id: 'ws', runtime_id: 'runtime', agent_id: 'agent', dispatched_at: '2026-10-15T01:02:03.123456Z' };
  const calls = [];
  const options = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'multica-report-')), removeTaskToken() {},
    executionMetadata: () => ({ bindings: [{ cwd: '/fixture/worktree', branch: 'task-branch' }] }),
    request: async (_config, _method, route, body) => {
      calls.push({ route, body });
      return route.endsWith('/start') ? { ...task, status: 'running' } : { ...task, status: 'completed', result: body, ...body };
    },
  };
  const state = createTaskState(config, options);
  const { generation } = await state.registerClaim(task);
  await state.start(task.id, generation); await state.markAccepted(task.id, generation); await state.markQuiesced(task.id, generation);
  const result = await reportFromCLI(config, `bound@${generation}`, 'complete', 'done', options);
  assert.equal(result.report.state, 'confirmed');
  const body = calls.find(call => call.route.endsWith('/complete')).body;
  assert.equal(body.work_dir, '/fixture/worktree'); assert.equal(body.branch_name, 'task-branch');
  assert.equal(Object.hasOwn(body, 'durable_work_dir'), false);
});
