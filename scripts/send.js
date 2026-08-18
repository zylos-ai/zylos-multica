#!/usr/bin/env node
/** Standard C4 outbound interface. A text reply completes one Multica task. */

import { getConfig } from '../src/lib/config.js';
import { reportTask } from '../src/lib/multica-api.js';

const [taskId, ...parts] = process.argv.slice(2);
const message = parts.join(' ').trim();

if (!taskId || !message) {
  console.error('Usage: send.js <task_id> <message>');
  process.exit(2);
}
if (/^\[MEDIA:[^\]]+\]/i.test(message)) {
  console.error('Multica v0.2.21 accepts text replies only. Send a text conclusion instead of [MEDIA:...].');
  process.exit(2);
}

try {
  await reportTask(getConfig(), 'complete', taskId, message);
  console.log(`OK: task ${taskId} completed`);
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
