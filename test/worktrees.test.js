import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import { createWorktreeManager, resolveExecutionResources, WorktreeBusyError, runGit } from '../src/lib/worktrees.js';
import { runWorktreeCli } from '../src/lib/worktree-cli.js';
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const config = { base_url: 'https://multica.example', workspace_id: 'workspace-a', daemon_id: 'daemon-a' };
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-worktree-test-'));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  git(source, ['init']); git(source, ['config', 'user.name', 'Test']); git(source, ['config', 'user.email', 'test@localhost']);
  fs.mkdirSync(path.join(source, 'sub')); fs.writeFileSync(path.join(source, 'sub/file'), 'base\n');
  fs.writeFileSync(path.join(source, '.gitignore'), 'ignored\n');
  git(source, ['add', '.']); git(source, ['commit', '-m', 'baseline']);
  const states = new Map();
  const lifecycle = {
    assertCurrent({ taskId, generation, requireRunning }) {
      const state = states.get(taskId);
      if (!state || state.generation !== generation || state.report || state.quiesced || (requireRunning && !state.running)) throw new Error('lifecycle gate rejected execution');
      return state;
    }, get(id) { return states.get(id); },
  };
  const manager = createWorktreeManager({ dataDir: path.join(root, 'execution'), workRoot: path.join(root, 'workspace'), config, lifecycle });
  const task = (id, issue = id, mode = 'worktree', local = path.join(source, 'sub')) => {
    states.set(id, { generation: `gen-${id}`, running: true });
    return { id, agent_id: 'agent-a', issue_id: issue, runtime_id: 'runtime-a', dispatched_at: '2026-10-15T10:00:00.123456Z',
      project_resources: [{ id: 'resource-a', resource_type: 'local_directory', resource_ref: { daemon_id: 'daemon-a', local_path: local, execution_mode: mode } }] };
  };
  const prepare = (value, target = manager) => target.prepare(value, undefined, { generation: `gen-${value.id}` });
  return { root, source, states, lifecycle, manager, task, prepare };
}
test('worktrees preserve user files/index, snapshot tracked/untracked, ignore files and keep subdirectory cwd', async () => {
  const f = setup();
  fs.writeFileSync(path.join(f.source, 'sub/file'), 'staged\n'); git(f.source, ['add', '.']);
  fs.writeFileSync(path.join(f.source, 'sub/file'), 'unstaged\n');
  fs.writeFileSync(path.join(f.source, 'untracked'), 'artifact'); fs.writeFileSync(path.join(f.source, 'ignored'), 'ignored');
  fs.mkdirSync(path.join(f.source, '.agent_context')); fs.writeFileSync(path.join(f.source, '.agent_context/private'), 'other task');
  const originalIndex = fs.readFileSync(path.join(f.source, '.git/index'));
  const originalStatus = git(f.source, ['status', '--porcelain=v1', '-z']);
  const a = (await f.prepare(f.task('a'))).bindings[0]; const b = (await f.prepare(f.task('b'))).bindings[0];
  assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.branch, b.branch);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'file'), 'utf8'), 'unstaged\n');
  assert.equal(fs.readFileSync(path.join(a.worktree, 'untracked'), 'utf8'), 'artifact');
  assert.equal(fs.existsSync(path.join(a.worktree, 'ignored')), false);
  assert.equal(fs.existsSync(path.join(a.worktree, '.agent_context')), false);
  assert.deepEqual(fs.readFileSync(path.join(f.source, '.git/index')), originalIndex);
  assert.equal(git(f.source, ['status', '--porcelain=v1', '-z']), originalStatus);
  await Promise.all(['a', 'b'].map((id) => f.manager.run(id, `gen-${id}`, 'resource-a', ['node', '-e', `require('fs').writeFileSync('file','${id}')`])));
  assert.equal(fs.readFileSync(path.join(a.cwd, 'file'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(b.cwd, 'file'), 'utf8'), 'b');
  assert.equal(fs.readFileSync(path.join(f.source, 'sub/file'), 'utf8'), 'unstaged\n');
});
test('same workline waits, confirmed committed delivery continues via new branch/directory', async () => {
  const f = setup(); const aTask = f.task('a', 'shared'); const a = (await f.prepare(aTask)).bindings[0];
  const bTask = f.task('b', 'shared'); await assert.rejects(async () => (await f.prepare(bTask)), WorktreeBusyError);
  await f.manager.run('a', 'gen-a', 'resource-a', ['node', '-e', "require('fs').writeFileSync('file','delivered')"]);
  git(a.cwd, ['add', '.']); git(a.cwd, ['commit', '-m', 'delivery']);
  (await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true }));
  await assert.rejects(async () => (await f.prepare(bTask)), WorktreeBusyError);
  f.states.get('a').report = { action: 'complete', state: 'confirmed' }; (await f.manager.confirmDelivery('a', 'gen-a'));
  const b = (await f.prepare(bTask)).bindings[0];
  assert.notEqual(a.cwd, b.cwd); assert.notEqual(a.branch, b.branch);
  assert.equal(fs.readFileSync(path.join(b.cwd, 'file'), 'utf8'), 'delivered');
  assert.equal(fs.readFileSync(path.join(f.source, 'sub/file'), 'utf8'), 'base\n');
});
test('dirty delivery and lifecycle stale/start gates never silently continue', async () => {
  const f = setup(); const a = (await f.prepare(f.task('a', 'shared'))).bindings[0]; f.states.get('a').running = false;
  await assert.rejects(f.manager.run('a', 'gen-a', 'resource-a', ['node', '-e', "require('fs').writeFileSync('file','bad')"]), /gate/);
  f.states.get('a').running = true;
  await assert.rejects(f.manager.run('a', 'old', 'resource-a', ['node', '-e', '']), /generation|gate/);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'file'), 'utf8'), 'base\n');
  fs.writeFileSync(path.join(a.cwd, 'artifact'), 'keep'); (await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true }));
  f.states.get('a').report = { action: 'complete', state: 'confirmed' };
  await assert.rejects(async () => (await f.manager.confirmDelivery('a', 'gen-a')), /uncommitted/);
  await assert.rejects(async () => (await f.prepare(f.task('b', 'shared'))), WorktreeBusyError);
  assert.equal(fs.readFileSync(path.join(a.cwd, 'artifact'), 'utf8'), 'keep');
});
test('in_place locks canonical realpath and releases only on explicit quiescence', async () => {
  const f = setup(); const link = path.join(f.root, 'alias'); fs.symlinkSync(f.source, link);
  const a = (await f.prepare(f.task('a', 'a', 'in_place', f.source))).bindings[0];
  assert.equal(a.cwd, f.source); assert.equal(a.branch, null);
  const bTask = f.task('b', 'b', 'in_place', link); await assert.rejects(async () => (await f.prepare(bTask)), WorktreeBusyError);
  await assert.rejects(async () => (await f.manager.quiesce('a', 'gen-a')), /acknowledgement/);
  (await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true })); assert.equal((await f.prepare(bTask)).bindings[0].cwd, f.source);
});
test('live command prevents quiescence; restart preserves bindings and cancellation cannot free unknown work', async () => {
  const f = setup(); const task = f.task('a'); const a = (await f.prepare(task)).bindings[0];
  const promise = f.manager.run('a', 'gen-a', 'resource-a', ['node', '-e', 'setTimeout(()=>{},150)']);
  await assert.rejects(async () => (await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true })), WorktreeBusyError);
  const restart = createWorktreeManager({ dataDir: path.join(f.root, 'execution'), workRoot: path.join(f.root, 'workspace'), config, lifecycle: f.lifecycle });
  assert.equal(restart.inspect('a').bindings[0].cwd, a.cwd);
  await assert.rejects(async () => (await restart.quiesce('a', 'gen-a', { acknowledgedStopped: true })), WorktreeBusyError);
  await promise; assert.equal((await restart.locate('a', 'gen-a', 'resource-a')).cwd, a.cwd);
  f.states.get('a').report = { state: 'superseded', action: 'complete' };
  await assert.rejects(async () => (await restart.locate('a', 'gen-a', 'resource-a')), /gate/);
  await assert.rejects(async () => (await restart.confirmDelivery('a', 'gen-a')), /confirmation/);
  assert.equal(fs.existsSync(a.cwd), true);
});
test('resource mode/daemon/ref rejection and remote repos use controlled cache without workspace merging', async () => {
  const f = setup(); assert.throws(() => resolveExecutionResources(f.task('a', 'a', 'unknown'), config), /execution_mode/);
  const foreign = f.task('b'); foreign.project_resources[0].resource_ref.daemon_id = 'other'; assert.deepEqual(resolveExecutionResources(foreign, config), []);
  const remoteTask = f.task('remote'); remoteTask.project_resources = [];
  remoteTask.repos = [{ url: 'https://git.example/repo.git', ref: 'HEAD' }]; remoteTask.workspace_repos = [{ url: 'https://git.example/ignored.git' }];
  const resources = resolveExecutionResources(remoteTask, config); assert.equal(resources.length, 1);
  const remoteManager = createWorktreeManager({ dataDir: path.join(f.root, 'execution'), workRoot: path.join(f.root, 'workspace'), config, lifecycle: f.lifecycle,
    async git(cwd, args, env, options) {
      if (args[0] === 'clone') {
        const result = await runGit(cwd, args.map((arg) => arg === remoteTask.repos[0].url ? f.source : arg), env);
        await runGit(args.at(-1), ['remote', 'set-url', 'origin', remoteTask.repos[0].url]); return result;
      }
      if (args[0] === 'fetch') return runGit(cwd, args.map((arg) => arg === 'origin' ? f.source : arg), env);
      return runGit(cwd, args, env);
    },
  });
  const binding = (await f.prepare(remoteTask, remoteManager)).bindings[0];
  assert.ok(binding.repo.startsWith(path.join(f.root, 'workspace/repos/'))); assert.ok(binding.cwd.startsWith(path.join(f.root, 'workspace/tasks/')));
  assert.equal(fs.readFileSync(path.join(binding.cwd, 'sub/file'), 'utf8'), 'base\n');
  const revisedTask = f.task('remote-revised'); revisedTask.project_resources = [];
  revisedTask.issue_id = remoteTask.issue_id;
  revisedTask.repos = [{ url: remoteTask.repos[0].url, ref: `refs/heads/${git(f.source, ['branch', '--show-current'])}` }];
  const revised = (await f.prepare(revisedTask, remoteManager)).bindings[0];
  assert.notEqual(revised.line_key, binding.line_key, 'changed explicit ref is a new workline');
  remoteTask.repos[0].ref = '--upload-pack=bad'; assert.throws(() => resolveExecutionResources(remoteTask, config), /ref/);
});
test('CLI requires task/generation/resource and commands execute with explicit cwd', async () => {
  const f = setup(); (await f.prepare(f.task('a'))); const output = [];
  const result = await runWorktreeCli(['exec', '--task', 'a', '--generation', 'gen-a', '--resource', 'resource-a', '--', 'node', '-e', 'process.stdout.write(process.cwd())'], { manager: f.manager, output: (value) => output.push(value) });
  assert.equal(result.stdout, f.manager.inspect('a').bindings[0].cwd); assert.equal(output.length, 1);
  await assert.rejects(runWorktreeCli(['exec', '--task', 'a'], { manager: f.manager }), /generation/);
});

