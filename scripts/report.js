#!/usr/bin/env node
/** Explicit progress/failure reporting and frozen terminal-result recovery. */
import { getConfig } from '../src/lib/config.js';
import { reportFromCLI } from '../src/lib/task-report.js';

const [action, endpoint, ...parts] = process.argv.slice(2);
const text = parts.join(' ');
if (!['progress', 'fail', 'reconcile', 'complete-posted'].includes(action) || !endpoint || (action !== 'reconcile' && !text.trim()) || (action === 'reconcile' && parts.length)) {
  console.error('Usage: report.js <progress|fail|complete-posted> <task_id@generation> <text> | report.js reconcile <task_id@generation>');
  process.exit(2);
}
try {
  await reportFromCLI(getConfig(), endpoint, action === 'complete-posted' ? 'complete' : action, text, { contentAlreadyPosted: action === 'complete-posted' });
  console.log(`OK: task ${endpoint} ${action} confirmed`);
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
