#!/usr/bin/env node
/** Idempotent Multica config migrations. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { migrateWorkspaceSlug } from './lib/workspace-slug-migration.js';

const configPath = path.join(os.homedir(), 'zylos/components/multica/config.json');

function atomicWrite(value) {
  const tempPath = `${configPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, configPath);
    fs.chmodSync(configPath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw error;
  }
}

if (!fs.existsSync(configPath)) {
  console.log('[multica] No config found; nothing to migrate');
  process.exit(0);
}

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const migrations = [];
  if (config.enabled === undefined) {
    config.enabled = true;
    migrations.push('added enabled');
  }
  if (config.poll_interval_s === undefined) {
    config.poll_interval_s = 15;
    migrations.push('added poll_interval_s');
  }
  if (!config.daemon_id) {
    config.daemon_id = crypto.randomUUID();
    migrations.push('generated daemon_id');
  }
  if (config.runtime?.type !== undefined) {
    config._legacy_runtime_type ??= config.runtime.type;
    delete config.runtime.type;
    migrations.push('preserved runtime.type as _legacy_runtime_type; provider is fixed to zylos');
  }
  const slugMigration = await migrateWorkspaceSlug(config);
  if (slugMigration.changed) {
    migrations.push(slugMigration.note);
  } else if (slugMigration.warning) {
    console.warn(`[multica] ${slugMigration.warning}`);
  }
  if (migrations.length) {
    atomicWrite(config);
    console.log(`[multica] Applied migrations: ${migrations.join('; ')}`);
  } else {
    fs.chmodSync(configPath, 0o600);
    console.log('[multica] No migrations needed');
  }
} catch (error) {
  console.error(`[multica] Post-upgrade failed: ${error.message}`);
  process.exit(1);
}
