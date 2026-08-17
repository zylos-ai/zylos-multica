#!/usr/bin/env node
/**
 * zylos-multica
 *
 * Multica task-platform channel: bridges a Multica deployment to the agent's live session via the daemon protocol
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';

// Initialize
console.log(`[multica] Starting...`);
console.log(`[multica] Data directory: ${DATA_DIR}`);

// Load configuration
let config = getConfig();
console.log(`[multica] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[multica] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[multica] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[multica] Component disabled, stopping...`);
    shutdown();
  }
});

// Main component logic
async function main() {
  // TODO: Implement your component logic here
  //
  // Communication components: set up platform SDK, listen for events, forward to C4
  // Capability components: start HTTP server or other service interface
  // Utility components: run task and exit (remove the keepalive below)

  console.log(`[multica] Running`);
}

// Graceful shutdown
function shutdown() {
  console.log(`[multica] Shutting down...`);
  // TODO: Close connections, stop listeners, cleanup
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[multica] Fatal error:`, err);
  process.exit(1);
});
