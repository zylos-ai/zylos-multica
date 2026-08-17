#!/usr/bin/env node
/** Preserve the component-owned config before an upgrade. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const configPath = path.join(os.homedir(), 'zylos/components/multica/config.json');
try {
  if (fs.existsSync(configPath)) {
    const backupPath = `${configPath}.backup`;
    const tempPath = `${backupPath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tempPath, fs.readFileSync(configPath), { mode: 0o600 });
      fs.chmodSync(tempPath, 0o600);
      fs.renameSync(tempPath, backupPath);
      fs.chmodSync(backupPath, 0o600);
    } catch (error) {
      try { fs.unlinkSync(tempPath); } catch {}
      throw error;
    }
    console.log('[multica] Config backup refreshed');
  } else {
    console.log('[multica] No config found; nothing to back up');
  }
} catch (error) {
  console.error(`[multica] Pre-upgrade failed: ${error.message}`);
  process.exit(1);
}
