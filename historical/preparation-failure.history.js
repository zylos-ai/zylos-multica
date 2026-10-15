import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import { createTaskState, atomicTaskWrite } from '../src/lib/task-state.js';
import { createWorktreeManager, runGit } from '../src/lib/worktrees.js';
import { createTaskDispatcher } from '../src/lib/task-dispatch.js';
import { abandonPreparation } from '../src/lib/preparation-failure.js';
const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' };
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(options = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multica-prep-failure-')));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, ['init']); git(repo, ['config', 'user.name', 'Test']); git(repo, ['config', 'user.email', 'test@localhost']);
  fs.writeFileSync(path.join(repo, 'file'), 'preserved'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base']);
  const tasks = new Map(); const calls = [];
  const request = async (_config, method, route, body) => {
    calls.push({ method, route, body });
    const parts = route.split('/');
    if (method === 'GET') return [...tasks.values()];
    const id = parts.at(-2); const task = tasks.get(id); const action = parts.at(-1);
    if (options.request) await options.request(action, task, body);
    if (action === 'start') { task.status = 'running'; return { ...task }; }
    if (action === 'fail') { Object.assign(task, { status: 'failed', ...body }); if (options.loseFail) throw Error('response lost'); }
    return { ...task };
  };
  const state = createTaskState(config, { root: path.join(root, 'state'), request, removeTaskToken() {}, ...(options.stateWrite ? { write: options.stateWrite } : {}) });
  const manager = createWorktreeManager({ config, lifecycle: state, dataDir: path.join(root, 'execution'), workRoot: path.join(root, 'work'), ...(options.git ? { git: options.git } : {}), ...(options.persist ? { persist: options.persist } : {}) });
  const makeTask = async (id, extra = {}) => {
    const task = { id, agent_id: 'agent', issue_id: 'shared', workspace_id: 'workspace', runtime_id: 'runtime', dispatched_at: '2026-10-15T01:02:03.123456Z', status: 'dispatched',
      project_resources: [{ id: 'a-local', resource_type: 'local_directory', resource_ref: { daemon_id: 'daemon', local_path: repo, execution_mode: 'worktree' } }], ...extra };
    tasks.set(id, task); const record = await state.registerClaim(task); return { task, generation: record.generation };
  };
  const makeDispatcher = () => createTaskDispatcher(config, { state, worktrees: manager, request, root: path.join(root, 'dispatch'), snapshot: async task => ({ task }), render: async () => 'card', deliver: async () => true });
  return { root, repo, state, manager, tasks, calls, makeTask, makeDispatcher };
}

test('real partial preparation releases owned worklines, keeps all artifacts and lets next task deliver', async () => {
  const f = fixture({ git: async (cwd, args, env, options) => {
    if (args[0] === 'clone') throw Object.assign(Error('auth'), { code: 'PREPARATION_PERMANENT', preparationReason: 'authentication required or denied' });
    return runGit(cwd, args, env, options);
  } });
  const { task, generation } = await f.makeTask('old', { repos: [{ url: 'https://private.example/repo.git' }] });
  const d = f.makeDispatcher(); await d.enqueue(task); await d.drain();
  const record = f.manager.inspect('old');
  assert.equal(record.phase, 'abandoned');
  assert.equal(record.bindings[0].phase, 'prepared');
  assert.equal(fs.readFileSync(path.join(record.bindings[0].cwd, 'file'), 'utf8'), 'preserved');
  assert.equal(f.state.get('old').report.state, 'confirmed');
  assert.match(f.state.get('old').report.payload.error, /resource repo-/);
  assert.equal(fs.readdirSync(path.join(f.root, 'execution/owners')).length, 0);
  assert.equal(fs.readdirSync(path.join(f.root, 'execution/operations')).length, 0);
  const next = await f.makeTask('next'); await d.enqueue(next.task); await d.drain();
  assert.equal(f.state.get('next').delivery.delivered, true);
  await abandonPreparation(f.state, f.manager, 'old', generation, f.state.get('old').preparation_failure.reason);
  assert.equal(f.state.get('next').delivery.delivered, true);
  assert.equal(fs.readdirSync(path.join(f.root, 'execution/owners')).length, 1);
});

test('abandon refuses stale/started work, freezes reason, blocks admission, and reconciles lost fail response once', async () => {
  const f = fixture({ loseFail: true }); const { task, generation } = await f.makeTask('task');
  await assert.rejects(abandonPreparation(f.state, f.manager, task.id, 'stale', 'stop'), /stale/);
  const result = await abandonPreparation(f.state, f.manager, task.id, generation, 'operator requested stop');
  assert.equal(result.report.state, 'confirmed');
  await abandonPreparation(f.state, f.manager, task.id, generation, 'operator requested stop');
  assert.equal(f.calls.filter(c => c.route.endsWith('/fail')).length, 1);
  await assert.rejects(f.state.start(task.id, generation), /frozen|quiesced/);
  await assert.rejects(abandonPreparation(f.state, f.manager, task.id, generation, 'changed reason'), /frozen/);
  const started = await f.makeTask('started'); await f.state.start(started.task.id, started.generation);
  await assert.rejects(abandonPreparation(f.state, f.manager, started.task.id, started.generation, 'late'), /unstarted/);
});

test('abandon refuses active preparation; admission fence allows resume only after it stopped', async () => {
  let entered, finish;
  const inGit = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { finish = resolve; });
  const f = fixture({ git: async (cwd, args, env, options) => { entered(); await gate; return runGit(cwd, args, env, options); } });
  const { task, generation } = await f.makeTask('task');
  const preparing = f.manager.prepare(task, undefined, { generation });
  const rejected = assert.rejects(preparing, /quiesced/);
  await inGit;
  await assert.rejects(abandonPreparation(f.state, f.manager, task.id, generation, 'stop'), /active or interrupted/);
  assert.equal(f.calls.some(c => c.route.endsWith('/start')), false);
  finish(); await rejected;
  const result = await abandonPreparation(f.state, f.manager, task.id, generation, 'stop');
  assert.equal(result.report.state, 'confirmed');
});

