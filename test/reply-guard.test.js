import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createTaskState } from '../src/lib/task-state.js';
import { createReplyGuard } from '../src/lib/reply-guard.js';
import { reportFromCLI } from '../src/lib/task-report.js';
import { runBusinessCLI } from '../src/lib/business-cli.js';
import { loadTaskReplyContext, storeTaskToken } from '../src/lib/task-tokens.js';

async function fixture(context = { issue_id: 'issue' }) {
  const config = { base_url: 'https://example.test', workspace_slug: 'ws', workspace_id: 'ws', daemon_id: 'daemon', pat: 'fixture' };
  const task = { id: 'task', workspace_id: 'ws', runtime_id: 'runtime', agent_id: 'agent',
    dispatched_at: '2026-10-15T01:02:03.123456Z', ...context };
  const calls = [], removed = [];
  const options = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'multica-reply-')), stdout: { write() {} },
    loadTaskToken: () => 'mat_fixture', removeTaskToken: id => removed.push(id),
    request: async (_config, method, route, body) => {
      calls.push({ method, route, body });
      if (route.endsWith('/comments')) return { id: 'comment' };
      if (route === '/api/issues/MUL-1') return { id: 'issue' };
      return route.endsWith('/start') ? { ...task, status: 'running' } : { ...task, status: 'completed', result: body, ...body };
    },
  };
  const state = createTaskState(config, options);
  const { generation } = await state.registerClaim(task);
  await state.start(task.id, generation); await state.markAccepted(task.id, generation);
  const endpoint = `${task.id}@${generation}`;
  const comment = (extra = {}) => runBusinessCLI(config,
    ['issue', 'comment', 'add', 'MUL-1', '--task', task.id, '--content', 'Full result'], { ...options, ...extra });
  const stop = () => state.acknowledgeStopped(task.id, generation);
  const complete = (text, extra = {}) => reportFromCLI(config, endpoint, 'complete', text, { ...options, ...extra });
  return { config, options, task, state, generation, endpoint, calls, removed, comment, complete, stop };
}

test('mention rejection precedes terminal freeze, POST and token cleanup; explicit acknowledgment cannot bypass it', async () => {
  const f = await fixture(); await f.stop();
  for (const contentAlreadyPosted of [false, true]) {
    await assert.rejects(f.complete('[Agent](mention://agent/id)', { contentAlreadyPosted }), /Final reply mentions/);
    assert.equal(f.state.get('task').report, null);
    assert.equal(f.calls.filter(c => c.route.endsWith('/complete')).length, 0);
    assert.deepEqual(f.removed, []);
  }
  assert.equal((await f.complete('Full result')).report.state, 'confirmed');
});

test('saved comment survives helper recreation; plain final rejects, explicit posted acknowledgment completes', async () => {
  const f = await fixture(); await f.comment(); await f.stop();
  await assert.rejects(f.complete('Important result that would be dropped'), /already posted a comment/);
  assert.equal(f.state.get('task').report, null);
  assert.deepEqual(f.removed, []);
  const result = await f.complete('Result posted on the issue', { contentAlreadyPosted: true });
  assert.equal(result.report.state, 'confirmed');
  assert.equal(f.calls.filter(c => c.route.endsWith('/comments')).length, 1);
  assert.equal(f.calls.find(c => c.route.endsWith('/complete')).body.output, 'Result posted on the issue');
  assert.deepEqual(f.removed, ['task']);
  await assert.rejects(f.comment(), /frozen report/);
});

test('disk failure prevents comment POST; a lost response persists uncertain completion protection without retry', async () => {
  const f = await fixture();
  await assert.rejects(f.comment({ replyWrite() { throw new Error('disk full'); } }), /disk full/);
  assert.equal(f.calls.filter(c => c.route.endsWith('/comments')).length, 0);
  let posts = 0;
  await assert.rejects(f.comment({ request: async (...args) => {
    if (args[1] === 'POST') { posts++; throw new Error('response lost'); }
    return { id: 'issue' };
  } }), /response lost/);
  assert.equal(posts, 1);
  await f.stop();
  await assert.rejects(f.complete('Final'), /outcome is uncertain/);
  assert.equal(f.state.get('task').report, null);
  assert.equal((await f.complete('Read back result on the issue', { contentAlreadyPosted: true })).report.state, 'confirmed');
});

