/** Durable handoff coordinator. A delivery is not execution: begin() admits it once. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTaskEndpoint } from './task-report.js';
import { atomicTaskWrite } from './task-state.js';
import { finishAbandonment } from './agent-execution.js';

export function createTaskDispatcher(config, {
  state, snapshot, render, deliver, root,
  redeliveryMs = 60_000, now = Date.now, log = () => {},
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
  async function step(entry, signal) {
    let record = state.get(entry.task.id);
    if (!record || record.generation !== entry.generation) throw new Error('stale dispatch preparation');
    // Prior versions persisted this terminal decision before lifecycle failure.
    // Preserve that crash window; nonterminal old Git retry counters are inert.
    if (!record.preparation_failure && entry.preparationRetry?.terminal) {
      await finishAbandonment(state, record.task_id, record.generation,
        entry.preparationRetry.error, { config });
      return;
    }
    if (record.preparation_failure) {
      await finishAbandonment(state, record.task_id, record.generation, record.preparation_failure.reason, { config });
      return;
    }
    if (record.report) {
      record = await state.reconcile(record.task_id, { generation: record.generation, replay: true });
      return;
    }
    if (record.execution.accepted || record.execution.quiesced) return;
    if (record.delivery?.delivered) {
      if (entry.dueAt && Date.parse(entry.dueAt) > now()) return;
      if (now() - (record.delivery.delivered_at ?? 0) < redeliveryMs) return;
    }
    // On resume after a lost start response do not renew an inapplicable lease:
    // repeat only original claim-aware start; same running claim is idempotent.
    if (!record.delivery || record.delivery.resource_model !== 'agent-owned-v1') {
      const content = await render(entry);
      await state.setAgentDelivery(record.task_id, entry.generation, { content, endpoint: `${record.task_id}@${entry.generation}`, ...(entry.dueAt ? { dueAt: entry.dueAt } : {}) });
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
    const promise = step(entry, controller.signal).catch(error => log('WARN', 'task handoff deferred', { task_id: entry.task.id, reason: 'inspect retained task and claim state' }))
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
        entry = { scope, ...material, generation: record.generation, resource_model: 'agent-owned-v1' };
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