test('abandon without snapshot resumes durable intent after lost start and does not rerun preparation', async () => {
  let lost = true;
  const f = fixture({ request(action) { if (action === 'start' && lost) throw Error('lost start'); } });
  const { task, generation } = await f.makeTask('task');
  await assert.rejects(abandonPreparation(f.state, f.manager, task.id, generation, 'stop'), /lost start/);
  assert.equal(f.state.get(task.id).start_unknown, true);
  lost = false;
  const d = f.makeDispatcher(); d.resume(); await d.drain();
  assert.equal(f.state.get(task.id).report.state, 'confirmed');
  assert.equal(f.manager.inspect(task.id), null);
});

test('real Git child classifies authentication, invalid ref and network errors without echoing secrets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-git-class-'));
  const server = http.createServer((_req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }); res.end('credential-secret'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  await assert.rejects(runGit(root, ['-c', 'credential.helper=', 'ls-remote', `http://127.0.0.1:${port}/repo`]), error => {
    assert.equal(error.code, 'PREPARATION_PERMANENT'); assert.match(error.message, /authentication/);
    assert.doesNotMatch(error.message, /credential-secret|127.0.0.1/); return true;
  });
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(runGit(root, ['ls-remote', `http://127.0.0.1:${port}/repo`]), error => error.code === 'PREPARATION_TRANSIENT');
  git(root, ['init']);
  await assert.rejects(runGit(root, ['fetch', root, 'missing-ref']), error => error.code === 'PREPARATION_PERMANENT' && /invalid repository ref/.test(error.message));
});