test('known chats preserve assistant text with mention URIs; tokens retain only reply context fields', async () => {
  const f = await fixture({ chat_session_id: 'chat' }); await f.stop();
  assert.equal((await f.complete('Discuss mention://agent/id')).report.state, 'confirmed');
  const tokenDir = path.join(f.options.root, 'tokens');
  storeTaskToken('legacy', 'mat_fixture', tokenDir, { issue_id: 'issue', ignored: 'private' });
  assert.deepEqual(loadTaskReplyContext('legacy', tokenDir), { issue_id: 'issue' });
  assert.deepEqual(loadTaskReplyContext('missing', tokenDir), {});
});

test('guard identity isolates run, task, workspace and origin; state contains no body or token', async () => {
  const f = await fixture();
  const guard = createReplyGuard(f.config, f.options);
  await guard.run('task', 'run1', { issue_id: 'issue' }, g => g.beforeComment());
  await assert.rejects(guard.run('task', 'run1', {}, g => g.assertComplete('result')), /already posted/);
  for (const [config, taskId, generation] of [
    [f.config, 'task', 'run2'], [f.config, 'other', 'run1'],
    [{ ...f.config, workspace_id: 'other' }, 'task', 'run1'],
    [{ ...f.config, base_url: 'https://other.test' }, 'task', 'run1'],
  ]) await createReplyGuard(config, f.options).run(taskId, generation, {}, g => g.assertComplete('result'));
  for (const file of fs.readdirSync(path.join(f.options.root, 'reply-guard')).filter(n => n.endsWith('.json'))) {
    const body = fs.readFileSync(path.join(f.options.root, 'reply-guard', file), 'utf8');
    assert.doesNotMatch(body, /mat_fixture|Full result|auth_token/);
    assert.equal(fs.statSync(path.join(f.options.root, 'reply-guard', file)).mode & 0o777, 0o600);
  }
});

test('comment issue must match the bound task and a chat task cannot comment as an issue task', async () => {
  for (const context of [{ issue_id: 'other' }, { chat_session_id: 'chat' }]) {
    const f = await fixture(context);
    await assert.rejects(f.comment(), /does not match/);
    assert.equal(f.calls.filter(c => c.method === 'POST' && c.route.endsWith('/comments')).length, 0);
  }
});

test('concurrent completion waits for an in-flight comment and rejects its ordinary final', async () => {
  const f = await fixture();
  let release, entered;
  const posted = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const comment = f.comment({ request: async (_c, method) => {
    if (method !== 'POST') return { id: 'issue' };
    entered(); await response; return { id: 'comment' };
  } });
  await posted; await f.stop();
  const completion = assert.rejects(f.complete('Dropped final'), /already posted/);
  release(); await comment; await completion;
  assert.equal(f.calls.filter(c => c.route.endsWith('/complete')).length, 0);
});

test('legacy completion intent blocks a late comment even if the completion response is lost', async () => {
  const f = await fixture();
  await createReplyGuard(f.config, f.options).run('legacy', undefined, {}, g => g.freezeLegacyCompletion());
  await assert.rejects(runBusinessCLI(f.config,
    ['issue', 'comment', 'add', 'MUL-1', '--task', 'legacy', '--content', 'late'], f.options), /completion already started/);
  assert.equal(f.calls.filter(c => c.route.endsWith('/comments')).length, 0);
});

test('frozen completion payload remains authoritative during reconciliation', async () => {
  const f = await fixture(); await f.stop(); await f.complete('Original result');
  const before = f.state.get('task').report.payload;
  await assert.rejects(f.complete('Different mention://agent/id'), /conflicts with frozen report/);
  const reconciled = await reportFromCLI(f.config, f.endpoint, 'reconcile', '', f.options);
  assert.equal(reconciled.report.state, 'confirmed');
  assert.deepEqual(reconciled.report.payload, before);
  assert.equal(f.calls.filter(c => c.route.endsWith('/complete')).length, 1);
});

