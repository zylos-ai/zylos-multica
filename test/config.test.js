import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../src/lib/config.js';
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