for (const stage of ['decision', 'released', 'start', 'report']) test(`durable prestart abandonment resumes after ${stage} write interruption`, async () => {
  let injected = false;
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicTaskWrite(file, value);
    const hit = stage === 'decision' ? value.preparation_failure && !value.start_confirmed && !value.report
      : stage === 'released' ? value.phase === 'abandoned'
      : stage === 'start' ? value.start_confirmed && !value.report : value.report?.state === 'pending';
    if (hit && !injected) { injected = true; throw Error('interrupted write'); }
  };
  const f = fixture({ stateWrite: write, persist: write });
  const { task, generation } = await f.makeTask('task');
  await f.manager.prepare(task, undefined, { generation });
  const artifact = f.manager.inspect(task.id).bindings[0].cwd;
  await assert.rejects(abandonPreparation(f.state, f.manager, task.id, generation, 'stop'), /interrupted/);
  const d = f.makeDispatcher(); d.resume(); await d.drain();
  assert.equal(f.state.get(task.id).report?.state, 'confirmed');
  assert.equal(f.calls.filter(c => c.route.endsWith('/fail')).length, 1);
  assert.equal(fs.readFileSync(path.join(artifact, 'file'), 'utf8'), 'preserved');
  assert.equal(fs.readdirSync(path.join(f.root, 'execution/owners')).length, 0);
});

