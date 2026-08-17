import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeConfig } from '../src/lib/config.js';

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
  assert.equal(config.runtime.version, '0.1.0');
  assert.equal(config.poll_interval_s, 15);
});

test('normalization rejects URLs with embedded credentials', () => {
  assert.throws(
    () => normalizeConfig({ ...base, base_url: 'https://user:password@multica.example' }),
    /embedded credentials/,
  );
});
