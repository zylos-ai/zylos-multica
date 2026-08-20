import assert from 'node:assert/strict';
import test from 'node:test';

import { isLoopbackHostname, normalizeConfig, validateBaseUrl } from '../src/lib/config.js';
import { UPSTREAM_VERSION } from '../src/lib/upstream-version.js';

const base = {
  base_url: 'https://multica.example',
  pat: 'secret',
  workspace_id: 'workspace-1',
  daemon_id: 'daemon-1',
  runtime: { name: 'Agent (zylos)', type: 'attacker-controlled' },
};

test('normalization clamps provider type and protocol version', () => {
  const config = normalizeConfig(base);
  assert.equal(config.runtime.type, 'zylos');
  assert.equal(config.runtime.version, UPSTREAM_VERSION);
  assert.equal(config.poll_interval_s, 15);
});

test('normalization rejects URLs with embedded credentials', () => {
  assert.throws(
    () => normalizeConfig({ ...base, base_url: 'https://user:password@multica.example' }),
    /embedded credentials/,
  );
});

test('workspace_slug is required, validated, and supersedes a stored workspace_id', () => {
  const slugged = normalizeConfig({ ...base, workspace_slug: 'zylos-lab' });
  assert.equal(slugged.workspace_slug, 'zylos-lab');
  assert.equal(slugged.workspace_id, undefined, 'stored UUID is stale once a slug is set');

  assert.throws(
    () => normalizeConfig({ ...base, workspace_slug: 'Not-A-Slug' }),
    /workspace_slug must match/,
  );

  const { workspace_id, ...withoutWorkspace } = base;
  assert.throws(
    () => normalizeConfig(withoutWorkspace),
    /Missing required config field: workspace_slug/,
  );
});

test('a legacy workspace_id config still normalizes for in-place migration', () => {
  const legacy = normalizeConfig(base);
  assert.equal(legacy.workspace_id, 'workspace-1');
  assert.equal(legacy.workspace_slug, undefined);
});

test('base_url must be https off loopback and origin-only (production premise unchanged)', () => {
  // Compatibility premise for the live deployments: origin-only https passes.
  const prodLike = normalizeConfig({ ...base, base_url: 'https://multica.luna.jinglever.com' });
  assert.equal(prodLike.base_url, 'https://multica.luna.jinglever.com');
  assert.equal(normalizeConfig({ ...base, base_url: 'https://multica.example/' }).base_url, 'https://multica.example');

  // Cleartext http is a loopback-only development affordance.
  validateBaseUrl('http://127.0.0.1:3000');
  validateBaseUrl('http://localhost:8080');
  validateBaseUrl('http://[::1]:8080');
  assert.throws(
    () => normalizeConfig({ ...base, base_url: 'http://multica.example' }),
    /https for non-loopback/,
  );
  // Lookalike hosts must not pass the loopback gate.
  assert.throws(() => validateBaseUrl('http://localhost.evil.example'), /https for non-loopback/);
  assert.throws(() => validateBaseUrl('http://127.0.0.1.evil.example'), /https for non-loopback/);
  assert.equal(isLoopbackHostname('localhost.evil.example'), false);

  // Credential-bearing callers resolve root-relative /api paths, so any base
  // path would be silently discarded: the supported contract is origin-only.
  assert.throws(
    () => normalizeConfig({ ...base, base_url: 'https://shared.example/multica' }),
    /origin-only/,
  );
  assert.throws(() => validateBaseUrl('https://multica.example/?tenant=1'), /origin-only/);
  assert.throws(() => validateBaseUrl('https://multica.example/#fragment'), /origin-only/);
});