test('SIGKILL after partial ownership release leaves only an abandonment slot that replay can reclaim', async () => {
  const f = fixture(); const { task, generation } = await f.makeTask('task');
  task.project_resources[0].resource_ref.execution_mode = 'in_place';
  await f.manager.prepare(task, undefined, { generation });
  await f.state.abandonPreparation(task.id, generation, 'stop');
  const script = `import fs from 'node:fs';
    import {createTaskState} from ${JSON.stringify(new URL('../src/lib/task-state.js', import.meta.url).href)};
    import {createWorktreeManager} from ${JSON.stringify(new URL('../src/lib/worktrees.js', import.meta.url).href)};
    const config=${JSON.stringify(config)};
    const state=createTaskState(config,{root:${JSON.stringify(f.state.root)}});
    const manager=createWorktreeManager({config,lifecycle:state,dataDir:${JSON.stringify(path.join(f.root, 'execution'))},workRoot:${JSON.stringify(path.join(f.root, 'work'))}});
    const unlink=fs.unlinkSync; fs.unlinkSync=(file)=>{unlink(file);if(file.includes('/owners/'))process.kill(process.pid,'SIGKILL');};
    await manager.releasePreparation('task',${JSON.stringify(generation)});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', data => errors += data);
  await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (_code, signal) => signal === 'SIGKILL' ? resolve() : reject(Error(errors))); });
  assert.equal(fs.readdirSync(path.join(f.root, 'execution/owners')).length, 1);
  assert.equal(fs.readdirSync(path.join(f.root, 'execution/operations')).length, 1);
  const result = await abandonPreparation(f.state, f.manager, task.id, generation, 'stop');
  assert.equal(result.report.state, 'confirmed');
  assert.equal(fs.readdirSync(path.join(f.root, 'execution/owners')).length, 0);
  assert.equal(fs.readFileSync(path.join(f.repo, 'file'), 'utf8'), 'preserved');
});

test('concurrent original start and abandon have exactly one admission winner', async () => {
  const f = fixture(); const { task, generation } = await f.makeTask('task');
  const [starting, abandoning] = await Promise.allSettled([
    f.state.start(task.id, generation), abandonPreparation(f.state, f.manager, task.id, generation, 'stop'),
  ]);
  assert.equal([starting, abandoning].filter(r => r.status === 'fulfilled').length, 1);
  const record = f.state.get(task.id);
  if (abandoning.status === 'fulfilled') {
    assert.equal(record.report.state, 'confirmed');
    await assert.rejects(f.state.markAccepted(task.id, generation), /frozen|quiesced/);
  } else {
    assert.equal(record.report, null); assert.equal(record.preparation_failure, undefined);
    assert.equal(await f.state.markAccepted(task.id, generation), true);
  }
});

test('unconfirmed cache ownership refuses local release and remote start', async () => {
  const f = fixture(); const { task, generation } = await f.makeTask('task');
  await f.manager.prepare(task, undefined, { generation });
  const binding = f.manager.inspect(task.id).bindings[0];
  const { createHash } = await import('node:crypto');
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const ownerFile = path.join(f.root, 'execution/owners', `${binding.line_key}.json`);
  const owner = JSON.parse(fs.readFileSync(ownerFile));
  atomicTaskWrite(path.join(f.root, 'execution/owners', `git-prepare-${hash(binding.repo)}.json`), owner);
  await assert.rejects(abandonPreparation(f.state, f.manager, task.id, generation, 'stop'), /stop is unconfirmed/);
  assert.equal(fs.existsSync(ownerFile), true);
  assert.equal(f.calls.some(c => c.route.endsWith('/start')), false);
});

test('one slow preparation does not serialize other tasks', async () => {
  const f = fixture(); const first = await f.makeTask('slow'); const second = await f.makeTask('fast', { issue_id: 'another', project_resources: [] });
  let resume, entered;
  const blocked = new Promise(resolve => { resume = resolve; }); const waiting = new Promise(resolve => { entered = resolve; });
  const manager = { ...f.manager, async prepare(task, resources, options) {
    if (task.id === 'slow') { entered(); await blocked; }
    return f.manager.prepare(task, resources, options);
  } };
  let delivered; const fastDelivered = new Promise(resolve => { delivered = resolve; });
  const d = createTaskDispatcher(config, { state: f.state, worktrees: manager, request: async (_c, _m, route) => ({ ...f.tasks.get(route.split('/').at(-2)), status: 'dispatched' }), root: path.join(f.root, 'dispatch'), snapshot: async task => ({ task }), render: async () => 'card', deliver: async (_d, task) => { if (task.id === 'fast') delivered(); return true; } });
  await d.enqueue(first.task); await waiting; await d.enqueue(second.task);
  await fastDelivered;
  assert.equal(f.state.get('slow').delivery, undefined);
  resume(); await d.drain();
  assert.equal(f.state.get('fast').delivery.delivered, true);
});

test('supported task.js abandon CLI is generation-bound and idempotent over actual HTTP', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multica-abandon-cli-')));
  let remote = { id: 'cli-task', agent_id: 'agent', issue_id: 'issue', workspace_id: 'workspace', runtime_id: 'runtime', dispatched_at: '2026-10-15T01:02:03.123456Z', status: 'dispatched' };
  let failCalls = 0;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url.endsWith('/start')) {
      const claim = JSON.parse(body); assert.equal(claim.dispatched_at, remote.dispatched_at);
      remote.status = 'running';
    } else if (req.url.endsWith('/fail')) { failCalls++; remote = { ...remote, ...JSON.parse(body), status: 'failed' }; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(remote));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const cfg = { ...config, base_url: `http://127.0.0.1:${server.address().port}`, pat: 'fixture-only', runtime_name: 'test' };
  const data = path.join(home, 'zylos/components/multica'); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(cfg));
  const state = createTaskState(cfg, { root: path.join(data, 'task-state'), removeTaskToken() {} });
  const record = await state.registerClaim(remote);
  async function cli(reason) {
    const child = spawn(process.execPath, ['scripts/task.js', 'abandon', `${remote.id}@${record.generation}`, '--reason', reason], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, stdout, stderr };
  }
  const first = await cli('operator stop'); assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).report.state, 'confirmed');
  const second = await cli('operator stop'); assert.equal(second.code, 0, second.stderr);
  assert.equal(failCalls, 1);
  const changed = await cli('changed'); assert.equal(changed.code, 1); assert.match(changed.stderr, /frozen/);
});
