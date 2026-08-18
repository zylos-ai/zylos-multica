#!/usr/bin/env node
/** Supplemental Multica progress/failure reporting interface. */

import { getConfig } from '../src/lib/config.js';
import { reportTask } from '../src/lib/multica-api.js';
import { removeTaskToken } from '../src/lib/task-tokens.js';

const [action, taskId, ...parts] = process.argv.slice(2);
const text = parts.join(' ').trim();

if (!['progress', 'fail'].includes(action) || !taskId || !text) {
  console.error('Usage: report.js <progress|fail> <task_id> <text>');
  process.exit(2);
}

try {
  await reportTask(getConfig(), action, taskId, text);
  if (action === 'fail') {
    try {
      removeTaskToken(taskId);
    } catch (error) {
      console.error(`WARNING: task ${taskId} failed but its local chat token could not be removed: ${error.message}`);
    }
  }
  console.log(`OK: task ${taskId} ${action} reported`);
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
