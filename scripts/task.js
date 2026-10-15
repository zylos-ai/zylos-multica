#!/usr/bin/env node
/** Bound live-session execution helpers; never launches a new agent runtime. */
import { getConfig } from '../src/lib/config.js';
import { ensureWorkspaceResolved } from '../src/lib/workspace.js';
import { createTaskState } from '../src/lib/task-state.js';
import { parseTaskEndpoint } from '../src/lib/task-report.js';
import { createWorktreeManager } from '../src/lib/worktrees.js';

const [action, endpoint, resourceId, ...args] = process.argv.slice(2);
try {
  const { taskId, generation } = parseTaskEndpoint(endpoint);
  const config = getConfig();
  if (!config.workspace_id) await ensureWorkspaceResolved(config);
  const state = createTaskState(config);
  const manager = createWorktreeManager({ config, lifecycle: state });
  let result;
  if (action === 'begin' && !resourceId) {
    // Confirm the original exact claim again before accepting business work.
    await state.start(taskId, generation);
    result = { accepted: await state.markAccepted(taskId, generation), task_id: taskId, generation };
  } else if (action === 'locate' && resourceId && !args.length) {
    if (!state.get(taskId)?.execution.accepted) throw new Error('begin this task before using bound directories');
    result = await manager.locate(taskId, generation, resourceId);
  } else if (action === 'exec' && resourceId && args[0] === '--' && args.length > 1) {
    if (!state.get(taskId)?.execution.accepted) throw new Error('begin this task before executing commands');
    result = await manager.run(taskId, generation, resourceId, args.slice(1));
    process.exitCode = result.code ?? 1;
  } else if (action === 'quiesce' && resourceId === '--stopped' && !args.length) {
    result = await manager.quiesce(taskId, generation, { acknowledgedStopped: true });
    await state.markQuiesced(taskId, generation);
  } else throw new Error('Usage: task.js <begin|locate|exec|quiesce> <task@generation> [resource -- command args | --stopped]');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
