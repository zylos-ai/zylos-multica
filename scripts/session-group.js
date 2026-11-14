#!/usr/bin/env node
import { sessionGroupForEndpoint } from '../src/lib/session-group.js';
try {
  if (process.argv.length !== 3) throw new Error('Usage: session-group.js <endpoint>');
  process.stdout.write(sessionGroupForEndpoint(process.argv[2]));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
