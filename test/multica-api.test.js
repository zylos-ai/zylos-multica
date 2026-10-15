import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { multicaRequest } from '../src/lib/multica-api.js';

test('request optionally exposes pagination headers without changing ordinary JSON return', async t => {
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private');
    assert.equal(req.headers['x-workspace-id'], 'ws');
    res.setHeader('X-Agent-Tasks-Next-Cursor', 'opaque+/=');
    res.setHeader('Content-Type', 'application/json');
    res.end('[{"id":"task"}]');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { base_url: `http://127.0.0.1:${server.address().port}`, pat: 'private', workspace_id: 'ws' };
  assert.deepEqual(await multicaRequest(config, 'GET', '/history', undefined, { workspaceHeader: true }), [{ id: 'task' }]);
  const page = await multicaRequest(config, 'GET', '/history', undefined, { workspaceHeader: true, includeHeaders: true });
  assert.deepEqual(page.data, [{ id: 'task' }]);
  assert.equal(page.headers['x-agent-tasks-next-cursor'], 'opaque+/=');
});