test('forced staged ignored files are snapshotted without changing the source index', async () => {
  const f = setup(); fs.writeFileSync(path.join(f.source, 'ignored'), 'force-staged'); git(f.source, ['add', '-f', 'ignored']);
  const index = fs.readFileSync(path.join(f.source, '.git/index'));
  const binding = (await f.prepare(f.task('a'))).bindings[0];
  assert.equal(fs.readFileSync(path.join(binding.worktree, 'ignored'), 'utf8'), 'force-staged');
  assert.deepEqual(fs.readFileSync(path.join(f.source, '.git/index')), index);
  assert.equal(git(f.source, ['rev-parse', binding.snapshot_ref]), binding.source_snapshot);
});
test('preparing interruption resumes owned existing worktree, retaining uncommitted artifacts', async () => {
  const f = setup(); const task = f.task('a'); let fail = true;
  const interrupted = createWorktreeManager({ dataDir: path.join(f.root, 'execution'), workRoot: path.join(f.root, 'workspace'), config, lifecycle: f.lifecycle,
    async git(cwd, args, env, options) { const value = await runGit(cwd, args, env); if (fail && args[0] === 'worktree' && args[1] === 'add') { fail = false; throw new Error('simulated lost preparation response'); } return value; },
  });
  await assert.rejects(async () => (await f.prepare(task, interrupted)), /lost preparation/);
  const binding = interrupted.inspect('a').bindings[0];
  fs.writeFileSync(path.join(binding.cwd, 'retained'), 'unfinished');
  const resumed = (await f.prepare(task)).bindings[0];
  assert.equal(resumed.cwd, binding.cwd);
  assert.equal(fs.readFileSync(path.join(resumed.cwd, 'retained'), 'utf8'), 'unfinished');
});
test('changed source after confirmed delivery requires an explicit baseline choice', async () => {
  const f = setup(); (await f.prepare(f.task('a', 'shared')));
  (await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true }));
  f.states.get('a').report = { action: 'complete', state: 'confirmed' }; (await f.manager.confirmDelivery('a', 'gen-a'));
  fs.writeFileSync(path.join(f.source, 'sub/file'), 'new human edits');
  await assert.rejects(async () => (await f.prepare(f.task('b', 'shared'))), /source changed/);
  assert.equal(fs.readFileSync(path.join(f.source, 'sub/file'), 'utf8'), 'new human edits');
});
test('multi-resource busy attempt releases only newly acquired ownership and cannot deadlock other lines', async () => {
  const f = setup(); const aTask = f.task('a', 'shared'); (await f.prepare(aTask));
  const bTask = f.task('b', 'shared');
  const resources = resolveExecutionResources(bTask, config);
  const additional = { ...resources[0], id: 'other-resource' };
  await assert.rejects(async () => (await f.manager.prepare(bTask, [additional, ...resources], { generation: 'gen-b' })), WorktreeBusyError);
  const cTask = f.task('c', 'shared');
  assert.equal((await f.manager.prepare(cTask, [additional], { generation: 'gen-c' })).phase, 'prepared');
});
test('interrupted operation requires explicit stop proof; unknown work remains blocked across restart', async () => {
  const f = setup(); (await f.prepare(f.task('a')));
  const bindingFile = path.join(f.root, 'execution/bindings', fs.readdirSync(path.join(f.root, 'execution/bindings'))[0]);
  const record = JSON.parse(fs.readFileSync(bindingFile)); record.commands.push({ id: 'unknown', status: 'running' });
  fs.writeFileSync(bindingFile, JSON.stringify(record));
  await assert.rejects(async () => (await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true })), /exit is unconfirmed/);
  assert.throws(() => f.manager.acknowledgeStopped('a', 'gen-a'), /acknowledgement/);
  f.manager.acknowledgeStopped('a', 'gen-a', { acknowledgedStopped: true });
  assert.equal((await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true })).execution.quiesced, true);
});

