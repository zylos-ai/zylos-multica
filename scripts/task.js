#!/usr/bin/env node
/** Bound live-session execution helpers; never launches a new agent runtime. */
import { getConfig } from '../src/lib/config.js';
import { ensureWorkspaceResolved } from '../src/lib/workspace.js';
import { createTaskState } from '../src/lib/task-state.js';
import { parseTaskEndpoint } from '../src/lib/task-report.js';
import { createWorktreeManager } from '../src/lib/worktrees.js';

const [action, endpoint, resourceId, ...args] = process.argv.slice(2);
try {
  const { taskId, generation } = action === 'inspect' && endpoint && !endpoint.includes('@')
    ? { taskId: endpoint } : parseTaskEndpoint(endpoint);
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
  } else if (action === 'recover' && resourceId === '--to') {
    const destination = parseTaskEndpoint(args[0]);
    const baselines = {};
    let stopped = false;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === '--stopped' && !stopped) { stopped = true; continue; }
      if (args[i] !== '--baseline' || !args[i + 1]) throw new Error('use --baseline resource=exact-commit and --stopped');
      const match = /^([^=]+)=([0-9a-f]{40})$/.exec(args[++i]);
      if (!match || Object.hasOwn(baselines, match[1])) throw new Error('invalid or duplicate baseline');
      Object.defineProperty(baselines, match[1], { value: match[2], enumerable: true });
    }
    result = await manager.recover(taskId, generation, destination.taskId, destination.generation, { acknowledgedStopped: stopped, baselines });
  } else if (action === 'inspect' && !resourceId) {
    result = manager.inspect(taskId);
    if (!result || (generation && result.generation !== generation)) throw new Error('worktree binding generation mismatch');
  } else throw new Error('Usage: task.js <begin|locate|exec|quiesce|inspect|recover> <task@generation> [resource -- command args | --stopped | --to task@generation --baseline resource=commit --stopped]');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
