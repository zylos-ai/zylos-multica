#!/usr/bin/env node
/** Multica daemon-protocol bridge for Zylos. */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { buildChatCard, buildTaskCard, futureDueDate } from './lib/cards.js';
import { createIssue } from './lib/business-cli.js';
import { getConfig, persistWorkspaceSlugMigration, stopWatching, watchConfig } from './lib/config.js';
import { multicaRequest } from './lib/multica-api.js';
import { ensureWorkspaceResolved } from './lib/workspace.js';
import { storeTaskToken } from './lib/task-tokens.js';
import { UPSTREAM_VERSION } from './lib/upstream-version.js';
import { createWakeupChannel } from './lib/wakeup.js';

const C4_RECEIVE = path.join(os.homedir(), 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');
const SCHEDULER_CLI = path.join(os.homedir(), 'zylos/.claude/skills/scheduler/scripts/cli.js');
const BACKOFF_STEPS_S = [15, 60, 300];
const RECONCILABLE_TASK_STATUSES = new Set(['running', 'dispatched', 'waiting_local_directory']);
const REQUIRED_SCHEDULER_FIELDS = [
  'id', 'type', 'status', 'last_error', 'reply_channel', 'reply_endpoint', 'next_run_at',
];

const log = (level, message, extra) => {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  console.log(`${new Date().toISOString()} ${level} [multica] ${message}${suffix}`);
};

function runNodeScript(script, args, timeout = 20_000) {
  return new Promise((resolve) => {
    const child = execFile('node', [script, ...args], { timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), error });
    });
    child.on('error', (error) => resolve({ ok: false, stdout: '', stderr: '', error }));
  });
}

// Row-level contract check. Rows are validated and quarantined independently:
// one malformed record (from any channel) must never suppress reconciliation
// of the valid rows around it, so this returns a verdict instead of throwing.
function schedulerRowProblem(row) {
  if (!row || typeof row !== 'object') return 'not an object';
  if (REQUIRED_SCHEDULER_FIELDS.some((field) => !Object.hasOwn(row, field))) {
    return `missing one of: ${REQUIRED_SCHEDULER_FIELDS.join(', ')}`;
  }
  const nullableStringFieldsValid = ['last_error', 'reply_channel', 'reply_endpoint']
    .every((field) => row[field] === null || typeof row[field] === 'string');
  if (typeof row.id !== 'string' || typeof row.type !== 'string'
    || typeof row.status !== 'string' || !nullableStringFieldsValid
    || !Number.isFinite(row.next_run_at)) {
    return 'invalid task row field types';
  }
  if (row.type === 'one-time' && row.reply_channel === 'multica'
    && (typeof row.reply_endpoint !== 'string' || row.reply_endpoint.length === 0)) {
    return 'Multica row has no reply_endpoint';
  }
  return null;
}

export function selectLatestMulticaSchedulerRows(rows, onInvalidRow = () => {}) {
  if (!Array.isArray(rows)) {
    throw new Error('Scheduler list contract mismatch: expected a JSON array');
  }
  const latestByTask = new Map();
  for (const row of rows) {
    const problem = schedulerRowProblem(row);
    if (problem) {
      onInvalidRow(row, problem);
      continue;
    }
    if (row.type !== 'one-time' || row.reply_channel !== 'multica') continue;
    const current = latestByTask.get(row.reply_endpoint);
    const isNewer = !current || row.next_run_at > current.next_run_at;
    const saferTie = current && row.next_run_at === current.next_run_at
      && current.status === 'failed' && row.status !== 'failed';
    if (isNewer || saferTie) latestByTask.set(row.reply_endpoint, row);
  }
  return [...latestByTask.values()];
}

export function validateRegisterContract(response, provider = 'zylos') {
  const valid = response && typeof response === 'object'
    && Array.isArray(response.runtimes);
  if (!valid) {
    throw new Error(
      "Multica register contract mismatch: expected 'runtimes'. "
      + 'Verify that this deployment supports the Multica 0.4.26 daemon protocol.',
    );
  }
  const runtime = response.runtimes.find((entry) => entry?.provider === provider || entry?.type === provider);
  if (!runtime?.id) {
    throw new Error(`Multica register response did not include the '${provider}' runtime`);
  }
  return runtime.id;
}