test('long Git preparation permits lease timers and responds to cancellation without delivery readiness', async () => {
  const f = setup(); const task = f.task('a'); const controller = new AbortController();
  let ticks = 0; const timer = setInterval(() => ticks++, 5);
  const manager = createWorktreeManager({ dataDir: path.join(f.root, 'execution'), workRoot: path.join(f.root, 'workspace'), config, lifecycle: f.lifecycle,
    async git(cwd, args, env, options) {
      if (args[0] === 'add') {
        await new Promise((resolve) => setTimeout(resolve, 65)); controller.abort();
      }
      return runGit(cwd, args, env, options);
    },
  });
  try {
    await assert.rejects(manager.prepare(task, undefined, { generation: 'gen-a', signal: controller.signal }), /aborted/);
    assert.ok(ticks >= 5, 'lease timer must run while Git is preparing');
    assert.equal(manager.inspect('a').phase, 'preparing');
    assert.equal(fs.readFileSync(path.join(f.source, 'sub/file'), 'utf8'), 'base\n');
  } finally { clearInterval(timer); }
});

test('real Git subprocess is asynchronous and abortable', async () => {
  const f = setup();
  const started = Date.now(); let ticked = false;
  const controller = new AbortController();
  const timer = setTimeout(() => { ticked = true; controller.abort(); }, 30);
  try {
    await assert.rejects(runGit(f.source, ['-c', 'alias.wait=!sleep 2', 'wait'], {}, { signal: controller.signal }), /aborted/);
    assert.equal(ticked, true); assert.ok(Date.now() - started < 1500);
  } finally { clearTimeout(timer); }
});

