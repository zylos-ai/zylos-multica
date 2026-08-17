#!/usr/bin/env node
/** Multica daemon-protocol bridge for Zylos. */

import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildChatCard, buildTaskCard, futureDueDate } from './lib/cards.js';
import { getConfig, stopWatching, watchConfig } from './lib/config.js';
import { multicaRequest } from './lib/multica-api.js';

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

function validateSchedulerRows(rows) {
  if (!Array.isArray(rows)) {
    throw new Error('Scheduler list contract mismatch: expected a JSON array');
  }
  for (const row of rows) {
    if (!row || typeof row !== 'object'
      || REQUIRED_SCHEDULER_FIELDS.some((field) => !Object.hasOwn(row, field))) {
      throw new Error(
        `Scheduler list contract mismatch: expected fields ${REQUIRED_SCHEDULER_FIELDS.join(', ')}`,
      );
    }
    const nullableStringFieldsValid = ['last_error', 'reply_channel', 'reply_endpoint']
      .every((field) => row[field] === null || typeof row[field] === 'string');
    if (typeof row.id !== 'string' || typeof row.type !== 'string'
      || typeof row.status !== 'string' || !nullableStringFieldsValid
      || !Number.isFinite(row.next_run_at)) {
      throw new Error('Scheduler list contract mismatch: invalid task row field types');
    }
  }
  return rows;
}

export function selectLatestMulticaSchedulerRows(rows) {
  const latestByTask = new Map();
  for (const row of validateSchedulerRows(rows)) {
    if (row.type !== 'one-time' || row.reply_channel !== 'multica') continue;
    if (typeof row.reply_endpoint !== 'string' || row.reply_endpoint.length === 0) {
      throw new Error('Scheduler list contract mismatch: Multica row has no reply_endpoint');
    }
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
  const request = dependencies.request ?? multicaRequest;
  const runScript = dependencies.runScript ?? runNodeScript;
  const now = dependencies.now ?? (() => Date.now());

  async function register() {
    const response = await request(config, 'POST', '/api/daemon/register', {
      daemon_id: config.daemon_id,
      workspace_id: config.workspace_id,
      device_name: config.device_name || os.hostname(),
      cli_version: 'zylos-multica/0.1.0',
      runtimes: [{
        type: 'zylos',
        name: config.runtime.name,
        version: '0.1.0',
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
    return selectLatestMulticaSchedulerRows(rows);
  }

  async function reconcileScheduledTasks() {
    const rows = await listScheduledTasks();
    for (const row of rows) {
      if (row.status !== 'failed') continue;
      const taskId = row.reply_endpoint;
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

  async function handleTask(task) {
    if (task.chat_session_id) {
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
        error: 'The zylos runtime does not handle quick-create meta-tasks. Create an issue and assign it to the Zylos agent instead.',
      });
      log('INFO', 'quick-create meta-task rejected with guidance', { task_id: task.id });
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

  async function tick() {
    if (!runtimeId) await register();
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
  }

  function stop() {
    stopped = true;
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
      await sleep(seconds * 1000);
    }
  }

  return {
    deliverToC4,
    handleTask,
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

async function main() {
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

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[multica] Fatal error: ${error.message}`);
    process.exit(1);
  });
}
