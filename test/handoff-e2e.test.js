// zylos-multica #56 end to end: real createBridge, real dispatcher/task state,
// real runNodeScript -> child_process.execFile. Only the network (request) and
// the C4/scheduler scripts are stubs, written to a temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createBridge, runNodeScript } from '../src/index.js';
import { createTaskState } from '../src/lib/task-state.js';
import { CARD_BYTE_BUDGET } from '../src/lib/cards.js';

const PAT = 'mul_e2e_component_pat_SECRET';
const CLAIM = 'mat_e2e_claim_token_SECRET';
const config = { enabled: true, base_url: 'https://multica.invalid', pat: PAT, workspace_slug: 'ws', workspace_id: 'ws-1',
  daemon_id: 'daemon-1', poll_interval_s: 1, runtime: { type: 'zylos', name: 'e2e (zylos)', version: '0.2.21' } };

function harness(t, { comment, title = 'Big comment', c4Exit = 0 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const received = path.join(root, 'c4-received.jsonl');
  const c4Stub = path.join(root, 'c4-receive.cjs');
  fs.writeFileSync(c4Stub, `const a = process.argv; require('fs').appendFileSync(${JSON.stringify(received)}, JSON.stringify({ endpoint: a[a.indexOf('--endpoint') + 1], content: a[a.indexOf('--content') + 1] }) + '\\n'); console.log('{"ok":true}'); process.exitCode = ${c4Exit};`);
  const schedulerStub = path.join(root, 'scheduler.cjs');
  fs.writeFileSync(schedulerStub, `console.log('[]');`);
  const task = { id: 'task-big', issue_id: 'issue-1', workspace_id: 'ws-1', agent_id: 'agent-1', runtime_id: 'rt-1',
    dispatched_at: '2026-11-08T01:02:03.123456Z', start_claim_supported: true, auth_token: CLAIM,
    trigger_comment_id: 'c-1', trigger_comment_content: comment, trigger_author_name: 'howard', trigger_author_type: 'member' };
  let claimed = false;
  const routes = [];
  let state;
  const request = async (_c, method, route) => {
    routes.push(`${method} ${route}`);
    if (route === '/api/daemon/register') return { runtimes: [{ id: 'rt-1', type: 'zylos' }] };
    if (route === '/api/daemon/heartbeat') return {};
    if (route === '/api/daemon/tasks/claim') { if (claimed) return { tasks: [] }; claimed = true; return { tasks: [task] }; }
    if (route === '/api/issues/issue-1') return { id: 'issue-1', identifier: 'ZYLO-1', title, description: 'desc' };
    if (route === `/api/daemon/tasks/${task.id}/start`) return { ...task, status: 'running' };
    throw Object.assign(new Error(`unexpected route ${route}`), { status: 404 });
  };
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(String(line)));
  const bridge = createBridge(config, {
    request, createWakeupChannel: () => ({ start() {}, stop() {} }),
    // Real runNodeScript and execFile; only the target script path is redirected.
    runScript: (script, args, timeout) => runNodeScript(script.endsWith('c4-receive.js') ? c4Stub : schedulerStub, args, timeout),
    preparationRoot: path.join(root, 'preparations'),
    createTaskState: (cfg, deps) => (state = createTaskState(cfg, { ...deps, root: path.join(root, 'state'), removeTaskToken() {} })),
    storeTaskToken: () => {}, storeTaskContext: () => ({ index: path.join(root, 'context.md') }), storeTaskAttachments: () => {},
  });
  t.after(() => bridge.stop());
  return {
    bridge, routes, logs, task,
    received: () => (fs.existsSync(received) ? fs.readFileSync(received, 'utf8').trim().split('\n').map(JSON.parse) : []),
    record: () => state?.get(task.id),
    async settle(check) {
      for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 25));
      await new Promise(resolve => setTimeout(resolve, 50));
    },
  };
}

