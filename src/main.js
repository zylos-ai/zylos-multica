#!/usr/bin/env node
/** Process entry point for the Multica service. */

import { main } from './index.js';

main().catch((error) => {
  console.error(`[multica] Fatal error: ${error.message}`);
  process.exit(1);
});