test('cancelCommands waits for owned command exit but still requires live-session quiescence', async () => {
  const f = setup(); (await f.prepare(f.task('a')));
  const ready = path.join(f.root, 'ready');
  const running = f.manager.run('a', 'gen-a', 'resource-a', ['node', '-e', `require('fs').writeFileSync(${JSON.stringify(ready)},'yes');setInterval(()=>{},1000)`]);
  for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(fs.existsSync(ready));
  const cancelled = await f.manager.cancelCommands('a', 'gen-a'); const result = await running;
  assert.equal(cancelled.stopped, 1); assert.equal(result.signal, 'SIGTERM');
  await assert.rejects(f.manager.quiesce('a', 'gen-a'), /acknowledgement/);
  assert.equal((await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true })).execution.quiesced, true);
});

test('leader task skips local directory assignment while preserving server-resolved repositories', () => {
  const f = setup(); const task = f.task('leader'); task.is_leader_task = true;
  task.repos = [{ url: 'https://git.example/coordination.git', ref: 'HEAD' }];
  const resources = resolveExecutionResources(task, config);
  assert.equal(resources.length, 1); assert.equal(resources[0].type, 'github_repo');
});

test('cancellation waits for TERM-ignoring descendants with detached stdio before quiescence', async () => {
  const f = setup(); await f.prepare(f.task('a', 'a', 'in_place', f.source));
  const marker = path.join(f.root, 'descendant-marker'); const controller = new AbortController();
  const script = `(trap '' TERM; while true; do echo tick >> '${marker}'; sleep 0.03; done) >/dev/null 2>&1 & wait`;
  const running = f.manager.run('a', 'gen-a', 'resource-a', ['sh', '-c', script], { signal: controller.signal });
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(fs.existsSync(marker)); controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 100));
  await assert.rejects(f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true }), WorktreeBusyError);
  await running; await f.manager.quiesce('a', 'gen-a', { acknowledgedStopped: true });
  const size = fs.statSync(marker).size;
  await new Promise((resolve) => setTimeout(resolve, 150)); assert.equal(fs.statSync(marker).size, size);
});

