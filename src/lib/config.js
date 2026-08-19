/** Configuration loader for zylos-multica. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { UPSTREAM_VERSION } from './upstream-version.js';
import { WORKSPACE_SLUG_PATTERN } from './workspace.js';

export const DATA_DIR = path.join(os.homedir(), 'zylos/components/multica');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  poll_interval_s: 15,
});

let currentConfig;
let configWatcher;
let reloadTimer;

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Missing required config field: ${field}`);
  }
  return value.trim();
}

export function normalizeConfig(input) {
  if (!input || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('Config must be a JSON object');
  }

  const config = { ...DEFAULT_CONFIG, ...input };
  config.base_url = requireString(config.base_url, 'base_url').replace(/\/+$/, '');
  config.pat = requireString(config.pat, 'pat');
  const slug = typeof config.workspace_slug === 'string' ? config.workspace_slug.trim() : '';
  const legacyId = typeof config.workspace_id === 'string' ? config.workspace_id.trim() : '';
  if (slug) {
    if (!WORKSPACE_SLUG_PATTERN.test(slug)) {
      throw new Error('workspace_slug must match ^[a-z0-9]+(-[a-z0-9]+)*$ (the slug shown in the workspace URL)');
    }
    config.workspace_slug = slug;
    // The UUID is resolved from the slug at runtime; any stored value is stale.
    delete config.workspace_id;
  } else if (legacyId) {
    // Pre-slug config: keep the UUID so the daemon can migrate it in place.
    config.workspace_id = legacyId;
    delete config.workspace_slug;
  } else {
    throw new Error('Missing required config field: workspace_slug');
  }
  config.daemon_id = requireString(config.daemon_id, 'daemon_id');

  let parsedUrl;
  try {
    parsedUrl = new URL(config.base_url);
  } catch {
    throw new Error('base_url must be a valid http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('base_url must use http or https');
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('base_url must not contain embedded credentials');
  }

  const pollInterval = Number(config.poll_interval_s);
  if (!Number.isFinite(pollInterval) || pollInterval < 1 || pollInterval > 300) {
    throw new Error('poll_interval_s must be between 1 and 300');
  }
  config.poll_interval_s = pollInterval;

  const runtime = config.runtime && typeof config.runtime === 'object' ? config.runtime : {};
  config.runtime = {
    ...runtime,
    type: 'zylos',
    name: requireString(runtime.name ?? config.runtime_name, 'runtime.name'),
    version: UPSTREAM_VERSION,
  };
  delete config.runtime_name;
  return config;
}

export function loadConfig(configPath = CONFIG_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to read config ${configPath}: ${error.message}`);
  }
  currentConfig = normalizeConfig(parsed);
  return currentConfig;
}

export function getConfig() {
  return currentConfig ?? loadConfig();
}

export function writeConfigAtomic(value, configPath = CONFIG_PATH) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
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

export function persistWorkspaceSlugMigration(slug, configPath = CONFIG_PATH) {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  raw.workspace_slug = slug;
  delete raw.workspace_id;
  writeConfigAtomic(raw, configPath);
}

export function watchConfig(onChange) {
  stopWatching();
  configWatcher = fs.watch(DATA_DIR, (eventType, filename) => {
    if (filename && String(filename) !== path.basename(CONFIG_PATH)) return;
    if (eventType !== 'change' && eventType !== 'rename') return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      if (!fs.existsSync(CONFIG_PATH)) return;
      try {
        onChange(loadConfig());
      } catch (error) {
        console.error(`[multica] Config reload rejected: ${error.message}`);
      }
    }, 100);
  });
  configWatcher.on('error', (error) => {
    console.error(`[multica] Config watcher failed: ${error.message}`);
  });
}

export function stopWatching() {
  clearTimeout(reloadTimer);
  reloadTimer = undefined;
  configWatcher?.close();
  configWatcher = undefined;
}
