/** Durable handoff coordinator. A delivery is not execution: begin() admits it once. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseTaskEndpoint, buildTaskEndpoint } from './session-group.js';
import { atomicTaskWrite } from './task-state.js';
import { finishAbandonment } from './agent-execution.js';
import { describeError } from './log-redact.js';

// A handoff that keeps failing is terminated once BOTH bounds are reached:
// tick spacing varies (poll interval, wakeups, backoff), so a count alone is not
// a time bound, and a time bound alone could fail a task that was retried zero
// times because the daemon was down. Persisted in the preparation entry.
export const HANDOFF_FAILURE_MIN_ATTEMPTS = 3;
export const HANDOFF_FAILURE_MIN_MS = 10 * 60_000;

function coded(message, code) { return Object.assign(new Error(message), { code }); }

// Multica refused the claim (4xx) or answered /start for a different claim. A
// 5xx, network error or timeout may clear up, and 408/429 ask for a retry, so
// those keep retrying; the WARN is already limited to stage/code changes.
export function isExplicitRejection(error) {
  if (error?.code === 'START_NOT_CONFIRMED') return true;
  const status = error?.status;
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function createTaskDispatcher(config, {
  state, snapshot, render, deliver, root,
  redeliveryMs = 60_000, now = Date.now, log = () => {}, taskSecret = () => undefined,
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
  function secretsFor(taskId, extra = []) {
    let claim;
    try { claim = taskSecret(taskId); } catch { claim = undefined; }
    return [config.pat, claim, ...extra];
  }
  async function step(entry, signal, progress) {
    if (entry.handoff_failure?.terminal) return; // Stopped locally; see the ERROR logged when it stopped.
    progress.stage = 'state_read';
    let record = state.get(entry.task.id);
    if (!record || record.generation !== entry.generation) throw coded('stale dispatch preparation', 'STALE_PREPARATION');
    // Prior versions persisted this terminal decision before lifecycle failure.
    // Preserve that crash window; nonterminal old Git retry counters are inert.
    if (!record.preparation_failure && entry.preparationRetry?.terminal) {
      progress.stage = 'abandon';
      await finishAbandonment(state, record.task_id, record.generation,
        entry.preparationRetry.error, { config });
      return;
    }
    if (record.preparation_failure) {
      progress.stage = 'abandon';
      await finishAbandonment(state, record.task_id, record.generation, record.preparation_failure.reason, { config });
      return;
    }
    if (record.report) {
      progress.stage = 'reconcile';
      record = await state.reconcile(record.task_id, { generation: record.generation, replay: true });
      return;
    }
    const decided = entry.handoff_failure?.fail_reason;
    if (decided && record.execution.quiesced && !record.execution.accepted && record.start_confirmed) {
      // The bound already decided to fail this task and stopped admission, but
      // the fail report did not get through; finish it.
      progress.stage = 'report';
      const result = await state.report(record.task_id, record.generation, 'fail', { error: decided, failure_reason: 'environment_prepare_failed' });
      const failure = entry.handoff_failure;
      log('ERROR', 'task handoff failed permanently', { task_id: record.task_id, stage: failure.stage, code: failure.code, attempts: failure.attempts, outcome: reportOutcome(result) });
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
      progress.stage = 'render';
      const content = await render({ ...entry, endpoint: record.delivery?.endpoint ?? buildTaskEndpoint(entry.task, entry.generation) });
      progress.stage = 'state_write';
      await state.setAgentDelivery(record.task_id, entry.generation, { content, endpoint: record.delivery?.endpoint ?? buildTaskEndpoint(entry.task, entry.generation), ...(entry.dueAt ? { dueAt: entry.dueAt } : {}) });
    }
    signal.throwIfAborted();
    progress.stage = 'start';
    await state.start(record.task_id, entry.generation);
    record = state.get(record.task_id);
    if (record.execution.accepted) return;
    progress.stage = 'deliver';
    if (!await deliver(record.delivery, entry.task)) throw coded('C4 delivery unconfirmed', 'C4_DELIVERY_UNCONFIRMED');
    progress.stage = 'mark_delivered';
    await state.markDelivered(record.task_id, entry.generation);
  }
  // A pending report keeps reconciling on later ticks through the report path.
  const reportOutcome = result => result?.report?.state === 'confirmed' ? 'reported_fail' : 'fail_report_pending';
  // Without a confirmed start Multica accepts no terminal write for this claim,
  // so the only end is a local stop, and only once Multica has refused it.
  async function stopIfRejected(record, error) {
    if (!isExplicitRejection(error)) return 'retrying';
    if (!await state.quiesceUnaccepted(record.task_id, record.generation)) return 'left_to_agent';
    return 'stopped_locally';
  }
  // Ends a handoff that exhausted its retry bound through the existing
  // lifecycle primitives. Returns the outcome label for the single ERROR line,
  // or 'retrying' while the failure may still be transient.
  async function terminate(entry, failure, error) {
    const record = state.get(entry.task.id);
    if (!record || record.generation !== entry.generation) return 'stopped_locally';
    if (record.execution.accepted) return 'left_to_agent'; // Admitted work is never failed by the dispatcher.
    // Report reconciliation owns the outcome and has its own attempt and backoff
    // limits; a local error there (disk, history read) is retried, never a stop.
    if (record.report) return 'retrying';
    const reason = `task handoff failed at ${failure.stage}: ${failure.code} (${failure.attempts} attempts)`;
    // A frozen prestart termination is what step() already retries every tick
    // (its fail report needs a confirmed start); the frozen reason is kept.
    if (record.preparation_failure) return stopIfRejected(record, error);
    if (!record.delivery && !record.start_confirmed && !record.start_unknown) {
      // No frozen card, nothing delivered: the #42 prestart termination path.
      return reportOutcome(await finishAbandonment(state, record.task_id, record.generation, reason, { config }));
    }
    if (record.start_confirmed) {
      // The card may have reached the session; stop admission first, then fail
      // with the same primitives as failScheduled. The decision is persisted
      // with the failure so step() can finish the report if it fails here.
      failure.fail_reason ??= reason;
      if (!await state.quiesceUnaccepted(record.task_id, record.generation)) return 'left_to_agent';
      await state.markQuiesced(record.task_id, record.generation);
      return reportOutcome(await state.report(record.task_id, record.generation, 'fail', { error: failure.fail_reason, failure_reason: 'environment_prepare_failed' }));
    }
    // The original claim was never confirmed running. Once Multica refuses it,
    // stop local retries; the platform's own timeout owns the task from there.
    return stopIfRejected(record, error);
  }
  async function recordFailure(entry, stage, error) {
    const id = entry.task.id;
    const detail = describeError(error, secretsFor(id));
    const stored = read(id) ?? { scope, task: { id }, generation: entry.generation };
    if (stored.generation !== entry.generation || stored.handoff_failure?.terminal) return;
    const previous = stored.handoff_failure;
    const failure = { first_at: previous?.first_at ?? now(), attempts: (previous?.attempts ?? 0) + 1, last_at: now(), stage, code: detail.code,
      ...(previous?.fail_reason ? { fail_reason: previous.fail_reason } : {}) };
    stored.handoff_failure = failure;
    const deferred = () => {
      save(stored);
      // First failure and every stage/code change only.
      if (!previous || previous.stage !== stage || previous.code !== detail.code) {
        log('WARN', 'task handoff deferred', { task_id: id, stage, ...detail, attempts: failure.attempts });
      }
    };
    const exhausted = failure.attempts >= HANDOFF_FAILURE_MIN_ATTEMPTS && now() - failure.first_at >= HANDOFF_FAILURE_MIN_MS;
    if (!exhausted) return deferred();
    let outcome;
    let terminalError;
    try { outcome = await terminate(stored, failure, error); }
    catch (caught) { terminalError = caught; outcome = isExplicitRejection(caught) ? 'stopped_locally' : 'retrying'; }
    if (outcome === 'retrying') return deferred();
    if (outcome === 'stopped_locally') {
      failure.terminal = true;
      // A quiesce keeps begin() fenced; best effort when the terminal path itself failed.
      if (terminalError) await state.quiesceUnaccepted(id, entry.generation).catch(() => {});
    }
    save(stored);
    log('ERROR', 'task handoff failed permanently', {
      task_id: id, stage, ...detail, attempts: failure.attempts, outcome,
      ...(terminalError ? { terminal_error: describeError(terminalError, secretsFor(id)) } : {}),
    });
  }
  function clearFailure(entry) {
    const stored = read(entry.task.id);
    if (!stored?.handoff_failure || stored.handoff_failure.terminal || stored.generation !== entry.generation) return;
    delete stored.handoff_failure;
    save(stored);
  }
  function schedule(entry) {
    if (stopped || jobs.has(entry.task.id)) return;
    const controller = new AbortController();
    const progress = { stage: 'state_read' };
    const promise = step(entry, controller.signal, progress)
      .then(() => clearFailure(entry), error => {
        if (controller.signal.aborted) return; // Shutdown/config reload is not a handoff failure.
        return recordFailure(entry, progress.stage, error);
      })
      .catch(error => log('ERROR', 'task handoff failure bookkeeping failed', { task_id: entry.task.id, ...describeError(error, secretsFor(entry.task.id)) }))
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
        catch (error) {
          // Context is required for safe execution. Do not persist the raw claim
          // (it contains credentials), nor retry an incomplete snapshot forever.
          log('WARN', 'task context snapshot failed; abandoning preparation', {
            task_id: task.id, ...describeError(error, secretsFor(task.id, [task.auth_token])),
          });
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