test('Git cancellation also waits for TERM-ignoring helper descendants', async () => {
  const f = setup(); const marker = path.join(f.root, 'git-descendant-marker'); const controller = new AbortController();
  const script = `!(trap '' TERM; while true; do echo tick >> '${marker}'; sleep 0.03; done) >/dev/null 2>&1 & wait`;
  const running = runGit(f.source, ['-c', `alias.wait=${script}`, 'wait'], {}, { signal: controller.signal });
  const rejected = assert.rejects(running, /aborted/);
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(fs.existsSync(marker)); controller.abort(); await rejected;
  const size = fs.statSync(marker).size; await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(fs.statSync(marker).size, size);
});


test('changing execution mode creates a distinct workline rather than reusing a prior delivery head', async () => {
  const f = setup(); const a = (await f.prepare(f.task('a', 'shared', 'worktree', f.source))).bindings[0];
  const b = (await f.prepare(f.task('b', 'shared', 'in_place', f.source))).bindings[0];
  assert.notEqual(a.line_key, b.line_key); assert.equal(b.cwd, f.source);
});


test('normal command close retains occupancy when redirected background descendants remain', async () => {
  const f = setup(); await f.prepare(f.task('a', 'a', 'in_place', f.source));
  const marker = path.join(f.root, 'late-write');
  await assert.rejects(f.manager.run('a', 'gen-a', 'resource-a',
    ['sh', '-c', `(sleep 0.3; echo late > '${marker}') >/dev/null 2>&1 &`]), /process-group stop unconfirmed/);
  assert.equal(f.manager.inspect('a').commands[0].status, 'stop_unconfirmed');
  const restart = createWorktreeManager({ dataDir: path.join(f.root, 'execution'), workRoot: path.join(f.root, 'workspace'), config, lifecycle: f.lifecycle });
  await assert.rejects(restart.quiesce('a', 'gen-a', { acknowledgedStopped: true }), /exit is unconfirmed/);
  const next = f.task('b', 'b', 'in_place', f.source);
  await assert.rejects(f.prepare(next, restart), WorktreeBusyError);
  for (let i = 0; i < 200 && !fs.existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'late', 'normal completion does not silently kill background work');
  // Fixture descendant has finished; explicitly acknowledge that observation.
  await new Promise((resolve) => setTimeout(resolve, 30));
  restart.acknowledgeStopped('a', 'gen-a', { acknowledgedStopped: true });
  await restart.quiesce('a', 'gen-a', { acknowledgedStopped: true });
  assert.equal((await f.prepare(next, restart)).phase, 'prepared');
});

