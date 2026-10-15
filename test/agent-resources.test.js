import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import { createTaskState } from '../src/lib/task-state.js';
import { createTaskDispatcher } from '../src/lib/task-dispatch.js';
import { storeTaskContext } from '../src/lib/task-context.js';
import { buildTaskCard } from '../src/lib/cards.js';
import { finishAbandonment, inspectLegacyExecution } from '../src/lib/agent-execution.js';
import { reportFromCLI } from '../src/lib/task-report.js';

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multica-agent-owned-')));
  const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' };
  const task = { id: 'task', issue_id: 'issue', agent_id: 'agent', runtime_id: 'runtime', workspace_id: 'workspace', dispatched_at: '2026-10-15T01:02:03.123456Z' };
  let remote = { ...task, status: 'dispatched' }, failStart = false, loseReport = false;
  const calls = [];
  const request = async (_config, method, route, body) => {
    calls.push({ method, route, body });
    if (method === 'GET') return [remote];
    if (route.endsWith('/start')) {
      if (failStart) throw Error('lost start');
      if (!['dispatched', 'running'].includes(remote.status)) throw Object.assign(Error('terminal'), { status: 409 });
      assert.equal(body.dispatched_at, task.dispatched_at); remote.status = 'running';
    } else {
      Object.assign(remote, body, { status: route.endsWith('/complete') ? 'completed' : 'failed', result: body });
      if (loseReport) throw Error('lost report');
    }
    return { ...remote };
  };
  const options = { root: path.join(root, 'state'), request, removeTaskToken() {} };
  const state = createTaskState(config, options);
  const delivered = [];
  const dispatcher = () => createTaskDispatcher(config, { state, root: path.join(root, 'dispatch'),
    snapshot: async task => ({ task, context: storeTaskContext(task, config, path.join(root, 'context')) }),
    render: entry => buildTaskCard({ ...entry.task, execution_generation: entry.generation }, {}, entry.context),
    deliver: async delivery => { delivered.push(delivery); return true; } });
  return { root, config, task, options, state, calls, delivered, dispatcher,
    failStart(value) { failStart = value; }, loseReport(value) { loseReport = value; }, cancel() { remote.status = 'cancelled'; } };
}

test('complete resource metadata and task paths survive context and card; path-only context is materialized', () => {
  const f = fixture();
  const task = { ...f.task, repos: [{ url: 'https://private.example/repo', ref: 'feature/a', description: 'private', future_field: 'preserve' }],
    project_resources: [{ id: 'r', resource_type: 'local_directory', label: 'repo', resource_ref: { local_path: '/existing/path', branch: 'branch', nested: { value: 1 } } }],
    prior_work_dir: '/prior', work_dir: '/work', relative_work_dir: 'sub', branch_name: 'source' };
  const context = storeTaskContext(task, f.config, path.join(f.root, 'context'));
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(context.index), 'manifest.json')));
  for (const key of ['repos', 'project_resources', 'prior_work_dir', 'work_dir', 'relative_work_dir', 'branch_name']) assert.deepEqual(manifest[key], task[key]);
  assert.match(buildTaskCard(task, {}, context), /not prepared or verified locally/);
  assert.ok(storeTaskContext({ ...f.task, prior_work_dir: '/only' }, f.config, path.join(f.root, 'context')));
});

