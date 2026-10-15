import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import { createTaskState, atomicTaskWrite } from '../src/lib/task-state.js';
import { createWorktreeManager } from '../src/lib/worktrees.js';
import { createTaskDispatcher } from '../src/lib/task-dispatch.js';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
async function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multica-recovery-')));
  const repo = path.join(root, 'repo'); fs.mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.test');
  fs.writeFileSync(path.join(repo, 'file'), 'original'); fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  const config = { base_url: 'https://example.test', workspace_id: 'workspace', daemon_id: 'daemon' };
  const tasks = new Map(), calls = [], delivered = [];
  const task = id => {
    const value = { id, agent_id: 'agent', workspace_id: 'workspace', runtime_id: 'runtime', issue_id: 'issue', dispatched_at: '2026-10-15T01:02:03.123456Z', status: 'dispatched', project_resources: [{ id: 'repo', resource_type: 'local_directory', resource_ref: { daemon_id: 'daemon', local_path: repo, execution_mode: 'worktree' } }] };
    tasks.set(id, value); return value;
  };
  const request = async (_config, _method, route, body) => {
    const segments = route.split('/'); const action = segments.at(-1), id = segments.at(-2), value = tasks.get(id);
    calls.push({ id, action, body });
    if (!value) throw Error('unknown task');
    if (action === 'prepare-lease') { if (value.status !== 'dispatched') throw Error('not dispatched'); return { ...value }; }
    if (action === 'start') {
      assert.equal(body.dispatched_at, value.dispatched_at); assert.equal(body.runtime_id, value.runtime_id);
      if (!['dispatched', 'running'].includes(value.status)) throw Error('stale');
      value.status = 'running'; return { ...value };
    }
    if (action === 'fail') { value.status = 'failed'; Object.assign(value, body); return { ...value }; }
    throw Error('unexpected request');
  };
  const state = createTaskState(config, { root: path.join(root, 'state'), request, removeTaskToken() {} });
  const options = { config, lifecycle: state, dataDir: path.join(root, 'execution'), workRoot: path.join(root, 'work') };
  const manager = createWorktreeManager(options);
  const makeDispatcher = worktrees => createTaskDispatcher(config, { state, worktrees, request, root: path.join(root, 'dispatch'), snapshot: async value => ({ task: value }), render: async () => 'card', deliver: async (_card, value) => { delivered.push(value.id); return true; } });
  const dispatcher = makeDispatcher(manager);
  await dispatcher.enqueue(task('old')); await dispatcher.drain();
  const oldGen = state.get('old').generation;
  await state.markAccepted('old', oldGen);
  await manager.run('old', oldGen, 'repo', [process.execPath, '-e', "require('fs').writeFileSync('file','unfinished');require('fs').writeFileSync('untracked','keep');require('fs').writeFileSync('ignored','keep ignored')"]);
  await manager.quiesce('old', oldGen, { acknowledgedStopped: true }); await state.markQuiesced('old', oldGen);
  await state.report('old', oldGen, 'fail', { error: 'failed execution' });
  await dispatcher.enqueue(task('next')); await dispatcher.drain();
  const nextGen = state.get('next').generation;
  const recover = (target = manager, overrides = {}) => target.recover('old', oldGen, 'next', nextGen, { acknowledgedStopped: true, baselines: { repo: base }, ...overrides });
  return { root, repo, base, state, manager, options, tasks, calls, delivered, oldGen, nextGen, recover, dispatcher, makeDispatcher };
}
test('failed → explicit recovery → dispatcher start/admission → real execution; dirty old artifacts survive', async () => {
  const f = await fixture(); assert.deepEqual(f.delivered, ['old']);
  const old = f.manager.inspect('old'), failed = f.state.get('old');
  const result = await f.recover(); assert.equal(result.state, 'transferred');
  f.dispatcher.resume(); await f.dispatcher.drain(); assert.deepEqual(f.delivered, ['old', 'next']);
  await f.state.markAccepted('next', f.nextGen);
  const command = await f.manager.run('next', f.nextGen, 'repo', [process.execPath, '-e', "process.stdout.write(require('fs').readFileSync('file','utf8'))"]);
  assert.equal(command.stdout, 'original'); assert.equal(command.code, 0); assert.notEqual(command.cwd, old.bindings[0].cwd);
  for (const [name, value] of [['file', 'unfinished'], ['untracked', 'keep'], ['ignored', 'keep ignored']]) assert.equal(fs.readFileSync(path.join(old.bindings[0].cwd, name), 'utf8'), value);
  assert.deepEqual(f.state.get('old'), failed);
  assert.deepEqual(await f.recover(), result);
  await assert.rejects(f.recover(f.manager, { baselines: { repo: '0'.repeat(40) } }), /conflicting recovery/);
  await f.manager.quiesce('next', f.nextGen, { acknowledgedStopped: true }); await f.state.markQuiesced('next', f.nextGen);
  await f.state.report('next', f.nextGen, 'fail', { error: 'second failure' });
  const third = { ...f.tasks.get('next'), id: 'third', status: 'dispatched' }; delete third.error;
  f.tasks.set('third', third); await f.dispatcher.enqueue(third); await f.dispatcher.drain();
  const thirdGen = f.state.get('third').generation;
  await f.manager.recover('next', f.nextGen, 'third', thirdGen, { acknowledgedStopped: true, baselines: { repo: f.base } });
  f.dispatcher.resume(); await f.dispatcher.drain();
  assert.equal((await f.manager.run('third', thirdGen, 'repo', [process.execPath, '-e', 'process.stdout.write("third")'])).stdout, 'third');
  assert.deepEqual(await f.recover(), result, 'old replay cannot recapture a later continuation');
});
test('wrong generation, identity, baseline, stop proof and occupied operation fail closed', async () => {
  const f = await fixture();
  await assert.rejects(f.recover(f.manager, { acknowledgedStopped: false }), /stop acknowledgement/);
  await assert.rejects(f.manager.recover('old', 'wrong', 'next', f.nextGen, { acknowledgedStopped: true, baselines: { repo: f.base } }), /generation/);
  await assert.rejects(f.recover(f.manager, { baselines: {} }), /resource set/);
  await assert.rejects(f.recover(f.manager, { baselines: { repo: 'HEAD' } }), /exact commit/);
  f.tasks.get('next').agent_id = 'foreign'; await assert.rejects(f.recover(), /lease is not valid/); f.tasks.get('next').agent_id = 'agent';
  const file = fs.readdirSync(path.join(f.root, 'execution/bindings')).map(name => path.join(f.root, 'execution/bindings', name)).find(name => JSON.parse(fs.readFileSync(name)).task_id === 'old');
  const saved = JSON.parse(fs.readFileSync(file));
  atomicTaskWrite(file, { ...saved, commands: [{ status: 'running' }] }); await assert.rejects(f.recover(), /stop is unconfirmed/); atomicTaskWrite(file, saved);
  const ownerFile = path.join(f.root, 'execution/owners', `${saved.bindings[0].line_key}.json`), owner = JSON.parse(fs.readFileSync(ownerFile));
  atomicTaskWrite(ownerFile, { ...owner, generation: 'foreign' }); await assert.rejects(f.recover(), /ownership mismatch/); atomicTaskWrite(ownerFile, owner);
  const operationFile = path.join(f.root, 'execution/operations', path.basename(file));
  atomicTaskWrite(operationFile, owner); await assert.rejects(f.recover(), /operation is active/); fs.unlinkSync(operationFile);
  const stateFile = fs.readdirSync(f.state.root).filter(name => name.endsWith('.json')).map(name => path.join(f.state.root, name)).find(name => JSON.parse(fs.readFileSync(name)).task_id === 'old');
  const oldState = JSON.parse(fs.readFileSync(stateFile));
  atomicTaskWrite(stateFile, { ...oldState, report: { ...oldState.report, action: 'complete' } });
  await assert.rejects(f.recover(), /confirmed failed/); atomicTaskWrite(stateFile, oldState);
  atomicTaskWrite(stateFile, { ...oldState, execution: { ...oldState.execution, quiesced: false } });
  await assert.rejects(f.recover(), /confirmed failed/); atomicTaskWrite(stateFile, oldState);
  assert.equal(f.manager.inspect('old').recovery, undefined); assert.equal((await f.recover()).state, 'transferred');
});
for (const failAt of [1, 2, 3, 4, 5]) test(`durable replay after recovery write ${failAt}, with new manager`, async () => {
  const f = await fixture(); let writes = 0;
  const interrupted = createWorktreeManager({ ...f.options, persist(file, value) { atomicTaskWrite(file, value); if (++writes === failAt) throw Error('simulated process interruption'); } });
  await assert.rejects(f.recover(interrupted), /interruption/);
  const resumed = createWorktreeManager(f.options); assert.equal((await f.recover(resumed)).state, 'transferred');
  const dispatcher = f.makeDispatcher(resumed); dispatcher.resume(); await dispatcher.drain();
  assert.equal(f.state.get('next').start_confirmed, true);
  assert.equal((await resumed.run('next', f.nextGen, 'repo', [process.execPath, '-e', 'process.stdout.write("resumed")'])).stdout, 'resumed');
});
test('concurrent duplicate recovery transfers once', async () => {
  const f = await fixture(); const result = await Promise.all([f.recover(), f.recover(createWorktreeManager(f.options))]);
  assert.deepEqual(result[0], result[1]);
  assert.equal(f.calls.filter(call => call.id === 'next' && call.action === 'prepare-lease').length, 2);
});

