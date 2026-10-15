/** CLI boundary: generation belongs to the caller, never inferred from disk. */
import { createWorktreeManager } from './worktrees.js';
import { createTaskState } from './task-state.js';
import { ensureWorkspaceResolved } from './workspace.js';
import { removeTaskToken } from './task-tokens.js';
import { reportTask } from './multica-api.js';

export function parseTaskEndpoint(endpoint, { allowLegacy = false } = {}) {
  if (typeof endpoint !== 'string' || !endpoint || /[\s/\\\0]/.test(endpoint)) throw new Error('invalid task endpoint');
  const parts = endpoint.split('@');
  if (!/^[A-Za-z0-9_-]+$/.test(parts[0])) throw new Error('invalid task id');
  if (parts.length === 1 && allowLegacy) return { taskId: endpoint };
  if (parts.length !== 2 || !parts[0] || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parts[1])) {
    throw new Error('Terminal reporting requires task_id@generation from the current task card; legacy tasks need explicit recovery, not an inferred generation');
  }
  return { taskId: parts[0], generation: parts[1] };
}

export async function reportFromCLI(config, endpoint, action, text, options = {}) {
  const { taskId, generation } = parseTaskEndpoint(endpoint, { allowLegacy: action !== 'reconcile' });
  if (!config.workspace_id) await ensureWorkspaceResolved(config, options);
  const state = createTaskState(config, options);
  if (!generation) {
    if (state.get(taskId)) throw new Error('Bound task reporting requires task_id@generation');
    const result = await reportTask(config, action, taskId, text);
    if (action === 'complete' || action === 'fail') {
      try { (options.removeTaskToken ?? removeTaskToken)(taskId); }
      catch { console.error('WARNING: legacy task reported but token cleanup needs retry'); }
    }
    return result;
  }
  if (action === 'progress') {
    if (generation) state.assertCurrent({ taskId, generation, requireRunning: true });
    else if (state.get(taskId)) throw new Error('Bound task progress requires task_id@generation');
    return reportTask(config, action, taskId, text);
  }
  let metadata = {};
  if (action !== 'reconcile') {
    const execution = options.executionMetadata ? options.executionMetadata(taskId) : createWorktreeManager({ config, lifecycle: state }).inspect(taskId);
    if (execution?.generation && execution.generation !== generation) throw new Error('stale execution metadata');
    if (execution?.bindings?.length === 1) {
      const binding = execution.bindings[0];
      metadata = { work_dir: binding.cwd, ...(binding.branch ? { branch_name: binding.branch } : {}) };
    }
  }
  const record = action === 'reconcile'
    ? await state.reconcile(taskId, { generation, replay: true })
    : await state.report(taskId, generation, action, { ...metadata, [action === 'complete' ? 'output' : 'error']: text });
  if (record.report.state !== 'confirmed') {
    throw new Error(`task report ${record.report.state}; frozen report retained. Use report.js reconcile ${endpoint} for authority readback`);
  }
  return record;
}