test('in_place overlap excludes both ancestor directions while allowing sibling directories', async () => {
  const f = setup(); const sub = path.join(f.source, 'sub'); const sibling = path.join(f.source, 'sub-other'); fs.mkdirSync(sibling);
  await f.prepare(f.task('child', 'child', 'in_place', sub));
  const parent = f.task('parent', 'parent', 'in_place', f.source);
  await assert.rejects(f.prepare(parent), WorktreeBusyError);
  assert.equal((await f.prepare(f.task('sibling', 'sibling', 'in_place', sibling))).phase, 'prepared');
  await f.manager.quiesce('child', 'gen-child', { acknowledgedStopped: true });
  await f.manager.quiesce('sibling', 'gen-sibling', { acknowledgedStopped: true });
  await f.prepare(parent);
  await assert.rejects(f.prepare(f.task('next-child', 'next-child', 'in_place', sub)), WorktreeBusyError);
});

test('separate processes atomically acquire overlapping in_place paths', async () => {
  const f = setup(); const gate = path.join(f.root, 'go');
  const tasks = [f.task('parent', 'parent', 'in_place', f.source), f.task('child', 'child', 'in_place', path.join(f.source, 'sub'))];
  const ready = tasks.map((task) => path.join(f.root, task.id + '-ready'));
  const workers = tasks.map((task, i) => {
    const script = `import fs from 'node:fs';
      import { createWorktreeManager } from ${JSON.stringify(new URL('../src/lib/worktrees.js', import.meta.url).href)};
      const manager = createWorktreeManager({
        ...${JSON.stringify({ dataDir: path.join(f.root, 'execution'), workRoot: path.join(f.root, 'workspace'), config })}, lifecycle: { assertCurrent() {} }
      });
      fs.writeFileSync(${JSON.stringify(ready[i])}, 'ready');
      while (!fs.existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 2));
      try { await manager.prepare(${JSON.stringify(task)}, undefined, {generation: ${JSON.stringify('gen-' + task.id)}}); console.log('prepared'); }
      catch(error) { if (error.code !== 'WORKTREE_BUSY') throw error; console.log('busy'); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
      let stdout = '', stderr = '';
      child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    });
  });
  for (let i = 0; i < 200 && !ready.every(file => fs.existsSync(file)); i++) await new Promise(resolve => setTimeout(resolve, 5));
  fs.writeFileSync(gate, 'go');
  assert.deepEqual((await Promise.all(workers)).sort(), ['busy', 'prepared']);
});

test('normal Git close does not certify redirected helper descendants stopped', async () => {
  const f = setup();
  await assert.rejects(runGit(f.source, ['-c', 'alias.background=!sleep 0.2 >/dev/null 2>&1 &', 'background']), error => error.code === 'PROCESS_STOP_UNCONFIRMED');
});
