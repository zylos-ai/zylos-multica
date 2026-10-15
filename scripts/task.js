#!/usr/bin/env node
/** Live-session task admission and explicit Agent stop acknowledgement. */
import { getConfig } from '../src/lib/config.js';
import { ensureWorkspaceResolved } from '../src/lib/workspace.js';
import { createTaskState } from '../src/lib/task-state.js';
import { parseTaskEndpoint } from '../src/lib/task-report.js';
import { inspectLegacyExecution, finishAbandonment } from '../src/lib/agent-execution.js';

const [action, endpoint, ...args] = process.argv.slice(2);
try {
  const { taskId, generation } = action === 'inspect' && endpoint && !endpoint.includes('@')
    ? parseTaskEndpoint(endpoint, { allowLegacy: true }) : parseTaskEndpoint(endpoint);
  const config = getConfig();
  if (!config.workspace_id) await ensureWorkspaceResolved(config);
  const state = createTaskState(config);
  let result;
  if (['exec', 'locate', 'recover'].includes(action)) {
    throw new Error(`${action} is retired: Agent owns repository access, commands and continuation directories. Use inspect for historical paths; preserve old files and failed results. See docs/agent-owned-resources.md`);
  } else if (action === 'abandon' && args[0] === '--reason' && args.length === 3 && args[2] === '--stopped') {
    result = await finishAbandonment(state, taskId, generation, args[1], { config, acknowledgedStopped: true });
    if (result.report?.state !== 'confirmed') process.exitCode = 1;
  } else if (action === 'begin' && !args.length) {
    await state.start(taskId, generation);
    result = { accepted: await state.markAccepted(taskId, generation), task_id: taskId, generation };
  } else if (action === 'quiesce' && args[0] === '--stopped') {
    const metadata = {};
    for (let i = 1; i < args.length; i += 2) {
      const key = { '--work-dir': 'work_dir', '--branch': 'branch_name', '--pr-url': 'pr_url' }[args[i]];
      if (!key || !args[i + 1] || Object.hasOwn(metadata, key)) throw new Error('invalid or duplicate execution metadata');
      metadata[key] = args[i + 1];
    }
    result = await state.acknowledgeStopped(taskId, generation, metadata);
  } else if (action === 'inspect' && !args.length) {
    const record = state.get(taskId);
    if (!record || (generation && record.generation !== generation)) throw new Error('task generation mismatch');
    result = { task: record, legacy: inspectLegacyExecution(config, taskId) };
  } else throw new Error('Usage: task.js begin|inspect <task@generation> | quiesce <task@generation> --stopped [--work-dir path] [--branch name] [--pr-url url] | abandon <task@generation> --reason text --stopped');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
