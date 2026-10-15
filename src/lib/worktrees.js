/** Task-bound directories for the live session; no runtime or global cwd changes. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { withTaskLock } from './task-state.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) throw new Error(`invalid ${label}`);
  return value;
};
export class WorktreeBusyError extends Error { constructor(message = 'workline occupied; keep preparing lease and retry') { super(message); this.code = 'WORKTREE_BUSY'; } }
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function directory(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('symlink/non-directory in controlled worktree data path');
  }
}
function write(file, value) {
  directory(path.dirname(file));
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}
function exclusive(file, value) {
  directory(path.dirname(file));
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function cleanGitEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return { ...env, GIT_TERMINAL_PROMPT: '0', ...extra };
}
// A direct-child close does not prove its process-group descendants exited.
async function groupStopped(pid) {
  if (!pid || process.platform === 'win32') return true;
  try { process.kill(-pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
  if (process.platform !== 'linux') return false;
  const entries = await fs.promises.readdir('/proc');
  const states = await Promise.all(entries.filter((entry) => /^\d+$/.test(entry)).map(async (entry) => {
    try {
      const stat = await fs.promises.readFile(`/proc/${entry}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      return Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0]);
    } catch (error) { return error.code !== 'ENOENT' && error.code !== 'ESRCH'; }
  }));
  return !states.some(Boolean);
}
function processStopper(child) {
  let stopping;
  return () => {
    if (stopping) return stopping;
    const kill = (name) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch {}
    };
    kill('SIGTERM');
    stopping = new Promise((resolve) => setTimeout(resolve, 1000)).then(async () => {
      kill('SIGKILL');
      for (let attempt = 0; attempt < 200; attempt++) {
        if (await groupStopped(child.pid)) return true;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    }).catch(() => false);
    return stopping;
  };
}
export function runGit(cwd, args, env = {}, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Git preparation aborted')); return; }
    const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd, env: cleanGitEnv(env), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', size = 0, failed = false, stopping;
    const stopGroup = processStopper(child);
    const stop = () => { failed = true; stopping ??= stopGroup(); };
    const timeout = setTimeout(stop, 120_000);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (data) => { size += data.length; if (size > 16 * 1024 * 1024) stop(); else stdout += data; });
    child.stderr.on('data', (data) => { size += data.length; if (size > 16 * 1024 * 1024) stop(); });
    child.on('error', () => { failed = true; });
    // Do not release preparation ownership on the error/abort event: wait for
    // process exit and closed stdio, including Git's helpers in this group.
    child.on('close', async (code) => {
      clearTimeout(timeout); signal?.removeEventListener('abort', stop);
      if (!await (stopping || groupStopped(child.pid).catch(() => false))) { const error = new Error('Git process-group stop unconfirmed'); error.code = 'PROCESS_STOP_UNCONFIRMED'; reject(error); return; }
      if (failed || code !== 0) reject(new Error(signal?.aborted ? 'Git preparation aborted' : 'git operation failed; inspect preserved task directory'));
      else resolve(stdout.trimEnd());
    });
  });
}

function remoteURL(value) {
  const url = string(value, 'repository URL');
  if (/^git@[A-Za-z0-9.-]+:[A-Za-z0-9_./-]+$/.test(url)) return url;
  const parsed = new URL(url);
  if (!['https:', 'http:', 'ssh:'].includes(parsed.protocol) || parsed.password
    || (parsed.protocol !== 'ssh:' && parsed.username) || parsed.search || parsed.hash) throw new Error('unsupported repository URL');
  return url;
}

export function resolveExecutionResources(task, config) {
  const resources = task.project_resources ?? [];
  if (!Array.isArray(resources)) throw new Error('invalid project_resources');
  const locals = (task.is_leader_task ? [] : resources).filter((resource) => resource.resource_type === 'local_directory')
    .filter((resource) => {
      string(resource.resource_ref?.daemon_id, 'local_directory daemon_id');
      return resource.resource_ref.daemon_id === config.daemon_id;
    });
  if (locals.length > 1) throw new Error('multiple local_directory resources for this daemon');
  const result = locals.map((resource) => {
    const ref = resource.resource_ref;
    const mode = ref.execution_mode?.trim() || 'in_place';
    if (!['in_place', 'worktree'].includes(mode)) throw new Error('unsupported local_directory execution_mode');
    const local = string(ref.local_path, 'local_directory local_path');
    if (!path.isAbsolute(local)) throw new Error('local_directory path must be absolute');
    const real = fs.realpathSync(local);
    if (!fs.statSync(real).isDirectory()) throw new Error('local_directory is not a directory');
    return { id: string(resource.id, 'resource id'), type: 'local_directory', mode, source: real };
  });
  // The claim already resolved project-vs-workspace repo precedence. Match
  // resource IDs when available, but never append unselected resource URLs.
  if (!Array.isArray(task.repos ?? [])) throw new Error('invalid repos');
  for (const repo of task.repos ?? []) {
    const url = remoteURL(repo.url);
    const resource = resources.find((entry) => entry.resource_type === 'github_repo' && entry.resource_ref?.url === url);
    const ref = repo.ref || 'HEAD';
    string(ref, 'repository ref');
    if (Buffer.byteLength(ref) > 255 || ref.startsWith('-') || /[\x00-\x20\x7f~^:?*\[\\]/.test(ref)
      || ref.includes('..') || ref.includes('@{') || ref === '@' || ref.startsWith('/') || ref.endsWith('/')
      || ref.includes('//') || ref.endsWith('.') || ref.split('/').some((part) => part.startsWith('.') || part.endsWith('.lock'))) {
      throw new Error('invalid repository ref');
    }
    result.push({ id: resource?.id || `repo-${hash(url)}`, type: 'github_repo', mode: 'worktree', source: url, ref });
  }
  if (new Set(result.map((resource) => resource.id)).size !== result.length) throw new Error('duplicate execution resource');
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function createWorktreeManager({ dataDir = path.join(os.homedir(), 'zylos/components/multica/execution'), workRoot = path.join(os.homedir(), 'zylos/workspace/multica'), config, lifecycle, git = runGit, persist = write }) {
  if (!lifecycle?.assertCurrent) throw new Error('worktree manager requires lifecycle admission gate');
  const invokeGit = git;
  const root = path.resolve(dataDir);
  const contentRoot = path.resolve(workRoot);
  const taskKey = (id) => hash([config.base_url, config.workspace_id, string(id, 'task id')]);
  const recordPath = (id) => path.join(root, 'bindings', `${taskKey(id)}.json`);
  const owner = (id, generation) => ({ task: taskKey(id), generation });
  const same = (a, b) => a?.task === b.task && a?.generation === b.generation;
  const lockPath = (key) => path.join(root, 'owners', `${key}.json`);
  const headPath = (key) => path.join(root, 'heads', `${key}.json`);
  const opPath = (id) => path.join(root, 'operations', `${taskKey(id)}.json`);
  const processes = new Map();
  const activeOperations = new Set();
  const assert = (taskId, generation, requireRunning = false) => lifecycle.assertCurrent({ taskId, generation, requireRunning });
  function operation(taskId, generation) {
    try { exclusive(opPath(taskId), owner(taskId, generation)); }
    catch (error) { if (error.code === 'EEXIST') throw new WorktreeBusyError('task operation active or interrupted; explicit stop confirmation required'); throw error; }
    activeOperations.add(taskKey(taskId));
    return () => { activeOperations.delete(taskKey(taskId)); fs.unlinkSync(opPath(taskId)); };
  }
  function inspect(taskId) { return read(recordPath(taskId)); }
  function load(taskId, generation) {
    const record = inspect(taskId);
    if (!record || record.task_id !== taskId || record.generation !== generation) throw new Error('worktree binding generation mismatch');
    return record;
  }
  function save(record) { persist(recordPath(record.task_id), record); }
  function acquire(keys, identity, paths = new Map()) {
    const created = [];
    // Serialize overlap inspection + publication across all manager processes.
    // A crashed holder is recovered only by explicit stop acknowledgement.
    const coordinationKey = 'in-place-coordination';
    if (paths.size) {
      try { exclusive(lockPath(coordinationKey), identity); }
      catch (error) { if (error.code === 'EEXIST') throw new WorktreeBusyError('in_place coordination active or interrupted'); throw error; }
    }
    try {
      if (paths.size) for (const name of fs.readdirSync(path.join(root, 'owners'))) {
        if (!name.startsWith('path-') || !name.endsWith('.json')) continue;
        const held = read(path.join(root, 'owners', name));
        if (!held || same(held, identity)) continue;
        // Unknown old metadata is conservatively occupied until recovered.
        if (!held.source || [...paths.values()].some((source) => {
          const contains = (parent, child) => {
            const relative = path.relative(parent, child);
            return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
          };
          return contains(source, held.source) || contains(held.source, source);
        })) throw new WorktreeBusyError('overlapping in_place directory occupied');
      }
      for (const key of [...new Set(keys)].sort()) {
        try { exclusive(lockPath(key), paths.has(key) ? { ...identity, source: paths.get(key) } : identity); created.push(key); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          if (!same(read(lockPath(key)), identity)) throw new WorktreeBusyError();
        }
      }
    } catch (error) {
      // No preparation has run yet. Release only this attempt's new locks.
      for (const key of created) fs.unlinkSync(lockPath(key));
      throw error;
    } finally { if (paths.size) release(coordinationKey, identity); }
  }
  function release(key, identity) {
    if (!same(read(lockPath(key)), identity)) throw new Error('worktree ownership changed');
    fs.unlinkSync(lockPath(key));
  }
  async function snapshot(repo, taskRoot, signal) {
    const git = (cwd, args, env) => invokeGit(cwd, args, env, { signal });
    signal?.throwIfAborted();
    const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      .filter((name) => !name.split('/').some((part) => ['.agent_context', '.multica'].includes(part)));
    if (untracked.length > 2000 || untracked.reduce((sum, name) => sum + fs.lstatSync(path.join(repo, name)).size, 0) > 200 * 1024 * 1024) {
      throw new Error('local snapshot exceeds 2000 untracked files / 200 MiB');
    }
    const base = await git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const index = path.join(taskRoot, `snapshot-index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    const sourceIndex = await git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
    if (fs.existsSync(sourceIndex)) { await fs.promises.copyFile(sourceIndex, index); fs.chmodSync(index, 0o600); }
    else await git(repo, ['read-tree', base], env);
    await git(repo, ['add', '-A', '--', '.', ':(exclude,glob)**/.agent_context/**', ':(exclude,glob)**/.multica/**'], env);
    const tree = await git(repo, ['write-tree'], env);
    if (tree === await git(repo, ['rev-parse', `${base}^{tree}`])) return { commit: base, tree };
    const commit = await git(repo, ['-c', 'user.name=Zylos snapshot', '-c', 'user.email=snapshot@localhost', 'commit-tree', tree, '-p', base, '-m', 'Task source snapshot (user working directory unchanged)']);
    return { commit, tree };
  }
  async function checkBinding(binding, signal) {
    const git = (cwd, args, env) => invokeGit(cwd, args, env, { signal });
    signal?.throwIfAborted();
    if (!fs.existsSync(binding.cwd)) throw new Error('bound working directory is missing');
    if (fs.realpathSync(binding.cwd) !== binding.cwd) throw new Error('bound working directory was replaced by a symlink');
    if (binding.mode === 'worktree') {
      if (await git(binding.cwd, ['rev-parse', '--show-toplevel']) !== binding.worktree
        || await git(binding.cwd, ['branch', '--show-current']) !== binding.branch
        || fs.realpathSync(await git(binding.cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])) !== binding.common_dir) {
        throw new Error('bound Git root/branch ownership mismatch');
      }
    }
  }
  async function prepare(task, resources = resolveExecutionResources(task, config), { generation, signal } = {}) {
    const git = (cwd, args, env) => invokeGit(cwd, args, env, { signal });
    signal?.throwIfAborted();
    string(generation, 'execution generation');
    if (resources.length) string(task.agent_id || task.agent?.id, 'agent id');
    assert(task.id, generation);
    const unlock = operation(task.id, generation);
    let uncertainStop = false;
    try {
      let record = inspect(task.id);
      if (record && record.generation !== generation) throw new Error('existing task generation cannot be replaced');
      const resourceDigest = hash(resources);
      if (record && record.resource_digest !== resourceDigest) throw new Error('execution resources changed for existing task');
      if (record?.recovery_input?.state === 'pending') throw new WorktreeBusyError('recovery decision requires replay');
      if (record?.phase === 'prepared') { for (const binding of record.bindings) await checkBinding(binding, signal); return record; }
      if (record && record.phase !== 'preparing') throw new Error('task directory is quiesced or awaiting delivery');
      if (!record) {
        const taskRoot = path.join(contentRoot, 'tasks', taskKey(task.id), hash(generation));
        directory(taskRoot);
        const bindings = await Promise.all(resources.map(async (resource) => {
          const repo = resource.type === 'local_directory'
            ? (resource.mode === 'worktree' ? fs.realpathSync(await git(resource.source, ['rev-parse', '--show-toplevel'])) : resource.source)
            : path.join(contentRoot, 'repos', hash(resource.source));
          const conversation = task.issue_id ? ['issue', task.issue_id] : task.chat_session_id ? ['chat', task.chat_session_id] : ['task', task.id];
          const line = hash([config.base_url, config.workspace_id, task.agent_id || task.agent?.id, ...conversation, resource.id, resource.source, repo, resource.mode, resource.ref || null]);
          const base = path.join(taskRoot, hash(resource.id));
          return { ...resource, repo, line_key: line, path_key: resource.mode === 'in_place' ? `path-${hash(resource.source)}` : null,
            task_root: base, worktree: resource.mode === 'worktree' ? path.join(base, 'worktree') : resource.source,
            cwd: resource.mode === 'worktree' ? null : resource.source,
            branch: resource.mode === 'worktree' ? `zylos/${taskKey(task.id)}/${hash([resource.id, generation])}` : null,
            phase: 'preparing' };
        }));
        record = { schema: 1, task_id: task.id, generation, runtime_id: task.runtime_id, dispatched_at: task.dispatched_at,
          resource_digest: resourceDigest, phase: 'preparing', bindings, commands: [], execution: { quiesced: false } };
        save(record);
      }
      acquire(record.bindings.flatMap((binding) => [binding.line_key, binding.path_key].filter(Boolean)), owner(task.id, generation),
        new Map(record.bindings.filter((binding) => binding.path_key).map((binding) => [binding.path_key, binding.source])));
      for (const binding of record.bindings) {
        signal?.throwIfAborted();
        assert(task.id, generation);
        if (binding.phase === 'prepared') { await checkBinding(binding, signal); continue; }
        directory(binding.task_root);
        if (binding.mode === 'in_place') { await checkBinding(binding, signal); binding.phase = 'prepared'; save(record); continue; }
        const cacheKey = `git-prepare-${hash(binding.repo)}`;
        try { exclusive(lockPath(cacheKey), owner(task.id, generation)); }
        catch (error) { if (error.code === 'EEXIST') throw new WorktreeBusyError('repository preparation active or interrupted'); throw error; }
        try {
          if (binding.type === 'github_repo' && !fs.existsSync(binding.repo)) {
            directory(path.dirname(binding.repo));
            await git(root, ['clone', '--bare', '--', binding.source, binding.repo]);
          }
          if (binding.type === 'github_repo') {
            if (fs.realpathSync(binding.repo) !== binding.repo || await git(binding.repo, ['rev-parse', '--is-bare-repository']) !== 'true'
              || await git(binding.repo, ['remote', 'get-url', 'origin']) !== binding.source) throw new Error('controlled repository cache identity mismatch');
          }
          if (binding.type === 'github_repo' && !binding.base_commit && !binding.recovery_base) {
            await git(binding.repo, ['fetch', '--no-tags', 'origin', binding.ref]);
          }
          binding.common_dir = fs.realpathSync(await git(binding.repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
          if (!binding.base_commit) {
            const captured = binding.recovery_base ? { commit: binding.recovery_base, tree: binding.recovery_source_tree }
              : binding.type === 'local_directory' ? await snapshot(binding.repo, binding.task_root, signal)
              : { commit: await git(binding.repo, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']), tree: null };
            const head = read(headPath(binding.line_key));
            if (!binding.recovery_base && head && binding.type === 'local_directory' && head.source_tree !== captured.tree) {
              throw new Error('source changed since confirmed delivery; explicit baseline selection required');
            }
            binding.base_commit = binding.recovery_base || head?.commit || captured.commit;
            binding.source_snapshot = captured.commit;
            binding.snapshot_ref = `refs/zylos/snapshots/${taskKey(task.id)}/${hash([binding.id, generation, captured.commit])}`;
            await git(binding.repo, ['update-ref', binding.snapshot_ref, captured.commit]);
            binding.source_tree = captured.tree;
            binding.cwd = path.join(binding.worktree, binding.type === 'local_directory' ? path.relative(binding.repo, binding.source) : '');
            // Freeze the selected base before creating any branch/worktree.
            save(record);
          }
          if (!fs.existsSync(binding.worktree)) {
            const branches = await git(binding.repo, ['for-each-ref', '--format=%(refname)', `refs/heads/${binding.branch}`]);
            if (branches) throw new Error('task branch already exists without its bound worktree; inspect before recovery');
            await git(binding.repo, ['worktree', 'add', '-b', binding.branch, binding.worktree, binding.base_commit]);
          }
          await checkBinding(binding, signal);
          binding.phase = 'prepared'; save(record);
        } catch (error) { if (error.code === 'PROCESS_STOP_UNCONFIRMED') uncertainStop = true; throw error; }
        finally { if (!uncertainStop) release(cacheKey, owner(task.id, generation)); }
      }
      signal?.throwIfAborted(); assert(task.id, generation);
      record.phase = 'prepared'; save(record); return record;
    } catch (error) { if (error.code === 'PROCESS_STOP_UNCONFIRMED') uncertainStop = true; throw error; }
    finally { if (!uncertainStop) unlock(); else activeOperations.delete(taskKey(task.id)); }
  }
  async function locate(taskId, generation, resourceId) {
    assert(taskId, generation, true);
    const record = load(taskId, generation);
    if (record.phase !== 'prepared') throw new Error('task is not executable');
    const binding = record.bindings.find((item) => item.id === resourceId);
    if (!binding) throw new Error('unknown task resource');
    if (!same(read(lockPath(binding.line_key)), owner(taskId, generation))) throw new Error('workline ownership missing');
    if (binding.path_key && !same(read(lockPath(binding.path_key)), owner(taskId, generation))) throw new Error('in_place ownership missing');
    await checkBinding(binding); assert(taskId, generation, true); return binding;
  }
  async function run(taskId, generation, resourceId, argv, { signal } = {}) {
    if (!Array.isArray(argv) || !argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('command argv required');
    const unlock = operation(taskId, generation);
    let command;
    try {
      const record = load(taskId, generation);
      if (record.commands.some((command) => !['exited', 'stopped_confirmed'].includes(command.status))) throw new WorktreeBusyError('prior command exit is unconfirmed');
      const binding = await locate(taskId, generation, resourceId);
      assert(taskId, generation, true);
      command = { id: randomUUID(), resource_id: resourceId, status: 'running', started_at: new Date().toISOString() };
      record.commands.push(command); save(record);
      return await new Promise((resolve, reject) => {
        let stdout = '', stderr = '', bytes = 0;
        const child = spawn(argv[0], argv.slice(1), { cwd: binding.cwd, env: cleanGitEnv(), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
        let stopping, spawnError, finish;
        const done = new Promise((resolveDone) => { finish = resolveDone; });
        const stopGroup = processStopper(child);
        const stop = () => { stopping ??= stopGroup(); };
        processes.set(command.id, { taskId, generation, child, stop, done });
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
        const collect = (field, data) => { bytes += data.length; if (bytes > 16 * 1024 * 1024) { stop(); return; } if (field === 'out') stdout += data; else stderr += data; };
        child.stdout.on('data', (data) => collect('out', data)); child.stderr.on('data', (data) => collect('err', data));
        child.on('error', (error) => { spawnError = error; });
        child.on('close', async (code, exitSignal) => {
          signal?.removeEventListener('abort', stop);
          const stopped = await (stopping || groupStopped(child.pid).catch(() => false));
          processes.delete(command.id);
          command.status = stopped ? 'exited' : 'stop_unconfirmed'; command.code = code; command.signal = exitSignal;
          try { save(record); } catch { reject(new Error('command exited but durable confirmation failed')); finish(); return; }
          if (!stopped) reject(new Error('command process-group stop unconfirmed'));
          else if (spawnError) reject(new Error('task command could not finish normally'));
          else resolve({ code, signal: exitSignal, stdout, stderr, truncated: bytes > 16 * 1024 * 1024, cwd: binding.cwd, branch: binding.branch });
          finish();
        });
      });
    } finally { unlock(); }
  }
  async function cancelCommands(taskId, generation) {
    load(taskId, generation);
    const commands = [...processes.values()].filter((entry) => entry.taskId === taskId && entry.generation === generation);
    for (const command of commands) command.stop();
    await Promise.all(commands.map((command) => command.done));
    // Empty here does not prove a command from another process is stopped.
    return { stopped: commands.length, still_requires_quiescence_acknowledgement: true };
  }
  async function quiesce(taskId, generation, { acknowledgedStopped = false } = {}) {
    if (!acknowledgedStopped) throw new Error('live-session stop acknowledgement required');
    const unlock = operation(taskId, generation);
    try {
      const record = load(taskId, generation);
      if (record.commands.some((command) => !['exited', 'stopped_confirmed'].includes(command.status))) throw new WorktreeBusyError('command exit is unconfirmed');
      if (record.execution.quiesced) {
        for (const binding of record.bindings) if (binding.path_key && same(read(lockPath(binding.path_key)), owner(taskId, generation))) release(binding.path_key, owner(taskId, generation));
        return record;
      }
      for (const binding of record.bindings) {
        await checkBinding(binding);
        binding.artifacts = { status: binding.mode === 'worktree' ? await git(binding.cwd, ['status', '--porcelain=v1', '-z']) : null,
          commit: binding.mode === 'worktree' ? await git(binding.cwd, ['rev-parse', 'HEAD']) : null };
      }
      record.execution.quiesced = true; record.phase = 'awaiting_delivery'; save(record);
      for (const binding of record.bindings) if (binding.path_key) release(binding.path_key, owner(taskId, generation));
      return record;
    } finally { unlock(); }
  }
  async function confirmDelivery(taskId, generation) {
    const unlock = operation(taskId, generation);
    try {
      const state = lifecycle.get(taskId);
      const record = load(taskId, generation);
      if (state?.generation !== generation || state?.report?.state !== 'confirmed' || state.report.action !== 'complete') throw new Error('platform complete confirmation required');
      if (!record.execution.quiesced) throw new Error('execution stop confirmation required');
      if (record.phase === 'delivered') return record;
      const deliveries = [];
      if (record.phase !== 'delivery_confirmed') for (const binding of record.bindings) {
        await checkBinding(binding);
        if (binding.mode === 'worktree') {
          if (await git(binding.cwd, ['status', '--porcelain=v1', '-z']) || binding.artifacts?.commit !== await git(binding.cwd, ['rev-parse', 'HEAD'])) {
            throw new Error('uncommitted or changed delivery; explicit continuation choice required');
          }
          deliveries.push(binding);
        }
      }
      for (const binding of deliveries) write(headPath(binding.line_key), { task_id: taskId, generation, commit: binding.artifacts.commit,
        branch: binding.branch, source_tree: binding.source_tree });
      record.phase = 'delivery_confirmed'; save(record);
      for (const binding of record.bindings) if (same(read(lockPath(binding.line_key)), owner(taskId, generation))) release(binding.line_key, owner(taskId, generation));
      record.phase = 'delivered'; save(record);
      return record;
    } finally { unlock(); }
  }
  /** Explicit transfer; the old failed execution and its artifacts are immutable.
   * The lifecycle locks serialize against begin/report, operation slots against
   * prepare/exec. A recovery-only OS lock lets a crashed recovery reclaim ONLY
   * its own marked operation slots; ordinary interrupted preparation stays busy.
   */
  async function recover(taskId, generation, targetId, targetGeneration, { acknowledgedStopped = false, baselines } = {}) {
    if (!acknowledgedStopped) throw new Error('explicit execution and preparation stop acknowledgement required');
    if (!baselines || typeof baselines !== 'object' || Array.isArray(baselines)) throw new Error('explicit baselines required');
    for (const commit of Object.values(baselines)) if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('baseline must be an exact commit SHA');
    const choice = { task_id: taskId, generation, target_id: targetId, target_generation: targetGeneration,
      baselines: Object.fromEntries(Object.entries(baselines).sort(([a], [b]) => a.localeCompare(b))) };
    const recoveryId = hash(choice);
    directory(root);
    return withTaskLock(path.join(root, 'recovery.lock'), () => lifecycle.withRecovery(taskId, generation, targetId, targetGeneration, async ({ source, target, validateTarget }) => {
      const record = load(taskId, generation);
      if (record.recovery && record.recovery.id !== recoveryId) throw new Error('conflicting recovery decision');
      const next = load(targetId, targetGeneration);
      if (record.runtime_id !== source.runtime_id || record.dispatched_at !== source.dispatched_at
        || next.runtime_id !== target.runtime_id || next.dispatched_at !== target.dispatched_at) throw new Error('binding claim identity mismatch');
      if (record.recovery?.state === 'transferred' && next.recovery_input?.id === recoveryId && next.recovery_input.state === 'transferred') return record.recovery;
      if (!record.execution.quiesced || record.commands.some(command => !['exited', 'stopped_confirmed'].includes(command.status))) throw new Error('source execution stop is unconfirmed');
      if (target.report || target.execution.quiesced || target.execution.accepted || target.start_confirmed || target.start_unknown) throw new Error('continuation is no longer preparing');
      if (next.phase !== 'preparing' || next.commands.length || next.execution.quiesced) throw new Error('continuation binding is not preparing');
      if (next.recovery_input && next.recovery_input.id !== recoveryId) throw new Error('continuation has another recovery decision');
      if (!record.bindings.length || record.bindings.length !== next.bindings.length || Object.keys(baselines).length !== record.bindings.length) throw new Error('recovery resource set mismatch');
      const locks = [];
      try {
        for (const [id, gen] of [[taskId, generation], [targetId, targetGeneration]]) {
          const identity = { ...owner(id, gen), recovery: recoveryId };
          const existing = read(opPath(id));
          if (existing && (!same(existing, identity) || existing.recovery !== recoveryId)) throw new WorktreeBusyError('execution or preparation operation is active or interrupted');
          if (!existing) exclusive(opPath(id), identity);
          locks.push([id, identity]);
        }
        if (record.recovery?.state === 'transferred') {
          if (next.recovery_input?.id !== recoveryId) throw new Error('continuation recovery record mismatch');
          next.recovery_input.state = 'transferred'; persist(recordPath(targetId), next);
          return record.recovery;
        }
        await validateTarget();
        for (const binding of record.bindings) {
          const destination = next.bindings.find(item => item.id === binding.id);
          if (!destination || destination.line_key !== binding.line_key || binding.mode !== 'worktree'
            || destination.base_commit || destination.phase !== 'preparing' || !baselines[binding.id]) throw new Error('continuation resource/baseline mismatch (worktree mode required)');
          if (fs.existsSync(destination.worktree)) throw new Error('continuation already has a worktree');
          if (read(lockPath(`git-prepare-${hash(binding.repo)}`))) throw new WorktreeBusyError('repository preparation stop is unconfirmed');
          const held = read(lockPath(binding.line_key));
          if (!same(held, owner(taskId, generation)) && !(record.recovery && same(held, owner(targetId, targetGeneration)))) throw new Error('workline ownership mismatch');
          await checkBinding(binding);
          if (await invokeGit(binding.repo, ['rev-parse', '--verify', `${baselines[binding.id]}^{commit}`]) !== baselines[binding.id]) throw new Error('baseline commit not verified');
          destination.recovery_base = baselines[binding.id];
          destination.recovery_source_tree = binding.source_tree;
        }
        // A durable decision precedes every ownership mutation. Target remains
        // non-executable until every line is transferred and replay completes.
        record.recovery ??= { ...choice, id: recoveryId, state: 'pending', decided_at: new Date().toISOString() };
        persist(recordPath(taskId), record);
        next.recovery_input = { id: recoveryId, source_id: taskId, source_generation: generation, state: 'pending' };
        persist(recordPath(targetId), next);
        for (const binding of record.bindings) {
          const held = read(lockPath(binding.line_key));
          if (!same(held, owner(taskId, generation)) && !same(held, owner(targetId, targetGeneration))) throw new Error('workline ownership changed');
          // Replacement has no unlocked interval in which a third run can win.
          persist(lockPath(binding.line_key), owner(targetId, targetGeneration));
        }
        record.recovery.state = 'transferred'; persist(recordPath(taskId), record);
        next.recovery_input.state = 'transferred'; persist(recordPath(targetId), next);
        return record.recovery;
      } finally {
        for (const [id, identity] of locks) {
          const held = read(opPath(id));
          if (same(held, identity) && held.recovery === recoveryId) fs.unlinkSync(opPath(id));
        }
      }
    }));
  }
  // Explicit recovery acknowledgement is required: an old bridge's subprocess
  // may still be running. Never infer termination from a PID, TTL or cancel.
  function acknowledgeStopped(taskId, generation, { acknowledgedStopped = false } = {}) {
    if (!acknowledgedStopped) throw new Error('explicit execution/command stop acknowledgement required');
    if (activeOperations.has(taskKey(taskId))) throw new WorktreeBusyError('this manager still tracks an active task operation');
    const record = load(taskId, generation);
    const existing = read(opPath(taskId));
    if (existing?.recovery) throw new WorktreeBusyError('replay the recorded recovery; do not clear its operation slot');
    if (existing && !same(existing, owner(taskId, generation))) throw new Error('operation owner mismatch');
    for (const command of record.commands) if (!['exited', 'stopped_confirmed'].includes(command.status)) command.status = 'stopped_confirmed';
    save(record);
    if (existing) fs.unlinkSync(opPath(taskId));
    if (same(read(lockPath('in-place-coordination')), owner(taskId, generation))) release('in-place-coordination', owner(taskId, generation));
    for (const binding of record.bindings) {
      const key = `git-prepare-${hash(binding.repo)}`;
      if (same(read(lockPath(key)), owner(taskId, generation))) release(key, owner(taskId, generation));
    }
    return record;
  }
  return { prepare, inspect, locate, run, cancelCommands, quiesce, confirmDelivery, acknowledgeStopped, recover };
}
