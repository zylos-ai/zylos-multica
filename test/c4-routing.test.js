import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildC4ReceiveArgs } from '../src/lib/c4.js';
import { createBridge, selectLatestMulticaSchedulerRows } from '../src/index.js';

const issue = '11111111-1111-4111-8111-111111111111';
const generation = '22222222-2222-4222-8222-222222222222';
const endpoint = `task-1@${generation}|issue:${issue}`;

test('C4 flag follows the installed receive manifest while preserving the full endpoint', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-options-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receive = path.join(root, 'c4-receive.js');
  const manifest = path.join(root, 'c4-receive-options.json');
  for (const value of [undefined, 'bad json', '{}', '{"options":[]}', '{"options":null}', '{"options":{"--session-group":{}}}']) {
    if (value !== undefined) fs.writeFileSync(manifest, value);
    const args = buildC4ReceiveArgs('content', endpoint, receive);
    assert.equal(args[args.indexOf('--endpoint') + 1], endpoint);
    assert.equal(args.includes('--session-group'), value?.includes('"--session-group"') ?? false);
    if (args.includes('--session-group')) assert.equal(args[args.indexOf('--session-group') + 1], `issue-${issue}`);
  }
  assert.equal(buildC4ReceiveArgs('content', `task-1@${generation}`, receive).includes('--session-group'), false);
  assert.throws(() => buildC4ReceiveArgs('content', 'task|bad', receive));
});

test('Core rejection keeps the scoped endpoint and never replays to the overall session', async () => {
  const calls = [];
  const bridge = createBridge({ pat: 'secret' }, {
    createWakeupChannel: () => ({ start() {}, stop() {} }),
    runScript: async (_script, args) => {
      calls.push(args);
      return { ok: false, stdout: JSON.stringify({ ok: false, error: { code: 'GROUP_REJECTED', message: 'rejected' } }), stderr: '' };
    },
  });
  try { assert.equal(await bridge.deliverToC4('content', endpoint), false); }
  finally { bridge.stop(); }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][calls[0].indexOf('--endpoint') + 1], endpoint);
});

test('scheduler reconciliation keys typed and old addresses by their parsed task identity', () => {
  const row = { type: 'one-time', reply_channel: 'multica', status: 'failed', last_error: 'missed', next_run_at: 10, id: 'old', reply_endpoint: 'task-1' };
  const invalid = [];
  const selected = selectLatestMulticaSchedulerRows([row, { ...row, id: 'new', next_run_at: 20, reply_endpoint: endpoint }, { ...row, reply_endpoint: 'task|invalid' }], (...args) => invalid.push(args));
  assert.equal(selected.length, 1);
  assert.equal(selected[0].id, 'new');
  assert.equal(invalid.length, 1);
});

test('failed scheduled typed legacy task reports using task id without its route suffix', async () => {
  const calls = [];
  const bridge = createBridge({ pat: 'fixture' }, {
    createWakeupChannel: () => ({ start() {}, stop() {} }),
    runScript: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([{ id: 'schedule', type: 'one-time', reply_channel: 'multica', status: 'failed', last_error: 'missed', next_run_at: 10, reply_endpoint: `task-1|issue:${issue}` }]) }),
    request: async (_cfg, method, route, body) => {
      calls.push({ method, route, body });
      return route.endsWith('/status') ? { status: 'running' } : {};
    },
  });
  try { await bridge.reconcileScheduledTasks(); } finally { bridge.stop(); }
  assert.equal(calls[0].route, '/api/daemon/tasks/task-1/status');
  assert.equal(calls[1].route, '/api/daemon/tasks/task-1/fail');
});
