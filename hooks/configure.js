#!/usr/bin/env node
/** Non-interactive install configuration hook. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { validateBaseUrl } from '../src/lib/config.js';

const CONFIG_PATH = path.join(os.homedir(), 'zylos/components/multica/config.json');
const DEFAULTS = { enabled: true, poll_interval_s: 15 };

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

function atomicWrite(value) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
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
  const raw = (await readStdin()).trim();
  if (!raw) throw new Error('Expected a JSON object on stdin');
  const collected = JSON.parse(raw);
  if (!collected || Array.isArray(collected) || typeof collected !== 'object') {
    throw new Error('Configure input must be a JSON object');
  }
  const existing = fs.existsSync(CONFIG_PATH)
    ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    : {};
  const config = { ...DEFAULTS, ...existing };
  const mappings = {
    MULTICA_BASE_URL: 'base_url',
    MULTICA_PAT: 'pat',
    MULTICA_WORKSPACE_SLUG: 'workspace_slug',
    MULTICA_DAEMON_ID: 'daemon_id',
    MULTICA_POLL_INTERVAL_S: 'poll_interval_s',
  };
  for (const [source, target] of Object.entries(mappings)) {
    const value = collected[source];
    if (value !== undefined && value !== null && value !== '') config[target] = value;
  }
  if (collected.MULTICA_RUNTIME_NAME) {
    config.runtime = { ...(config.runtime || {}), name: collected.MULTICA_RUNTIME_NAME };
  }
  for (const [field, value] of [
    ['base_url', config.base_url],
    ['pat', config.pat],
    ['runtime.name', config.runtime?.name],
  ]) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(`Missing required configuration: ${field}`);
    }
  }
  const slug = typeof config.workspace_slug === 'string' ? config.workspace_slug.trim() : '';
  const legacyId = typeof config.workspace_id === 'string' ? config.workspace_id.trim() : '';
  if (slug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
      throw new Error('workspace_slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ (the slug shown in the workspace URL)');
    }
    config.workspace_slug = slug;
    delete config.workspace_id;
  } else if (!legacyId) {
    throw new Error('Missing required configuration: workspace_slug');
  }
  config.base_url = String(config.base_url).trim().replace(/\/+$/, '');
  validateBaseUrl(config.base_url);
  const pollInterval = Number(config.poll_interval_s);
  if (!Number.isFinite(pollInterval) || pollInterval < 1 || pollInterval > 300) {
    throw new Error('poll_interval_s must be between 1 and 300');
  }
  config.poll_interval_s = pollInterval;
  atomicWrite(config);
  console.log(`[multica] Configuration written to ${CONFIG_PATH}`);
} catch (error) {
  console.error(`[multica] Configure failed: ${error.message}`);
  process.exit(1);
}