test('pending recovery blocks preparation, and replay reclaims only marked recovery slots after crash', async () => {
  const f = await fixture(); let writes = 0;
  const interrupted = createWorktreeManager({ ...f.options, persist(file, value) { atomicTaskWrite(file, value); if (++writes === 2) throw Error('crash'); } });
  await assert.rejects(f.recover(interrupted), /crash/);
  await assert.rejects(f.manager.prepare(f.tasks.get('next'), undefined, { generation: f.nextGen }), /recovery decision requires replay/);
  const recovery = f.manager.inspect('old').recovery;
  const dir = path.join(f.root, 'execution/bindings');
  for (const name of fs.readdirSync(dir)) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, name)));
    const owner = { task: name.slice(0, -5), generation: record.generation, recovery: recovery.id };
    atomicTaskWrite(path.join(f.root, 'execution/operations', name), owner);
  }
  const resumed = createWorktreeManager(f.options); assert.equal((await f.recover(resumed)).state, 'transferred');
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'execution/operations')), []);
});
test('baseline can select a verified old commit without inheriting later dirty files', async () => {
  const f = await fixture(), old = f.manager.inspect('old').bindings[0];
  // Operator explicitly chooses a commit; no automated commit/stash/clean occurs.
  git(old.cwd, 'add', 'file'); git(old.cwd, 'commit', '-qm', 'verified result');
  const selected = git(old.cwd, 'rev-parse', 'HEAD'); fs.writeFileSync(path.join(old.cwd, 'file'), 'later dirty');
  await f.recover(f.manager, { baselines: { repo: selected } });
  f.dispatcher.resume(); await f.dispatcher.drain();
  assert.equal(fs.readFileSync(path.join(f.manager.inspect('next').bindings[0].cwd, 'file'), 'utf8'), 'unfinished');
  assert.equal(fs.readFileSync(path.join(old.cwd, 'file'), 'utf8'), 'later dirty');
});

 test('SIGKILL during durable decision leaves replayable operation slots and preserves all content', async () => {
  const f = await fixture();
  const script = `import {createTaskState,atomicTaskWrite} from ${JSON.stringify(new URL('../src/lib/task-state.js', import.meta.url).href)};
    import {createWorktreeManager} from ${JSON.stringify(new URL('../src/lib/worktrees.js', import.meta.url).href)};
    const config=${JSON.stringify(f.options.config)};
    const lifecycle=createTaskState(config,{root:${JSON.stringify(f.state.root)}, request:async()=>(${JSON.stringify(f.tasks.get('next'))})});
    let writes=0; const manager=createWorktreeManager({config,lifecycle,dataDir:${JSON.stringify(f.options.dataDir)},workRoot:${JSON.stringify(f.options.workRoot)},persist(file,value){atomicTaskWrite(file,value);if(++writes===3)process.kill(process.pid,'SIGKILL');}});
    await manager.recover('old',${JSON.stringify(f.oldGen)},'next',${JSON.stringify(f.nextGen)},{acknowledgedStopped:true,baselines:{repo:${JSON.stringify(f.base)}}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let errors=''; child.stderr.on('data', data => errors += data);
  const signal = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', (code, signal) => signal === 'SIGKILL' ? resolve(signal) : reject(Error(errors || String(code)))); });
  assert.equal(signal, 'SIGKILL');
  assert.equal((await f.recover(createWorktreeManager(f.options))).state, 'transferred');
  f.dispatcher.resume(); await f.dispatcher.drain(); assert.equal(f.state.get('next').start_confirmed, true);
});

test('a second manager cannot prepare the target while recovery verifies its lease', async () => {
  const f = await fixture(); let release, reached;
  const blocked = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { reached = resolve; });
  const lifecycle = { ...f.state, withRecovery(...args) {
    const operation = args.pop();
    return f.state.withRecovery(...args, context => operation({ ...context, async validateTarget() {
      reached(); await blocked; return context.validateTarget();
    } }));
  } };
  const recovering = f.recover(createWorktreeManager({ ...f.options, lifecycle }));
  await entered;
  try { await assert.rejects(f.manager.prepare(f.tasks.get('next'), undefined, { generation: f.nextGen }), /operation active/); }
  finally { release(); }
  assert.equal((await recovering).state, 'transferred');
});
