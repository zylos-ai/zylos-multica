/** Durable local claim/report state. Execution occupancy belongs to worktree manager.
 * Requires util-linux flock; an OS lock dying is NOT proof execution has stopped.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './config.js';
import { multicaRequest } from './multica-api.js';
import { removeTaskToken } from './task-tokens.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const closed = state => ['confirmed', 'conflict', 'superseded'].includes(state);
const completeFields = { output: '', pr_url: '', session_id: '', work_dir: '', durable_work_dir: '', branch_name: '', session_rollout_missing: false, retired_session_id: '' };
// Fail responses do not expose session mutation fields; do not accept writes
// whose outcome cannot be verified through the pinned public readback API.
const failFields = { error: '', failure_reason: '', work_dir: '', durable_work_dir: '', branch_name: '' };
function string(value, field) {
  if (typeof value !== 'string' || !value || value.includes('\0') || !value.isWellFormed()) throw new Error(`invalid ${field}`);
  return value;
}
function payloadFor(action, payload) {
  const fields = action === 'complete' ? completeFields : action === 'fail' ? failFields : null;
  if (!fields || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid terminal payload');
  const result = {};
  for (const key of Object.keys(payload).sort()) {
    const value = payload[key];
    if (!Object.hasOwn(fields, key) || typeof value !== typeof fields[key]) throw new Error(`invalid terminal field ${key}`);
    if (typeof value === 'string' && (value.includes('\0') || !value.isWellFormed())) throw new Error(`invalid terminal field ${key}`);
    result[key] = value;
  }
  if (typeof result[action === 'complete' ? 'output' : 'error'] !== 'string') throw new Error('terminal text is required');
  return result;
}
function privateDir(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error('task state root must be a directory, not a symlink');
  fs.chmodSync(root, 0o700);
}
export function atomicTaskWrite(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
/** Parent EOF (including SIGKILL) releases flock, unlike a stale mkdir lock. */
export async function withTaskLock(file, operation) {
  if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) throw new Error('invalid task lock file');
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  fs.closeSync(fd);
  const child = spawn('flock', ['-x', file, 'sh', '-c', 'printf "locked\\n"; cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  // Failure details are intentionally generic: no external request or credentials.
  let held = false;
  let exited = false;
  child.stdin.on('error', () => {});
  const completion = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  try {
    await new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('task state locking requires flock')));
      child.once('close', () => { if (!held) reject(new Error('task state lock acquisition failed')); });
      child.stdout.once('data', data => {
        if (String(data).trim() !== 'locked') return reject(new Error('invalid task lock response'));
        held = true; resolve();
      });
    });
    if (exited) throw new Error('task state lock was lost');
    return await operation();
  } finally {
    child.stdin.end();
    await completion;
  }
}

