#!/usr/bin/env node
/** Standard C4 outbound interface; endpoint carries the original generation. */
import { getConfig } from '../src/lib/config.js';
import { reportFromCLI } from '../src/lib/task-report.js';

const [endpoint, ...parts] = process.argv.slice(2);
const message = parts.join(' ');
if (!endpoint || !message.trim()) {
  console.error('Usage: send.js <task_id@generation> <message>');
  process.exit(2);
}
if (/^\[MEDIA:[^\]]+\]/i.test(message.trimStart())) {
  console.error('Multica accepts text replies only. Send a text conclusion instead of [MEDIA:...].');
  process.exit(2);
}
try {
  const result = await reportFromCLI(getConfig(), endpoint, 'complete', message);
  if (result !== null) console.log(`OK: task ${endpoint} completion confirmed`);
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
}
