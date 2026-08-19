#!/usr/bin/env node
/** Idempotent Multica post-install setup. */

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = path.join(os.homedir(), 'zylos/components/multica');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

function atomicWrite(value) {
  const tempPath = `${CONFIG_PATH}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, CONFIG_PATH);
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

try {
  fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
  const existing = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  const config = { enabled: true, poll_interval_s: 15, ...existing };
  let changed = !fs.existsSync(CONFIG_PATH);
  if (!config.daemon_id) {
    config.daemon_id = crypto.randomUUID();
    changed = true;
  }
  if (!config.workspace_slug && config.workspace_id && config.base_url && config.pat) {
    // Best-effort legacy migration; the daemon self-heals on startup if this
    // machine cannot reach the server right now.
    try {
      const response = await fetch(new URL('/api/workspaces', config.base_url), {
        headers: { Authorization: `Bearer ${config.pat}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const workspaces = await response.json();
      const match = Array.isArray(workspaces)
        ? workspaces.find((workspace) => workspace && workspace.id === config.workspace_id)
        : undefined;
      if (match?.slug) {
        config.workspace_slug = match.slug;
        delete config.workspace_id;
        changed = true;
        console.log(`[multica] Migrated workspace_id config to workspace_slug "${match.slug}"`);
      } else {
        console.warn('[multica] workspace_slug migration skipped: stored workspace_id not found for this PAT');
      }
    } catch (error) {
      console.warn(`[multica] workspace_slug migration deferred (${error.message}); the daemon migrates on startup`);
    }
  }
  if (changed) atomicWrite(config);
  else fs.chmodSync(CONFIG_PATH, 0o600);
  console.log('[multica] Post-install setup complete');
} catch (error) {
  console.error(`[multica] Post-install failed: ${error.message}`);
  process.exit(1);
}

execFile('pm2', ['describe', 'zylos-multica-bridge'], { timeout: 5_000 }, (error) => {
  if (!error) {
    console.warn('[multica] Existing PM2 service zylos-multica-bridge detected. Stop it before starting this component to avoid duplicate claims.');
  }
});