export function createBridge(initialConfig, dependencies = {}) {
  let config = initialConfig;
  let runtimeId;
  let backoffIndex = -1;
  let stopped = false;
  let wakeSleep;
  let pendingWakeup = false;
  let wakeupKey;
  const request = dependencies.request ?? multicaRequest;
  const resolveWorkspace = dependencies.ensureWorkspaceResolved ?? ensureWorkspaceResolved;
  const persistMigration = dependencies.persistWorkspaceSlugMigration ?? persistWorkspaceSlugMigration;
  const runScript = dependencies.runScript ?? runNodeScript;
  const now = dependencies.now ?? (() => Date.now());
  const persistTaskToken = dependencies.storeTaskToken ?? storeTaskToken;
  const wakeup = (dependencies.createWakeupChannel ?? createWakeupChannel)({
    log,
    onWakeup: () => {
      pendingWakeup = true;
      if (backoffIndex < 0) wakeSleep?.();
    },
  });

  async function register() {
    const response = await request(config, 'POST', '/api/daemon/register', {
      daemon_id: config.daemon_id,
      workspace_id: config.workspace_id,
      device_name: config.device_name || os.hostname(),
      cli_version: `zylos-multica/${UPSTREAM_VERSION}`,
      runtimes: [{
        type: 'zylos',
        name: config.runtime.name,
        version: UPSTREAM_VERSION,
        status: 'online',
      }],
    });
    runtimeId = validateRegisterContract(response, 'zylos');
    const serverVersion = response.server_version ?? response.settings?.server_version;
    log('INFO', 'registered', { runtime_id: runtimeId, ...(serverVersion ? { server_version: serverVersion } : {}) });
  }

  async function deliverToC4(content, endpoint) {
    const result = await runScript(C4_RECEIVE, [
      '--channel', 'multica', '--endpoint', String(endpoint), '--json', '--content', content,
    ]);
    if (!result.ok) {
      log('ERROR', 'c4 delivery failed', { endpoint: String(endpoint), error: result.stderr.slice(0, 200) });
    }
    return result.ok;
  }

  async function scheduleDelivery(content, task, dueAt) {
    const result = await runScript(SCHEDULER_CLI, [
      'add', content,
      '--at', dueAt.toISOString(),
      '--name', `multica-task-${String(task.id)}`,
      '--reply-channel', 'multica',
      '--reply-endpoint', String(task.id),
    ]);
    if (!result.ok) {
      log('ERROR', 'scheduler add failed; falling back to direct C4 delivery', {
        task_id: task.id,
        error: result.stderr.slice(0, 200),
      });
    }
    return result.ok;
  }

  async function listScheduledTasks() {
    const result = await runScript(SCHEDULER_CLI, [
      'list', '--json', '--reply-channel', 'multica',
    ]);
    if (!result.ok) {
      throw new Error(`Scheduler reconciliation list failed: ${result.stderr.slice(0, 200)}`);
    }
    let rows;
    try {
      rows = JSON.parse(result.stdout);
    } catch {
      throw new Error('Scheduler list contract mismatch: output was not valid JSON');
    }
    return selectLatestMulticaSchedulerRows(rows, (row, problem) => {
      log('WARN', 'scheduler row quarantined during reconciliation', {
        problem,
        scheduler_task_id: typeof row?.id === 'string' ? row.id.slice(0, 100) : undefined,
      });
    });
  }

  async function reconcileScheduledTasks() {
    let rows;
    try {
      rows = await listScheduledTasks();
    } catch (error) {
      log('WARN', 'scheduler reconciliation list failed; continuing to claim', {
        error: String(error?.message || error).slice(0, 200),
      });
      return;
    }
    for (const row of rows) {
      if (row.status !== 'failed') continue;
      const taskId = row.reply_endpoint;
      try {
        const taskStatus = await request(
          config,
          'GET',
          `/api/daemon/tasks/${encodeURIComponent(taskId)}/status`,
        );
        if (!taskStatus || typeof taskStatus.status !== 'string') {
          throw new Error(`Multica task status contract mismatch for ${taskId}`);
        }
        if (!RECONCILABLE_TASK_STATUSES.has(taskStatus.status)) continue;
        const detail = String(row.last_error || 'unknown scheduler failure').slice(0, 300);
        await request(config, 'POST', `/api/daemon/tasks/${encodeURIComponent(taskId)}/fail`, {
          error: `scheduler handoff failed: ${detail}`,
          failure_reason: 'runtime_offline',
        });
        log('WARN', 'failed scheduler handoff reconciled to Multica', {
          scheduler_task_id: row.id,
          task_id: taskId,
        });
      } catch (error) {
        log('WARN', 'scheduler handoff reconciliation failed; continuing', {
          scheduler_task_id: row.id,
          task_id: taskId,
          error: String(error?.message || error).slice(0, 200),
        });
      }
    }
  }

  async function fetchIssue(issueId) {
    try {
      return await request(config, 'GET', `/api/issues/${encodeURIComponent(issueId)}`, undefined, {
        workspaceHeader: true,
      });
    } catch (error) {
      log('WARN', 'issue fetch failed; using task thread name only', { issue_id: issueId, error: error.message });
      return null;
    }
  }

  async function startTask(task) {
    await request(config, 'POST', `/api/daemon/tasks/${encodeURIComponent(task.id)}/start`, {});
  }

  async function reportTerminal(task, action, body) {
    const endpoint = `/api/daemon/tasks/${encodeURIComponent(task.id)}/${action}`;
    try {
      return await request(config, 'POST', endpoint, body);
    } catch (firstError) {
      log('WARN', `${action} callback failed; retrying callback only`, {
        task_id: task.id,
        error: String(firstError?.message || firstError).slice(0, 200),
      });
      return request(config, 'POST', endpoint, body);
    }
  }

  function quickCreateBody(task) {
    if (typeof task.id !== 'string' || task.id.trim() === '') {
      throw new Error('task id must be a non-empty string');
    }
    if (typeof task.quick_create_prompt !== 'string' || task.quick_create_prompt.trim() === '') {
      throw new Error('quick_create_prompt must be a non-empty string');
    }
    const attachmentIds = task.quick_create_attachment_ids;
    if (attachmentIds !== undefined && (!Array.isArray(attachmentIds)
      || attachmentIds.some((id) => typeof id !== 'string' || id.trim() === ''))) {
      throw new Error('quick_create_attachment_ids must be an array of non-empty strings');
    }
    const firstLine = task.quick_create_prompt.split(/\r\n|\n|\r/u).find((line) => line.trim() !== '').trim();
    const titleCodePoints = Array.from(firstLine);
    const body = {
      title: titleCodePoints.length > 200 ? `${titleCodePoints.slice(0, 199).join('')}…` : firstLine,
      description: task.quick_create_prompt,
      origin_type: 'quick_create',
      origin_id: String(task.id),
    };
    if (attachmentIds?.length) body.attachment_ids = attachmentIds.map((id) => id.trim());
    return body;
  }

  async function handleQuickCreate(task) {
    let body;
    try {
      body = quickCreateBody(task);
    } catch (error) {
      await reportTerminal(task, 'fail', { error: `invalid quick-create task: ${error.message}` });
      log('WARN', 'invalid quick-create task failed before issue creation', { task_id: task.id });
      return true;
    }

    await startTask(task);
    let issue;
    try {
      issue = await createIssue(config, body, request);
    } catch (error) {
      await reportTerminal(task, 'fail', { error: `quick-create issue creation failed: ${error.message}` });
      log('WARN', 'quick-create issue creation failed without replay', { task_id: task.id });
      return true;
    }
    const issueRef = issue?.identifier || issue?.id || 'created issue';
    await reportTerminal(task, 'complete', { output: `Created ${issueRef}` });
    log('INFO', 'quick-create task completed', { task_id: task.id, issue_id: issue?.id });
    return true;
  }

  async function handleTask(task) {
    if (task.kind === 'quick_create') return handleQuickCreate(task);

    if (task.chat_session_id) {
      try {
        persistTaskToken(task.id, task.auth_token);
      } catch (error) {
        log('ERROR', 'chat task token could not be persisted; leaving task dispatched', {
          task_id: task.id,
          error: String(error?.message || error).slice(0, 200),
        });
        return false;
      }
      if (!await deliverToC4(buildChatCard(task), task.id)) {
        log('WARN', 'chat delivery failed; leaving task dispatched', { task_id: task.id });
        return false;
      }
      await startTask(task);
      log('INFO', 'chat task delivered and started', { task_id: task.id, chat_session_id: task.chat_session_id });
      return true;
    }

    if (!task.issue_id) {
      await request(config, 'POST', `/api/daemon/tasks/${encodeURIComponent(task.id)}/fail`, {
        error: `The zylos runtime cannot route task kind ${String(task.kind || 'unknown')} without an issue_id.`,
      });
      log('INFO', 'unsupported task without issue_id rejected', { task_id: task.id, kind: task.kind });
      return true;
    }

    const issue = await fetchIssue(task.issue_id);
    const card = buildTaskCard(task, issue);
    const dueAt = futureDueDate(issue, now());
    let delivered;
    if (dueAt) {
      const scheduled = await scheduleDelivery(card, task, dueAt);
      if (scheduled) {
        delivered = true;
        log('INFO', 'task scheduled', { task_id: task.id, due_at: dueAt.toISOString() });
      } else {
        delivered = await deliverToC4(card, task.id);
      }
    } else {
      delivered = await deliverToC4(card, task.id);
    }
    if (!delivered) {
      log('WARN', 'delivery failed; leaving task dispatched for server-side redispatch', { task_id: task.id });
      return false;
    }
    await startTask(task);
    log('INFO', 'task delivered and started', { task_id: task.id });
    return true;
  }

  async function ensureWorkspace() {
    if (config.workspace_slug && config.workspace_id) return;
    const migrating = !config.workspace_slug && Boolean(config.workspace_id);
    await resolveWorkspace(config, {
      request,
      onMigrated: (workspace) => {
        persistMigration(workspace.slug);
        log('INFO', 'workspace_id config migrated to workspace_slug', { workspace_slug: workspace.slug });
      },
    });
    if (!migrating) {
      log('INFO', 'workspace resolved', {
        workspace_slug: config.workspace_slug,
        workspace_id: config.workspace_id,
      });
    }
  }

  async function tick() {
    await ensureWorkspace();
    if (!runtimeId) await register();
    // (Re)attach the wakeup websocket whenever the registered identity it
    // serves has changed; a plain reconnect after a drop is the channel's
    // own job, not tick's.
    const nextWakeupKey = `${config.base_url}|${runtimeId}`;
    if (nextWakeupKey !== wakeupKey) {
      wakeupKey = nextWakeupKey;
      wakeup.start(config, runtimeId);
    }
    await request(config, 'POST', '/api/daemon/heartbeat', { runtime_id: runtimeId });
    await reconcileScheduledTasks();
    const response = await request(config, 'POST', '/api/daemon/tasks/claim', {
      daemon_id: config.daemon_id,
      runtime_ids: [runtimeId],
      max_tasks: 1,
    });
    for (const task of response?.tasks || []) {
      log('INFO', 'task claimed', { task_id: task.id, issue_id: task.issue_id });
      await handleTask(task);
    }
  }

  function updateConfig(nextConfig) {
    config = nextConfig;
    runtimeId = undefined;
    // The socket may authenticate against stale credentials; drop it now and
    // let the next successful register re-attach it under the new identity.
    wakeupKey = undefined;
    wakeup.stop();
  }

  function stop() {
    stopped = true;
    wakeup.stop();
    wakeSleep?.();
  }

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = undefined;
        resolve();
      }, milliseconds);
      wakeSleep = () => {
        clearTimeout(timer);
        wakeSleep = undefined;
        resolve();
      };
    });
  }

  async function run() {
    while (!stopped) {
      try {
        await tick();
        if (backoffIndex >= 0) log('INFO', 'recovered from backoff');
        backoffIndex = -1;
      } catch (error) {
        backoffIndex = Math.min(backoffIndex + 1, BACKOFF_STEPS_S.length - 1);
        const authFailure = error.status === 401;
        log(authFailure ? 'ERROR' : 'WARN', `tick failed; retrying in ${BACKOFF_STEPS_S[backoffIndex]}s${authFailure ? ' (PAT may be revoked)' : ''}`, {
          error: error.message,
        });
        runtimeId = undefined;
      }
      if (stopped) break;
      const seconds = backoffIndex >= 0 ? BACKOFF_STEPS_S[backoffIndex] : config.poll_interval_s;
      // A wakeup hint skips the idle wait but never shortens error backoff:
      // the hint only proves the websocket is alive, not that the failing
      // HTTP path has recovered.
      if (backoffIndex >= 0 || !pendingWakeup) await sleep(seconds * 1000);
      pendingWakeup = false;
    }
  }

  return {
    deliverToC4,
    handleTask,
    handleQuickCreate,
    listScheduledTasks,
    reconcileScheduledTasks,
    register,
    run,
    scheduleDelivery,
    stop,
    tick,
    updateConfig,
  };
}

export async function main() {
  const config = getConfig();
  if (!config.enabled) {
    log('INFO', 'component disabled; exiting');
    return;
  }
  const bridge = createBridge(config);
  const shutdown = () => {
    log('INFO', 'shutting down');
    bridge.stop();
    stopWatching();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  watchConfig((nextConfig) => {
    if (!nextConfig.enabled) shutdown();
    else {
      bridge.updateConfig(nextConfig);
      log('INFO', 'config reloaded; runtime will re-register');
    }
  });
  log('INFO', 'bridge starting', { base_url: config.base_url, daemon_id: config.daemon_id });
  await bridge.run();
}
