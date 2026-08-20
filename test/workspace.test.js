import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureWorkspaceResolved, WORKSPACE_SLUG_PATTERN } from '../src/lib/workspace.js';

const WORKSPACES = [
  { id: 'uuid-lab', slug: 'zylos-lab', name: 'Zylos Lab' },
  { id: 'uuid-ops', slug: 'zylos-ops', name: 'Zylos Ops' },
];

function harness(response = WORKSPACES) {
  const calls = [];
  const request = async (config, method, apiPath) => {
    calls.push({ method, apiPath });
    return response;
  };
  return { calls, request };
}

test('slug resolves to the workspace UUID and is cached on the config', async () => {
  const { calls, request } = harness();
  const config = { base_url: 'https://multica.example', pat: 'secret', workspace_slug: 'zylos-lab' };
  const id = await ensureWorkspaceResolved(config, { request });
  assert.equal(id, 'uuid-lab');
  assert.equal(config.workspace_id, 'uuid-lab');
  assert.deepEqual(calls, [{ method: 'GET', apiPath: '/api/workspaces' }]);

  await ensureWorkspaceResolved(config, { request });
  assert.equal(calls.length, 1, 'resolved config must not re-fetch');
});

test('unknown slug fails fast and lists the available slugs', async () => {
  const { request } = harness();
  const config = { workspace_slug: 'nope' };
  await assert.rejects(
    () => ensureWorkspaceResolved(config, { request }),
    /workspace slug "nope" not found.*available slugs: zylos-lab, zylos-ops/,
  );
  assert.equal(config.workspace_id, undefined);
});

test('an account with no workspaces is reported explicitly', async () => {
  const { request } = harness([]);
  await assert.rejects(
    () => ensureWorkspaceResolved({ workspace_slug: 'zylos-lab' }, { request }),
    /the account has no workspaces/,
  );
});

test('legacy workspace_id reverse-maps to its slug and reports the migration', async () => {
  const { request } = harness();
  const migrated = [];
  const config = { workspace_id: 'uuid-ops' };
  const id = await ensureWorkspaceResolved(config, { request, onMigrated: (w) => migrated.push(w) });
  assert.equal(id, 'uuid-ops');
  assert.equal(config.workspace_slug, 'zylos-ops');
  assert.deepEqual(migrated, [WORKSPACES[1]]);
});

test('legacy workspace_id outside the account fails with the slug listing', async () => {
  const { request } = harness();
  await assert.rejects(
    () => ensureWorkspaceResolved({ workspace_id: 'uuid-elsewhere' }, { request }),
    /legacy workspace_id uuid-elsewhere does not belong.*available slugs: zylos-lab, zylos-ops/,
  );
});

test('a non-array workspace listing is rejected as a contract break', async () => {
  const request = async () => ({ workspaces: WORKSPACES });
  await assert.rejects(
    () => ensureWorkspaceResolved({ workspace_slug: 'zylos-lab' }, { request }),
    /unexpected shape/,
  );
});

test('slug pattern matches the server contract', () => {
  for (const slug of ['zylos-lab', 'a', 'a1-b2-c3']) assert.ok(WORKSPACE_SLUG_PATTERN.test(slug));
  for (const slug of ['Zylos-Lab', '-lead', 'trail-', 'two--dashes', 'has space', 'sl/ug', '']) {
    assert.ok(!WORKSPACE_SLUG_PATTERN.test(slug), `should reject ${JSON.stringify(slug)}`);
  }
});

test('a failed migration persistence leaves the config unmigrated so it can retry', async () => {
  const { request } = harness();
  const config = { workspace_id: 'uuid-ops' };
  await assert.rejects(
    () => ensureWorkspaceResolved(config, {
      request,
      onMigrated: () => { throw new Error('disk full'); },
    }),
    /disk full/,
  );
  assert.equal(config.workspace_slug, undefined, 'slug must not commit before persistence succeeds');

  const migrated = [];
  const id = await ensureWorkspaceResolved(config, { request, onMigrated: (w) => migrated.push(w) });
  assert.equal(id, 'uuid-ops');
  assert.equal(config.workspace_slug, 'zylos-ops');
  assert.deepEqual(migrated, [WORKSPACES[1]], 'retry must re-attempt persistence');
});
