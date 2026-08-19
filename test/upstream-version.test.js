import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { UPSTREAM_VERSION } from '../src/lib/upstream-version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('registration is wired to the upstream capability track, not package metadata', () => {
  const indexSource = fs.readFileSync(path.join(root, 'src/index.js'), 'utf8');
  const configSource = fs.readFileSync(path.join(root, 'src/lib/config.js'), 'utf8');

  assert.equal(UPSTREAM_VERSION, '0.2.21');
  assert.match(indexSource, /cli_version: `zylos-multica\/\$\{UPSTREAM_VERSION\}`/);
  assert.match(indexSource, /version: UPSTREAM_VERSION/);
  assert.match(configSource, /version: UPSTREAM_VERSION/);
  assert.doesNotMatch(`${indexSource}\n${configSource}`, /package\.json/);
});
