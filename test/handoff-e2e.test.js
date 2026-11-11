// Task handoff end to end (zylos-multica #56): real createBridge, real
// dispatcher and task state, real runNodeScript -> child_process.execFile. Only
// the network (request) and the C4/scheduler scripts are stubs, written to a
// temporary directory and removed by t.after.
//
// Isolation: run only with HOME (and so ZYLOS_DIR), PM2_HOME and a short TMPDIR
// pointing at a fresh temporary directory, never against a live install. These
// cases write only under os.tmpdir(). src/index.js READS the task-token
// directory under HOME (~/zylos/components/multica/task-tokens) to redact a
// claim token from logs; with an isolated HOME it does not exist. No PM2, tmux,
// network or database is used; every child process has the 20 s runNodeScript
// timeout and the bridge is stopped by t.after.
//
// Run these when changing src/index.js (runNodeScript, C4 delivery, the
// dispatcher wiring), src/lib/task-dispatch.js, src/lib/cards.js budgeting or
// src/lib/log-redact.js. They can be skipped for changes that touch none of
// those (business CLI, attachments, wakeup, config).
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

// c4: 'ok' | 'json-failure' (what c4-receive --json prints on failure: JSON on
// stdout, empty stderr, exit 1) | 'exit' (non-zero exit without output).
function harness(t, { comment, title = 'Big comment', c4 = 'ok' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const received = path.join(root, 'c4-received.jsonl');
  const c4Stub = path.join(root, 'c4-receive.cjs');
  const outcome = {
    ok: `console.log('{"ok":true,"action":"queued","id":1}');`,
    'json-failure': `console.log(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'failed to queue message: database is locked (auth ${CLAIM})' } })); process.exitCode = 1;`,
    exit: 'process.exitCode = 3;',
  }[c4];
  fs.writeFileSync(c4Stub, `const a = process.argv; require('fs').appendFileSync(${JSON.stringify(received)}, JSON.stringify({ endpoint: a[a.indexOf('--endpoint') + 1], content: a[a.indexOf('--content') + 1] }) + '\\n'); ${outcome}`);
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

// Boundary: the kernel's synchronous spawn rejection reaches callers as {ok:false}.
test('runNodeScript turns a synchronous spawn E2BIG into {ok:false} instead of rejecting', async () => {
  // 4 MiB exceeds Linux MAX_ARG_STRLEN and the total ARG_MAX on macOS.
  const result = await runNodeScript('-e', ['0', 'x'.repeat(4 * 1024 * 1024)]);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'E2BIG');
});

// Boundary: claim -> snapshot -> card budget -> start -> real argv delivery for the reported 131 KB comment.
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
  assert.match(received[0].content, /^\[Multica follow-up\] ZYLO-1 · howard 新评论：Please look at this screenshot: [^\n]+\n卡片：Big comment\n/);
  assert.match(received[0].content, /\[Truncated to fit the session handoff: showing \d+ of \d+ bytes\. Full text: [^\n]*issue comment list 'ZYLO-1' --thread 'c-1' --full --output json\]/);
  assert.equal(h.routes.filter(r => r.endsWith('/start')).length, 1);
  assert.equal(h.record().delivery.delivered, true);
  assert.equal(h.record().report, null);
  assert.equal(h.logs.some(line => /WARN|ERROR/.test(line)), false, h.logs.join('\n'));
});

// Boundary: a real E2BIG through the bridge's C4 path into the dispatcher's failure record and log.
test('an oversize card that cannot be truncated logs E2BIG once with stage, never the card or secrets', async t => {
  // Titles are server metadata and are not truncated, so this card still exceeds the argv limit.
  // The spawn must fail on every CI platform: Linux rejects any single argument
  // of 128 KiB or more (MAX_ARG_STRLEN); macOS has no per-argument limit, only
  // about 1 MiB for argv and environment together (kern.argmax). A ~1.5 MB title
  // is over both, so both fail with a real spawn E2BIG.
  const title = `T${'标题'.repeat(250_000)} ${PAT} ${CLAIM}`;
  const h = harness(t, { comment: 'short', title });
  await h.bridge.tick();
  await h.settle(() => h.logs.some(line => line.includes('task handoff deferred')));
  for (let i = 0; i < 2; i++) { await h.bridge.tick(); await h.settle(() => false); }
  const c4 = h.logs.filter(line => line.includes('c4 delivery failed'));
  assert.equal(c4.length, 3, 'each real spawn failure is reported by the C4 delivery path');
  assert.match(c4[0], /"code":"E2BIG"/);
  const deferred = h.logs.filter(line => line.includes('task handoff deferred'));
  assert.equal(deferred.length, 1, h.logs.join('\n'));
  assert.match(deferred[0], /WARN \[multica\] task handoff deferred \{"task_id":"task-big","stage":"deliver","code":"E2BIG","error":"C4 delivery failed: spawn E2BIG","attempts":1\}/);
  const all = h.logs.join('\n');
  assert.doesNotMatch(all, /标题|SECRET|Multica follow-up/);
  assert.equal(h.received().length, 0);
});

// Boundary: c4-receive's JSON failure (stdout, empty stderr) reaches the ERROR and the dispatcher's record.
test('a C4 JSON failure is logged with its code and redacted message, never with the card argv', async t => {
  const h = harness(t, { comment: `private comment body ${CLAIM}`, c4: 'json-failure' });
  await h.bridge.tick();
  await h.settle(() => h.logs.some(line => line.includes('task handoff deferred')));
  const c4 = h.logs.filter(line => line.includes('c4 delivery failed'));
  assert.equal(c4.length, 1);
  assert.match(c4[0], /ERROR \[multica\] c4 delivery failed \{"endpoint":"task-big@[0-9a-f-]+","code":"INTERNAL_ERROR","error":"failed to queue message: database is locked \(auth mat_\[REDACTED\]\)"\}$/);
  assert.match(h.logs.join('\n'), /task handoff deferred \{"task_id":"task-big","stage":"deliver","code":"INTERNAL_ERROR","error":"C4 delivery failed: failed to queue message: database is locked \(auth mat_\[REDACTED\]\)","attempts":1\}/);
  assert.doesNotMatch(h.logs.join('\n'), /private comment body|Multica follow-up|SECRET|--content|Command failed/);
  assert.equal(h.received().length, 1, 'the stub did run');
});

// Boundary: a failing C4 script without JSON output; the child error message carries the argv.
test('a C4 script that exits non-zero without output is logged with its exit code, never with the card argv', async t => {
  const h = harness(t, { comment: `secret-free but private comment body ${CLAIM}`, c4: 'exit' });
  await h.bridge.tick();
  await h.settle(() => h.logs.some(line => line.includes('task handoff deferred')));
  const c4 = h.logs.filter(line => line.includes('c4 delivery failed'));
  assert.equal(c4.length, 1);
  assert.match(c4[0], /ERROR \[multica\] c4 delivery failed \{"endpoint":"task-big@[0-9a-f-]+","code":"EXIT_3","error":"Command failed: \[command omitted\]\\n"\}/);
  assert.match(h.logs.join('\n'), /task handoff deferred \{"task_id":"task-big","stage":"deliver","code":"EXIT_3"/);
  assert.doesNotMatch(h.logs.join('\n'), /private comment body|Multica follow-up|SECRET|--content/);
  assert.equal(h.received().length, 1, 'the stub did run');
});