export function createTaskState(config, options = {}) {
  const root = options.root ?? path.join(DATA_DIR, 'task-state');
  const request = options.request ?? multicaRequest;
  const write = options.write ?? atomicTaskWrite;
  const removeToken = options.removeTaskToken ?? removeTaskToken;
  const now = options.now ?? Date.now;
  const origin = new URL(config.base_url).origin;
  const workspace = string(config.workspace_id, 'workspace_id');
  privateDir(root);
  const key = id => digest([origin, workspace, string(id, 'task_id')]);
  const file = id => path.join(root, `${key(id)}.json`);
  const lock = (id, fn) => withTaskLock(path.join(root, `${key(id)}.lock`), fn);
  function get(id) {
    let record;
    try {
      const fd = fs.openSync(file(id), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { record = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('cannot read task state'); }
    if (record.schema !== 1 || record.origin !== origin || record.workspace_id !== workspace || record.task_id !== id) throw new Error('invalid task state identity');
    return record;
  }
  const save = record => { write(file(record.task_id), record); return record; };
  function current(id, generation) {
    const record = get(id);
    if (!record || !generation || record.generation !== generation) throw new Error('unknown or stale task generation');
    if (record.daemon_id !== config.daemon_id) throw new Error('task belongs to another daemon');
    return record;
  }
  function assertCurrent({ taskId, generation, requireRunning = false }) {
    const record = current(taskId, generation);
    if (record.report) throw new Error('task has a frozen terminal report; execution is blocked');
    if (record.execution.quiesced) throw new Error('task execution is quiesced');
    if (requireRunning && !record.start_confirmed) throw new Error('task start is not confirmed');
    return record;
  }
  function identity(record, remote) {
    return remote && typeof remote === 'object' && remote.id === record.task_id
      && remote.workspace_id === record.workspace_id && remote.agent_id === record.agent_id
      && (remote.issue_id || '') === record.issue_id && (remote.chat_session_id || '') === record.chat_session_id;
  }
  function responseEvidence(remote) {
    // Private state holds only the consumed authority fields, never tokens.
    const fields = ['id', 'workspace_id', 'agent_id', 'runtime_id', 'issue_id', 'chat_session_id', 'status', 'result', 'error', 'failure_reason', 'work_dir', 'branch_name', 'durable_work_dir'];
    return Object.fromEntries(fields.filter(k => Object.hasOwn(remote, k)).map(k => [k, remote[k]]));
  }
  async function cleanup(record) {
    if (!closed(record.report?.state)) return record;
    try { removeToken(record.task_id); record.report.token_cleanup_pending = false; }
    catch { record.report.token_cleanup_pending = true; }
    return save(record);
  }
  async function observe(record, remote) {
    const report = record.report;
    if (!identity(record, remote) || typeof remote.status !== 'string') {
      report.state = 'pending_unknown'; report.reason = 'invalid response identity or shape';
      return save(record);
    }
    report.evidence = responseEvidence(remote);
    if (remote.status === 'completed') {
      if (report.action !== 'complete') report.state = 'superseded';
      else if (!remote.result || typeof remote.result !== 'object' || Array.isArray(remote.result) || typeof remote.result.output !== 'string') {
        report.state = 'pending_unknown'; report.reason = 'completed result is missing';
      } else {
        const differences = Object.keys(completeFields).filter(k => (remote.result[k] ?? completeFields[k]) !== (report.payload[k] ?? completeFields[k]));
        for (const field of ['work_dir', 'branch_name', 'durable_work_dir']) {
          if (report.payload[field] && remote[field] !== report.payload[field]) differences.push(`task.${field}`);
        }
        report.state = differences.length ? 'conflict' : 'confirmed';
        report.differences = differences;
      }
    } else if (['failed', 'cancelled'].includes(remote.status)) {
      if (report.action !== 'fail' || remote.status !== 'failed') report.state = 'superseded';
      else {
        // Empty/omitted reason delegates classification to the server. Compare
        // only a reason we actually supplied, while retaining its authority value.
        const fields = report.payload.failure_reason ? ['error', 'failure_reason'] : ['error'];
        const differences = fields.filter(field => (remote[field] ?? '') !== (report.payload[field] ?? ''));
        for (const field of ['work_dir', 'branch_name', 'durable_work_dir']) {
          // Fail SQL COALESCE preserves old metadata for empty/omitted input.
          if (report.payload[field] && remote[field] !== report.payload[field]) differences.push(`task.${field}`);
        }
        report.state = differences.length ? 'conflict' : 'confirmed';
        report.differences = differences;
      }
    } else if (['queued', 'dispatched', 'waiting_local_directory'].includes(remote.status)) {
      report.state = 'pending_not_running';
    } else report.state = 'pending_unknown';
    if (closed(report.state)) report.confirmed_at = new Date(now()).toISOString();
    save(record); // Authority result is durable BEFORE deleting the active token.
    return closed(report.state) ? cleanup(record) : record;
  }
  async function history(record) {
    const opts = { workspaceHeader: true };
    if (record.issue_id) {
      const rows = await request(config, 'GET', `/api/issues/${encodeURIComponent(record.issue_id)}/task-runs`, undefined, opts);
      if (!Array.isArray(rows)) throw new Error('invalid issue task history');
      const match = rows.find(row => row?.id === record.task_id);
      if (match) return match;
    }
    const cursors = new Set();
    let cursor = '';
    do {
      const suffix = cursor ? `&before=${encodeURIComponent(cursor)}` : '';
      const page = await request(config, 'GET', `/api/agents/${encodeURIComponent(record.agent_id)}/tasks?limit=200${suffix}`, undefined, { ...opts, includeHeaders: true });
      if (!page || !Array.isArray(page.data) || !page.headers) throw new Error('invalid agent task history');
      const match = page.data.find(row => row?.id === record.task_id);
      if (match) return match;
      cursor = page.headers['x-agent-tasks-next-cursor'] || '';
      if (cursor && cursors.has(cursor)) throw new Error('repeated task history cursor');
      cursors.add(cursor);
    } while (cursor);
    return null;
  }
  async function startRequest(record) {
    const response = await request(config, 'POST', `/api/daemon/tasks/${encodeURIComponent(record.task_id)}/start`, {
      runtime_id: record.runtime_id, dispatched_at: record.dispatched_at,
    });
    // Ordinary responses truncate dispatched_at; the server validated the
    // exact original timestamp in our request. Never replace it with the echo.
    if (!identity(record, response) || response.runtime_id !== record.runtime_id || response.status !== 'running') throw new Error('start response did not confirm original claim');
    return response;
  }
  async function send(record) {
    const report = record.report;
    if (report.generation !== record.generation || report.runtime_id !== record.runtime_id
      || report.dispatched_at !== record.dispatched_at || report.payload_digest !== digest(payloadFor(report.action, report.payload))) {
      throw new Error('frozen report binding mismatch');
    }
    // Cached start_confirmed predates any later claim change. Revalidate the
    // exact original claim before EVERY terminal write, including the first.
    try { await startRequest(record); }
    catch {
      record.report.state = 'pending_unknown';
      record.report.reason = 'original claim start confirmation unavailable';
      save(record);
      return reconcileLocked(record, false);
    }
    record.report.attempts++;
    record.report.last_attempt_at = now();
    record.report.state = 'pending_unknown';
    save(record);
    let response;
    try {
      response = await request(config, 'POST', `/api/daemon/tasks/${encodeURIComponent(record.task_id)}/${record.report.action}`, record.report.payload);
    } catch {
      record.report.reason = 'terminal request uncertain; readback required';
      save(record);
      return reconcileLocked(record, false);
    }
    await observe(record, response);
    return record.report.state === 'pending_unknown' ? reconcileLocked(record, false) : record;
  }
  async function reconcileLocked(record, replay) {
    if (!record.report) throw new Error('task has no pending report');
    if (closed(record.report.state)) return cleanup(record);
    let remote;
    try { remote = await history(record); }
    catch { record.report.state = 'pending_unknown'; record.report.reason = 'task history unavailable'; return save(record); }
    if (!remote) { record.report.state = 'pending_unknown'; record.report.reason = 'task result not found'; return save(record); }
    await observe(record, remote);
    if (!replay || closed(record.report.state) || !identity(record, remote) || remote.status !== 'running') return record;
    // An unsent fail (initial exact-claim confirmation failed) may make its
    // first attempt. Once any fail POST was attempted, never blindly repeat it.
    if ((record.report.action !== 'complete' && record.report.attempts !== 0) || !record.start_confirmed || !record.execution.quiesced) return record;
    if (record.report.attempts >= 3 || now() - record.report.last_attempt_at < 1000 * 2 ** record.report.attempts) return record;
    return send(record);
  }
  return {
    root, get, assertCurrent,
    list() {
      return fs.readdirSync(root).filter(name => name.endsWith('.json')).map(name => {
        const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        let record;
        try { record = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
        return record.origin === origin && record.workspace_id === workspace ? get(record.task_id) : null;
      }).filter(Boolean);
    },
    async registerClaim(task) {
      const id = string(task.id, 'task_id');
      for (const field of ['agent_id', 'runtime_id', 'dispatched_at']) string(task[field], field);
      // Keep PostgreSQL microseconds verbatim; do not Date-roundtrip this value.
      if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(task.dispatched_at)) throw new Error('invalid original claim timestamp');
      if (task.workspace_id !== workspace) throw new Error('claim workspace mismatch');
      return lock(id, () => {
        const old = get(id);
        if (old) {
          if (old.runtime_id !== task.runtime_id || old.dispatched_at !== task.dispatched_at || !identity(old, { ...task, id })) throw new Error('task claim changed; reconcile existing generation before recovery');
          return old;
        }
        return save({ schema: 1, origin, workspace_id: workspace, daemon_id: string(config.daemon_id, 'daemon_id'),
          task_id: id, agent_id: task.agent_id, runtime_id: task.runtime_id, dispatched_at: task.dispatched_at,
          issue_id: task.issue_id || '', chat_session_id: task.chat_session_id || '', generation: crypto.randomUUID(),
          created_at: new Date(now()).toISOString(), start_confirmed: false,
          execution: { accepted: false, quiesced: false }, report: null });
      });
    },
    async start(taskId, generation) {
      return lock(taskId, async () => {
        const record = assertCurrent({ taskId, generation });
        try { await startRequest(record); }
        catch (error) { record.start_unknown = true; save(record); throw error; }
        record.start_confirmed = true; record.start_unknown = false;
        return save(record);
      });
    },
    async setDelivery(taskId, generation, delivery) {
      return lock(taskId, () => {
        const record = assertCurrent({ taskId, generation });
        if (!delivery || delivery.endpoint !== `${taskId}@${generation}` || typeof delivery.content !== 'string'
          || !delivery.content || delivery.content.includes('\0') || !delivery.content.isWellFormed()) throw new Error('invalid task delivery');
        const frozen = { content: delivery.content, endpoint: delivery.endpoint };
        if (delivery.dueAt !== undefined) frozen.dueAt = string(delivery.dueAt, 'delivery dueAt');
        if (record.delivery) {
          const existing = { ...record.delivery }; delete existing.delivered; delete existing.delivered_at;
          if (digest(existing) !== digest(frozen)) throw new Error('task delivery conflicts with frozen card');
          return record;
        }
        record.delivery = { ...frozen, delivered: false };
        return save(record);
      });
    },
    async markDelivered(taskId, generation) {
      return lock(taskId, () => {
        const record = assertCurrent({ taskId, generation, requireRunning: true });
        if (!record.delivery) throw new Error('task has no frozen delivery');
        record.delivery.delivered = true; record.delivery.delivered_at = now();
        return save(record);
      });
    },
    async markAccepted(taskId, generation) {
      return lock(taskId, () => {
        const record = assertCurrent({ taskId, generation, requireRunning: true });
        if (record.execution.accepted) return false;
        record.execution.accepted = true; save(record); return true;
      });
    },
    async quiesceUnaccepted(taskId, generation) {
      return lock(taskId, () => {
        const record = current(taskId, generation);
        if (record.execution.accepted) return false;
        record.execution.quiesced = true; save(record); return true;
      });
    },
    async markQuiesced(taskId, generation) {
      return lock(taskId, () => { const record = current(taskId, generation); record.execution.quiesced = true; return save(record); });
    },
    async report(taskId, generation, action, payload) {
      const frozen = payloadFor(action, payload);
      return lock(taskId, async () => {
        const record = current(taskId, generation);
        if (!record.start_confirmed || !record.execution.quiesced) throw new Error('terminal report requires confirmed start and stopped execution');
        if (record.report) {
          if (record.report.action !== action || record.report.payload_digest !== digest(frozen)) throw new Error('terminal payload conflicts with frozen report');
          return reconcileLocked(record, false);
        }
        record.report = { action, payload: frozen, payload_digest: digest(frozen), generation,
          runtime_id: record.runtime_id, dispatched_at: record.dispatched_at,
          state: 'pending', created_at: new Date(now()).toISOString(), attempts: 0 };
        save(record); // Must succeed before ANY terminal POST.
        return send(record);
      });
    },
    async reconcile(taskId, { generation, replay = false } = {}) {
      return lock(taskId, async () => {
        const record = get(taskId);
        if (!record) throw new Error('unknown task');
        // Old callers may read results, but can never write to the platform.
        if (replay) current(taskId, generation);
        return reconcileLocked(record, replay);
      });
    },
  };
}