test('known-bad guard removal is detected by the same reject assertions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-guard-mutant-'));
  fs.cpSync(new URL('../src', import.meta.url), path.join(root, 'src'), { recursive: true });
  const file = path.join(root, 'src/lib/reply-guard.js');
  const source = fs.readFileSync(file, 'utf8');
  const mutant = source.replace("if (text.includes('mention://'))", 'if (false)')
    .replace('if (record.comment_state && !contentAlreadyPosted)', 'if (false)');
  assert.notEqual(mutant, source); fs.writeFileSync(file, mutant);
  const { createReplyGuard: createMutant } = await import(pathToFileURL(file));
  const config = { base_url: 'https://example.test', workspace_id: 'ws' };
  const guard = createMutant(config, { root });
  await assert.rejects(assert.rejects(guard.run('task', 'run', {}, g => g.assertComplete('mention://agent/id')), /Final reply mentions/), /Missing expected rejection/);
  await guard.run('task', 'run', {}, g => g.commentSaved());
  await assert.rejects(assert.rejects(guard.run('task', 'run', {}, g => g.assertComplete('result')), /already posted/), /Missing expected rejection/);
});

test('real CLI rejects unsafe finals across processes then completes through complete-posted', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-reply-cli-'));
  const data = path.join(home, 'zylos/components/multica'); fs.mkdirSync(data, { recursive: true });
  const task = { id: 'task', issue_id: 'issue', agent_id: 'agent', runtime_id: 'runtime', workspace_id: 'ws',
    dispatched_at: '2026-10-15T01:02:03.123456Z' };
  let remote = { ...task, status: 'dispatched' }, completes = 0, comments = 0;
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    let result;
    if (req.url === '/api/workspaces') result = [{ id: 'ws', slug: 'ws' }];
    else if (req.url === '/api/issues/MUL-1') result = { id: 'issue' };
    else if (req.url.endsWith('/comments')) { comments++; result = { id: 'comment' }; }
    else {
      if (req.url.endsWith('/start')) remote.status = 'running';
      if (req.url.endsWith('/complete')) { completes++; remote = { ...remote, status: 'completed', result: JSON.parse(text) }; }
      result = req.method === 'GET' ? [remote] : remote;
    }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = { base_url: `http://127.0.0.1:${server.address().port}`, workspace_slug: 'ws', workspace_id: 'ws', daemon_id: 'daemon', pat: 'fixture', runtime_name: 'test' };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  storeTaskToken('task', 'mat_fixture', path.join(data, 'task-tokens'), task);
  const state = createTaskState(config, { root: path.join(data, 'task-state') });
  const { generation } = await state.registerClaim(task); await state.start('task', generation); await state.markAccepted('task', generation);
  const endpoint = `task@${generation}`;
  const cli = (script, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}.js`, ...args], {
      cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HOME: home },
    });
    let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  let result = await cli('send', [endpoint, 'mention://agent/id']);
  assert.equal(result.code, 1); assert.match(result.stderr, /Final reply mentions/); assert.equal(completes, 0);
  result = await cli('multica', ['issue', 'comment', 'add', 'MUL-1', '--task', 'task', '--content', 'Full result']);
  assert.equal(result.code, 0, result.stderr); assert.equal(comments, 1);
  await state.acknowledgeStopped('task', generation);
  result = await cli('send', [endpoint, 'Dropped result']);
  assert.equal(result.code, 1); assert.match(result.stderr, /already posted/); assert.equal(completes, 0);
  result = await cli('report', ['complete-posted', endpoint, 'Result on the issue']);
  assert.equal(result.code, 0, result.stderr); assert.equal(completes, 1); assert.equal(comments, 1);
  assert.equal(remote.result.output, 'Result on the issue');
});
