/** Read platform cancellation signals; notification never stops local execution. */
import { issueAssignment, taskNeedsCancellationCheck } from './task-state.js';
import { sanitizeExternalText } from './cards.js';

export const CANCELLATION_POLL_MS = 30_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['queued', 'dispatched', 'waiting_local_directory', 'running']);
const REASONS = {
  task_cancelled: 'The platform cancelled this task.',
  issue_cancelled: 'The platform cancelled this issue.',
  issue_reassigned: 'The platform changed this issue’s assignment since this task was delivered.',
};

export function createTaskCancellationMonitor(config, {
  state, request, deliver, log = () => {}, now = () => performance.now(), wallNow = Date.now,
}) {
  let nextPoll = -Infinity;
  let stopped = false;
  let polling;
  async function sweep() {
    if (stopped) return;
    const time = now();
    if (time < nextPoll) return;
    nextPoll = time + CANCELLATION_POLL_MS;
    const issues = new Map();
    for (const record of state.list()) {
      if (stopped) return;
      if (!taskNeedsCancellationCheck(record, config.daemon_id)) continue;
      if (!record.execution.accepted && record.delivery.scheduled !== false
        && record.delivery.dueAt && Date.parse(record.delivery.dueAt) > wallNow()) continue;
      try {
        let remote;
        let taskMissing = false;
        try {
          remote = await request(config, 'GET', `/api/daemon/tasks/${encodeURIComponent(record.task_id)}/status`, undefined, { timeoutMs: 5000 });
        } catch (error) {
          // Deleting an issue also deletes its task rows. Only this status
          // endpoint's 404 is an authoritative stop signal.
          if (error.status !== 404) throw error;
          taskMissing = true;
          remote = { status: 'cancelled' };
        }
        if (stopped) return;
        if (!remote || typeof remote.status !== 'string') throw new Error('invalid task status');
        if (!TERMINAL.has(remote.status) && !ACTIVE.has(remote.status)) throw new Error('invalid task status');
        let reason = remote.status === 'cancelled' ? 'task_cancelled' : undefined;
        if (!reason && TERMINAL.has(remote.status)) continue;
        if (!reason && record.issue_id) {
          // Cache successes AND failures so each issue costs at most one GET
          // per sweep even when several active tasks refer to the same card.
          if (!issues.has(record.issue_id)) issues.set(record.issue_id,
            request(config, 'GET', `/api/issues/${encodeURIComponent(record.issue_id)}`, undefined, { workspaceHeader: true, timeoutMs: 5000 }));
          const issue = await issues.get(record.issue_id);
          if (stopped) return;
          if (!issue || issue.id !== record.issue_id || typeof issue.status !== 'string') throw new Error('invalid issue identity or status');
          if (issue.status === 'cancelled' || issue.status_category === 'cancelled') reason = 'issue_cancelled';
          else {
            const assignment = issueAssignment(issue);
            if (!assignment) throw new Error('invalid issue assignment');
            if (!record.issue_assignment) await state.captureIssueAssignment(record.task_id, record.generation, issue);
            else {
              const original = issueAssignment({ assignee_type: record.issue_assignment.type, assignee_id: record.issue_assignment.id });
              if (!original) throw new Error('invalid original issue assignment');
              const ownsAssignment = original.type === 'agent' && original.id === record.agent_id
                || original.type === 'squad' && record.is_leader_task === true && record.issue_assignment.leader_id === record.agent_id;
              if (ownsAssignment && (assignment.type !== original.type || assignment.id !== original.id)) reason = 'issue_reassigned';
            }
          }
        }
        if (!reason) continue;
        if (stopped) return;
        const identity = sanitizeExternalText(`Task ID: ${record.task_id}${record.issue_id ? ` · Issue ID: ${record.issue_id}` : record.chat_session_id ? ` · Chat ID: ${record.chat_session_id}` : ''}`);
        const action = reason === 'issue_reassigned'
          ? 'If you reassigned this issue yourself during this task, you may ignore this notice and continue following the issue instructions. Otherwise, stop work for this task and stop its task processes.'
          : 'Stop work for this task and stop its task processes.';
        const missing = taskMissing ? ' This task no longer exists. If report.js fail remains pending_unknown because the task is missing, that is the final local state; no manual intervention or retry is needed.' : '';
        const notice = await state.notifyCancellation(record.task_id, record.generation, reason, endpoint => deliver(
            `[Multica task notice] ${identity}\n${REASONS[reason]} ${action} Acknowledge stopped work with task.js quiesce using this task’s original address and --stopped. Then use report.js fail with the same address and a stopped-work explanation to close this run. An already cancelled platform task may reconcile as superseded; do not retry it or report success.${missing} This notice does not authorize changing the issue, posting a business result, or taking over another assignment.`, endpoint), () => !stopped);
        if (notice) log(notice.outcome === 'accepted' ? 'INFO' : 'WARN', 'task cancellation notification attempted', {
          task_id: record.task_id, reason, outcome: notice.outcome,
        });
      } catch (error) {
        log('WARN', 'task cancellation check failed; continuing', {
          task_id: record.task_id,
          error_type: Number.isInteger(error.status) ? 'http'
            : ['TimeoutError', 'AbortError'].includes(error.name) || error.code === 'ETIMEDOUT' ? 'timeout' : 'request_or_response',
          ...(Number.isInteger(error.status) ? { http_status: error.status } : {}),
        });
      }
    }
  }
  return {
    stop() { stopped = true; },
    poll() {
      if (polling) return polling;
      polling = sweep().finally(() => { polling = undefined; });
      return polling;
    },
  };
}
