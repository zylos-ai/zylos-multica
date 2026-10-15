/** Durable handoff coordinator. A delivery is not execution: begin() admits it once. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTaskEndpoint } from './task-report.js';
import { atomicTaskWrite } from './task-state.js';
import { abandonPreparation, preparationFailure } from './preparation-failure.js';

export function createTaskDispatcher(config, {
  state, worktrees, request, snapshot, render, deliver, root,
  leaseIntervalMs = 15_000, redeliveryMs = 60_000, preparationRetryMs = 15_000, now = Date.now, log = () => {},
}) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error('unsafe preparation directory');
  const scope = `${new URL(config.base_url).origin}|${config.workspace_id}`;
  const filename = id => path.join(root, `${crypto.createHash('sha256').update(`${scope}|${id}`).digest('hex')}.json`);
  const jobs = new Map();
  let stopped = false;
  const save = entry => atomicTaskWrite(filename(entry.task.id), entry);
  function read(id) {
    try { return JSON.parse(fs.readFileSync(filename(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function lease(record) {
    const response = await request(config, 'POST', `/api/daemon/runtimes/${encodeURIComponent(record.runtime_id)}/tasks/${encodeURIComponent(record.task_id)}/prepare-lease`, {}, { timeoutMs: 10_000 });
    if (response?.id !== record.task_id || response.runtime_id !== record.runtime_id || response.workspace_id !== config.workspace_id) throw new Error('prepare lease identity mismatch');
    // The ordinary response has only seconds. Never compare/replace the precise
    // claim timestamp with this echo; start is the server's generation fence.
  }
  async function step(entry, signal) {
    let record = state.get(entry.task.id);
    if (!record || record.generation !== entry.generation) throw new Error('stale dispatch preparation');
    if (record.preparation_failure) {
      await abandonPreparation(state, worktrees, record.task_id, record.generation, record.preparation_failure.reason);
      return;
    }
    if (record.report) {
      record = await state.reconcile(record.task_id, { generation: record.generation, replay: true });
      if (record.report?.state === 'confirmed' && record.report.action === 'complete' && worktrees.inspect(record.task_id)) {
        await worktrees.confirmDelivery(record.task_id, record.generation);
      }
      return;
    }
    if (record.execution.accepted || record.execution.quiesced) return;
    if (record.delivery?.delivered) {
      if (entry.dueAt && Date.parse(entry.dueAt) > now()) return;
      if (now() - (record.delivery.delivered_at ?? 0) < redeliveryMs) return;
    }
    if (!entry.prepared) {
      if (entry.preparationRetry?.terminal) {
        await abandonPreparation(state, worktrees, record.task_id, record.generation, entry.preparationRetry.error);
        return;
      }
      await lease(record);
      if (entry.preparationRetry?.nextAt > now()) return;
      let renewal;
      let leaseError;
      const preparing = new AbortController();
      const abort = () => preparing.abort();
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) preparing.abort();
      const timer = setInterval(() => {
        if (renewal) return;
        renewal = lease(record).catch(error => { leaseError = error; preparing.abort(); }).finally(() => { renewal = null; });
      }, leaseIntervalMs);
      try {
        try {
          await worktrees.prepare(entry.task, undefined, { generation: entry.generation, signal: preparing.signal });
        } catch (error) {
          if (signal.aborted || leaseError) throw error;
          const failure = preparationFailure(error);
          if (!failure) throw error;
          const attempts = (entry.preparationRetry?.attempts ?? 0) + 1;
          const terminal = failure.permanent || attempts >= 3;
          const reason = `preparation failed: ${failure.reason} (${attempts} attempt${attempts === 1 ? '' : 's'})`;
          entry.preparationRetry = { attempts, reason: failure.reason, terminal, error: reason, nextAt: now() + preparationRetryMs * 2 ** (attempts - 1) };
          save(entry);
          if (terminal) {
            clearInterval(timer);
            if (renewal) await renewal;
            // The manager's rejected promise proves its process group stopped;
            // releasePreparation independently refuses active/interrupted owners.
            await abandonPreparation(state, worktrees, record.task_id, record.generation,
              reason);
          }
          return;
        }
        if (renewal) await renewal;
        if (leaseError) throw leaseError;
        signal.throwIfAborted();
        entry.prepared = true;
        save(entry);
      } finally {
        clearInterval(timer);
        signal.removeEventListener('abort', abort);
      }
    }
    // On resume after a lost start response do not renew an inapplicable lease:
    // repeat only original claim-aware start; same running claim is idempotent.
    if (!record.delivery) {
      const content = await render(entry, worktrees.inspect(record.task_id));
      await state.setDelivery(record.task_id, entry.generation, { content, endpoint: `${record.task_id}@${entry.generation}`, ...(entry.dueAt ? { dueAt: entry.dueAt } : {}) });
    }
    signal.throwIfAborted();
    await state.start(record.task_id, entry.generation);
    record = state.get(record.task_id);
    if (record.execution.accepted) return;
    if (!await deliver(record.delivery, entry.task)) throw new Error('C4 delivery unconfirmed');
    await state.markDelivered(record.task_id, entry.generation);
  }
  function schedule(entry) {
    if (stopped || jobs.has(entry.task.id)) return;
    const controller = new AbortController();
    const promise = step(entry, controller.signal).catch(error => log('WARN', 'task preparation/handoff deferred', { task_id: entry.task.id, reason: error.code === 'WORKTREE_BUSY' ? 'workline occupied' : 'inspect retained preparation and claim state' }))
      .finally(() => jobs.delete(entry.task.id));
    jobs.set(entry.task.id, { controller, promise });
  }
  return {
    async enqueue(task) {
      const record = await state.registerClaim(task);
      let entry = read(task.id);
      if (record.preparation_failure) {
        schedule(entry || { scope, task: { id: task.id }, generation: record.generation });
        return true;
      }
      if (!entry) {
        let material;
        try { material = await snapshot(task); }
        catch {
          // Context is required for safe execution. Do not persist the raw claim
          // (it contains credentials), nor retry an incomplete snapshot forever.
          await state.abandonPreparation(task.id, record.generation,
            'preparation failed: task context materialization failed; inspect retained task context');
          schedule({ scope, task: { id: task.id }, generation: record.generation });
          return true;
        }
        entry = { scope, ...material, generation: record.generation, prepared: false };
        if (entry.task.id !== task.id) throw new Error('invalid task snapshot identity');
        save(entry);
      }
      if (entry.scope !== scope || entry.generation !== record.generation) throw new Error('dispatch snapshot identity mismatch');
      schedule(entry);
      return true;
    },
    async failScheduled(endpoint, error) {
      const { taskId, generation } = parseTaskEndpoint(endpoint);
      const record = state.get(taskId);
      if (!record || record.generation !== generation) throw new Error('unknown scheduled task generation');
      if (record.execution.accepted) return; // Scheduler failure cannot terminate already admitted work.
      if (record.report) return state.reconcile(taskId, { generation, replay: true });
      if (!record.delivery?.dueAt) throw new Error('task has no scheduled handoff');
      // No begin admission occurred, so no task commands/native edits were authorized.
      if (!await state.quiesceUnaccepted(taskId, generation)) return;
      await worktrees.quiesce(taskId, generation, { acknowledgedStopped: true });
      await state.markQuiesced(taskId, generation);
      return state.report(taskId, generation, 'fail', { error, failure_reason: 'runtime_offline' });
    },
    resume() {
      // CLI abandonment can predate the handoff snapshot (e.g. context failure).
      for (const record of state.list()) if (record.preparation_failure && !read(record.task_id)) {
        schedule({ task: { id: record.task_id }, generation: record.generation, scope });
      }
      for (const name of fs.readdirSync(root).filter(name => name.endsWith('.json'))) {
        const entry = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
        if (entry.scope === scope) schedule(entry);
      }
    },
    async drain() { await Promise.all([...jobs.values()].map(job => job.promise)); },
    stop() { stopped = true; for (const job of jobs.values()) job.controller.abort(); },
  };
}
