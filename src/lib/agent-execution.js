/** Agent owns processes and repository access. Legacy Git records are read-only. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

export function inspectLegacyExecution(config, taskId, root = path.join(os.homedir(), 'zylos/components/multica/execution')) {
  const key = createHash('sha256').update(JSON.stringify([config.base_url, config.workspace_id, taskId])).digest('hex');
  const read = name => {
    try { return JSON.parse(fs.readFileSync(path.join(root, name, `${key}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  return { binding: read('bindings'), operation: read('operations'), historical_only: true };
}

export async function finishAbandonment(state, taskId, generation, reason, { config, acknowledgedStopped = false, legacyRoot } = {}) {
  if (config) {
    const legacy = inspectLegacyExecution(config, taskId, legacyRoot);
    const uncertain = legacy.operation || legacy.binding?.commands?.some(command => !['exited', 'stopped_confirmed'].includes(command.status));
    if (uncertain && !acknowledgedStopped && !state.get(taskId)?.execution.legacy_stopped_acknowledged) {
      throw new Error('legacy execution stop is unconfirmed; verify processes stopped, then abandon with --stopped');
    }
  }
  if (acknowledgedStopped) await state.acknowledgeLegacyStopped(taskId, generation);
  let record = await state.abandonPreparation(taskId, generation, reason);
  // No resource ownership is transferred or released. Historical records/files
  // are preserved; the operator is responsible for stopping any old processes.
  if (record.report) return state.reconcile(taskId, { generation, replay: true });
  record = await state.startAbandonedPreparation(taskId, generation);
  return state.report(taskId, generation, 'fail', {
    error: record.preparation_failure.reason, failure_reason: 'environment_prepare_failed',
  });
}
