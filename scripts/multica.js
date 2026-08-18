#!/usr/bin/env node
/** Minimal Multica business CLI slice backed by the component's local config. */

import { getConfig } from '../src/lib/config.js';
import { runBusinessCLI } from '../src/lib/business-cli.js';

try {
  await runBusinessCLI(getConfig(), process.argv.slice(2));
} catch (error) {
  console.error(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