test('Git trap positive control detects Git; dispatcher never executes it for inaccessible private resources', async () => {
  const f = fixture(), bin = path.join(f.root, 'bin'), marker = path.join(f.root, 'git-called'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho called >> '${marker}'\nexit 91\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try {
    assert.equal(spawnSync('git', ['status']).status, 91);
    const control = fs.readFileSync(marker, 'utf8');
    const d = f.dispatcher(); await d.enqueue({ ...f.task, repos: [{ url: 'https://private.invalid/no-credentials', ref: 'main' }] }); await d.drain();
    const record = f.state.get(f.task.id);
    assert.equal(record.delivery.delivered, true);
    assert.equal(await f.state.markAccepted(f.task.id, record.generation), true);
    assert.equal(await f.state.markAccepted(f.task.id, record.generation), false);
    await f.state.acknowledgeStopped(f.task.id, record.generation, { work_dir: '/agent/chosen', branch_name: 'agent-branch', pr_url: 'https://example.test/pr/1' });
    await reportFromCLI(f.config, `${f.task.id}@${record.generation}`, 'complete', 'done', f.options);
    d.resume(); await d.drain();
    assert.equal(f.delivered.length, 1);
    assert.equal(fs.readFileSync(marker, 'utf8'), control);
  } finally { process.env.PATH = oldPath; }
});

test('Agent stop acknowledgement is required; failure excludes unsupported PR metadata and preserves chosen directory', async () => {
  const f = fixture(); const { generation } = await f.state.registerClaim(f.task);
  await f.state.start(f.task.id, generation); await f.state.markAccepted(f.task.id, generation);
  await assert.rejects(reportFromCLI(f.config, `task@${generation}`, 'fail', 'no access', f.options), /stopped execution/);
  await f.state.acknowledgeStopped(f.task.id, generation, { work_dir: '/chosen', branch_name: 'branch', pr_url: 'https://example.test/pr/1' });
  const result = await reportFromCLI(f.config, `task@${generation}`, 'fail', 'no access', f.options);
  assert.equal(result.report.state, 'confirmed');
  assert.deepEqual(f.calls.find(call => call.route.endsWith('/fail')).body, { error: 'no access', work_dir: '/chosen', branch_name: 'branch' });
});

test('old frozen card is retained and replaced, while accepted work is never redelivered', async () => {
  const f = fixture(); const { generation } = await f.state.registerClaim(f.task);
  await f.state.setDelivery('task', generation, { content: 'OLD mandatory binding/exec', endpoint: `task@${generation}` });
  const d = f.dispatcher(); await d.enqueue(f.task); await d.drain();
  const record = f.state.get('task');
  assert.equal(record.delivery_history[0].content, 'OLD mandatory binding/exec');
  assert.match(record.delivery.content, /Agent|your own tools/);
  assert.doesNotMatch(record.delivery.content, /OLD mandatory/);
  await f.state.markAccepted('task', generation); d.resume(); await d.drain();
  assert.equal(f.delivered.length, 1);
});

test('legacy inspection preserves every record and artifact without deriving new metadata', () => {
  const f = fixture(), root = path.join(f.root, 'legacy'); fs.mkdirSync(path.join(root, 'bindings'), { recursive: true });
  const key = createHash('sha256').update(JSON.stringify([f.config.base_url, f.config.workspace_id, 'task'])).digest('hex');
  const file = path.join(root, 'bindings', `${key}.json`), bytes = '{"bindings":[{"cwd":"/old","branch":"old"}],"phase":"prepared"}\n';
  fs.writeFileSync(file, bytes);
  assert.equal(inspectLegacyExecution(f.config, 'task', root).binding.phase, 'prepared');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('abandon rejects stale/started work, freezes reason and reconciles lost failure without duplicate POST', async () => {
  const f = fixture(); const { generation } = await f.state.registerClaim(f.task); f.loseReport(true);
  await assert.rejects(finishAbandonment(f.state, 'task', 'stale', 'stop'), /stale/);
  const result = await finishAbandonment(f.state, 'task', generation, 'stop');
  assert.equal(result.report.state, 'confirmed');
  await finishAbandonment(f.state, 'task', generation, 'stop');
  await assert.rejects(finishAbandonment(f.state, 'task', generation, 'different'), /frozen/);
  await assert.rejects(f.state.markAccepted('task', generation), /frozen|quiesced/);
  assert.equal(f.calls.filter(call => call.route.endsWith('/fail')).length, 1);
  const g = fixture(); const r = await g.state.registerClaim(g.task); await g.state.start('task', r.generation);
  await assert.rejects(finishAbandonment(g.state, 'task', r.generation, 'late'), /unstarted/);
});

test('abandon without snapshot resumes durable intent after lost start', async () => {
  const f = fixture(); const { generation } = await f.state.registerClaim(f.task); f.failStart(true);
  await assert.rejects(finishAbandonment(f.state, 'task', generation, 'stop'), /lost start/);
  f.failStart(false); const d = f.dispatcher(); d.resume(); await d.drain();
  assert.equal(f.state.get('task').report.state, 'confirmed');
  assert.equal(f.delivered.length, 0);
});

test('concurrent original start and abandon still have one admission winner', async () => {
  const f = fixture(); const { generation } = await f.state.registerClaim(f.task);
  const results = await Promise.allSettled([f.state.start('task', generation), finishAbandonment(f.state, 'task', generation, 'stop')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('legacy terminal preparation snapshot decision cannot become delivered business work', async () => {
  const f = fixture(); const { generation } = await f.state.registerClaim(f.task);
  const scope = `${new URL(f.config.base_url).origin}|${f.config.workspace_id}`;
  const root = path.join(f.root, 'dispatch'); fs.mkdirSync(root);
  const name = createHash('sha256').update(`${scope}|task`).digest('hex');
  fs.writeFileSync(path.join(root, `${name}.json`), JSON.stringify({ scope, task: f.task, generation,
    prepared: false, preparationRetry: { terminal: true, error: 'preparation failed: authentication denied (1 attempt)' } }));
  const d = f.dispatcher(); d.resume(); await d.drain();
  assert.equal(f.state.get('task').report.state, 'confirmed');
  assert.match(f.state.get('task').report.payload.error, /authentication denied/);
  assert.equal(f.delivered.length, 0);
});

test('real task CLI begin/quiesce/fail round trip requires stopped flag, preserves metadata, and never invokes Git', async t => {
  const f = fixture(), home = path.join(f.root, 'home'), bin = path.join(f.root, 'bin'); fs.mkdirSync(bin);
  const trap = path.join(f.root, 'git-trap'); fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\necho called >> '${trap}'\nexit 91\n`, { mode: 0o755 });
  let remote = { ...f.task, status: 'dispatched' };
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    if (req.url.endsWith('/start')) { assert.equal(JSON.parse(text).dispatched_at, f.task.dispatched_at); remote.status = 'running'; }
    if (req.url.endsWith('/fail')) Object.assign(remote, JSON.parse(text), { status: 'failed' });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(remote));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const config = { ...f.config, base_url: `http://127.0.0.1:${server.address().port}`, pat: 'fixture', runtime_name: 'test' };
  const data = path.join(home, 'zylos/components/multica'); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  const state = createTaskState(config, { root: path.join(data, 'task-state'), removeTaskToken() {} });
  const record = await state.registerClaim(f.task), endpoint = `task@${record.generation}`;
  const cli = (script, args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`scripts/${script}.js`, ...args], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
  let result = await cli('task', ['begin', endpoint]); assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).accepted, true);
  result = await cli('task', ['begin', endpoint]); assert.equal(JSON.parse(result.stdout).accepted, false);
  assert.equal((await cli('task', ['quiesce', endpoint])).code, 1);
  result = await cli('task', ['quiesce', endpoint, '--stopped', '--work-dir', '/agent/path', '--branch', 'agent', '--pr-url', 'https://example.test/pr/1']); assert.equal(result.code, 0, result.stderr);
  result = await cli('report', ['fail', endpoint, 'access unavailable']); assert.equal(result.code, 0, result.stderr);
  assert.equal(remote.work_dir, '/agent/path'); assert.equal(remote.branch_name, 'agent'); assert.equal(remote.pr_url, undefined);
  assert.equal(fs.existsSync(trap), false);
});

test('legacy operation requires explicit stop acknowledgement, retains markers, and resumes acknowledgement after restart', async () => {
  const f = fixture(); const { generation } = await f.state.registerClaim(f.task);
  const legacyRoot = path.join(f.root, 'legacy'), dir = path.join(legacyRoot, 'operations'); fs.mkdirSync(dir, { recursive: true });
  const key = createHash('sha256').update(JSON.stringify([f.config.base_url, f.config.workspace_id, 'task'])).digest('hex');
  const marker = path.join(dir, `${key}.json`), bytes = JSON.stringify({ task: key, generation }); fs.writeFileSync(marker, bytes);
  const options = { config: f.config, legacyRoot };
  await assert.rejects(finishAbandonment(f.state, 'task', generation, 'stop', options), /stop is unconfirmed/);
  assert.equal(f.calls.length, 0);
  f.failStart(true);
  await assert.rejects(finishAbandonment(f.state, 'task', generation, 'stop', { ...options, acknowledgedStopped: true }), /lost start/);
  f.failStart(false);
  const restarted = createTaskState(f.config, f.options);
  assert.equal((await finishAbandonment(restarted, 'task', generation, 'stop', options)).report.state, 'confirmed');
  assert.equal(fs.readFileSync(marker, 'utf8'), bytes);
});