test('runNodeScript turns a synchronous spawn E2BIG into {ok:false} instead of rejecting', async () => {
  // 4 MiB exceeds Linux MAX_ARG_STRLEN and the total ARG_MAX on macOS.
  const result = await runNodeScript('-e', ['0', 'x'.repeat(4 * 1024 * 1024)]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E2BIG');
});

test('131 KB comment with a base64 image: card is truncated, delivered once, one start', async t => {
  const png = Buffer.alloc(100_000, 7).toString('base64');
  const comment = `Please look at this screenshot:\n\n![screenshot](data:image/png;base64,${png})\n\nThanks`;
  assert.ok(Buffer.byteLength(comment) > 131_072);
  const h = harness(t, { comment });
  await h.bridge.tick();
  await h.settle(() => h.record()?.delivery?.delivered);
  await h.bridge.tick();
  await h.settle(() => false);
  const received = h.received();
  assert.equal(received.length, 1);
  assert.ok(Buffer.byteLength(received[0].content) <= CARD_BYTE_BUDGET);
  assert.match(received[0].content, /^\[Multica follow-up\] Big comment\n/);
  assert.match(received[0].content, /\[Truncated to fit the session handoff: showing \d+ of \d+ bytes\. Full text: [^\n]*issue comment list 'ZYLO-1' --thread 'c-1' --output json\]/);
  assert.equal(h.routes.filter(r => r.endsWith('/start')).length, 1);
  assert.equal(h.record().delivery.delivered, true);
  assert.equal(h.record().report, null);
  assert.equal(h.logs.some(line => /WARN|ERROR/.test(line)), false, h.logs.join('\n'));
});

test('an oversize card that cannot be truncated logs E2BIG once with stage, never the card or secrets', async t => {
  // Titles are server metadata and are not truncated, so this card still exceeds the argv limit.
  const title = `T${'标题'.repeat(25_000)} ${PAT} ${CLAIM}`;
  const h = harness(t, { comment: 'short', title });
  await h.bridge.tick();
  await h.settle(() => h.logs.some(line => line.includes('task handoff deferred')));
  for (let i = 0; i < 2; i++) { await h.bridge.tick(); await h.settle(() => false); }
  const c4 = h.logs.filter(line => line.includes('c4 delivery failed'));
  assert.equal(c4.length, 3, 'each real spawn failure is reported by the C4 delivery path');
  assert.match(c4[0], /"code":"E2BIG"/);
  const deferred = h.logs.filter(line => line.includes('task handoff deferred'));
  assert.equal(deferred.length, 1, h.logs.join('\n'));
  assert.match(deferred[0], /WARN \[multica\] task handoff deferred \{"task_id":"task-big","stage":"deliver","code":"E2BIG","error":"C4 delivery failed","attempts":1\}/);
  const all = h.logs.join('\n');
  assert.doesNotMatch(all, /标题|SECRET|Multica follow-up/);
  assert.equal(h.received().length, 0);
});

test('a C4 script that exits non-zero is logged with its exit code, never with the card argv', async t => {
  const h = harness(t, { comment: `secret-free but private comment body ${CLAIM}`, c4Exit: 3 });
  await h.bridge.tick();
  await h.settle(() => h.logs.some(line => line.includes('task handoff deferred')));
  const c4 = h.logs.filter(line => line.includes('c4 delivery failed'));
  assert.equal(c4.length, 1);
  assert.match(c4[0], /ERROR \[multica\] c4 delivery failed \{"endpoint":"task-big@[0-9a-f-]+","code":"EXIT_3","error":"Command failed: \[command omitted\]\\n"\}/);
  assert.match(h.logs.join('\n'), /task handoff deferred \{"task_id":"task-big","stage":"deliver","code":"EXIT_3"/);
  assert.doesNotMatch(h.logs.join('\n'), /private comment body|Multica follow-up|SECRET|--content/);
  assert.equal(h.received().length, 1, 'the stub did run');
});
