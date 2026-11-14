import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

// Opt in with an existing Core checkout and installed Core dependencies. No
// installs, model calls, live daemon, network transport or production DBs.
// Example: MULTICA_CORE_ACCEPTANCE_ROOT=/path/to/zylos-core node --test test/core-session-acceptance.test.js
// Evidence is retained outside this repository if MULTICA_CORE_EVIDENCE_DIR is set.
test('isolated Core routes cards, validates sender, and reactivates with scoped memory', {
  skip: !process.env.MULTICA_CORE_ACCEPTANCE_ROOT,
  timeout: 45000,
}, async t => {
  const core = fs.realpathSync(process.env.MULTICA_CORE_ACCEPTANCE_ROOT);
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/mc-'));
  const home = path.join(dir, 'h'), root = path.join(home, 'zylos');
  const socketPath = path.join(dir, 's');
  const evidence = process.env.MULTICA_CORE_EVIDENCE_DIR;
  const savedEnv = { ...process.env };
  const env = { PATH: savedEnv.PATH, HOME: home, ZYLOS_DIR: root, PM2_HOME: path.join(dir, 'pm2'), TMPDIR: path.join(dir, 'tmp'), TZ: 'Asia/Singapore', ZYLOS_PACKAGE_ROOT: core };
  Object.keys(process.env).forEach(key => { delete process.env[key]; });
  Object.assign(process.env, env);
  let router, db, bridge;
  const commands = [], events = [];
  const command = (binary, args) => {
    const result = spawnSync(binary, args, { env, encoding: 'utf8', timeout: 5000 });
    commands.push({ binary, args, status: result.status, signal: result.signal, error: result.error?.code });
    return result;
  };
  t.after(async () => {
    try { try { bridge?.stop(); } finally { await router?.stop(); } } finally {
      try {
        command('tmux', ['-S', socketPath, 'kill-server']);
        let absent;
        for (let attempt = 0; attempt < 50; attempt++) {
          absent = command('tmux', ['-S', socketPath, '-N', 'list-sessions']);
          if (absent.status !== 0) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(absent.status, 1, 'private tmux server must be gone');
        if (evidence) {
          fs.mkdirSync(evidence, { recursive: true });
          fs.writeFileSync(path.join(evidence, 'commands.json'), JSON.stringify(commands, null, 2));
          fs.writeFileSync(path.join(evidence, 'router-events.json'), JSON.stringify(events, null, 2));
          for (const name of ['runtime-launches.jsonl', 'component-events.jsonl', 'isolation.json']) if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(evidence, name));
          if (db?.open) { db.pragma('wal_checkpoint(TRUNCATE)'); fs.copyFileSync(path.join(root, 'comm-bridge/c4.db'), path.join(evidence, 'c4.db')); }
        }
      } finally {
        try { db?.close(); } finally {
          fs.rmSync(dir, { recursive: true, force: true });
          Object.keys(process.env).forEach(key => { delete process.env[key]; }); Object.assign(process.env, savedEnv);
        }
      }
    }
  });
  for (const name of [root, env.TMPDIR, env.PM2_HOME, path.join(root, 'comm-bridge'), path.join(root, '.claude/skills')]) fs.mkdirSync(name, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi', timezone: env.TZ }));
  for (const name of ['comm-bridge', 'zylos-memory']) fs.symlinkSync(path.join(core, 'skills', name), path.join(root, '.claude/skills', name));
  const skills = path.join(root, 'test-skills'), scripts = path.join(skills, 'multica/scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.symlinkSync(path.join(skills, 'multica'), path.join(root, '.claude/skills/multica'));
  fs.symlinkSync(path.join(repo, 'scripts/session-group.js'), path.join(scripts, 'session-group.js'));
  fs.writeFileSync(path.join(scripts, 'send.js'), 'process.exit(0);\n'); // transport boundary only
  const probe = command(process.execPath, ['-e', 'console.log(JSON.stringify(Object.fromEntries(["HOME","ZYLOS_DIR","PM2_HOME","TMPDIR","TZ"].map(k=>[k,process.env[k]]))))']);
  assert.equal(probe.status, 0);
  assert.deepEqual(JSON.parse(probe.stdout), Object.fromEntries(['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','TZ'].map(k => [k, env[k]])));
  const isolation = { ...JSON.parse(probe.stdout), socketPath, db: path.join(root, 'comm-bridge/c4.db'), core, session_mode: 'multi' };
  for (const key of ['HOME','ZYLOS_DIR','PM2_HOME','TMPDIR','socketPath','db']) assert.ok(isolation[key].startsWith(dir + '/'));
  assert.ok(Buffer.byteLength(socketPath) < 90);
  fs.writeFileSync(path.join(root, 'isolation.json'), JSON.stringify(isolation, null, 2));
  t.diagnostic('Isolation readback: ' + JSON.stringify(isolation));
  const load = relative => import(pathToFileURL(path.join(core, relative)).href);
  const [{ guardDatabase }, schema, { createStore }, { receive }, { createRouter }, { getSessionAdapter }, { createSessionReader }, { readReadyIdentity }, groupPaths, { sendExternal }] = await Promise.all([
    load('skills/comm-bridge/scripts/sqlite-schema.js'), load('skills/comm-bridge/scripts/c4-schema.js'), load('skills/comm-bridge/scripts/c4-v2-store.js'), load('skills/comm-bridge/scripts/c4-receive.js'), load('skills/comm-bridge/scripts/router/scheduler.js'), load('cli/lib/runtime/index.js'), load('cli/lib/session-state-reader-async.js'), load('cli/lib/runtime/session-target.js'), load('cli/lib/session-group-paths.js'), load('skills/comm-bridge/scripts/c4-send-external.js'),
  ]);
  const Database = createRequire(path.join(core, 'package.json'))('better-sqlite3');
  db = new Database(isolation.db); guardDatabase(db, schema);
  const store = createStore(db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true });
  const api = { ...store, getDb: () => db, getControlById: id => db.prepare('SELECT * FROM control_queue WHERE id=?').get(id), expireTimedOutControls: () => 0, cleanupControlQueue: () => 0 };
  const { createBridge } = await import('../src/index.js');
  const { buildTaskEndpoint } = await import('../src/lib/session-group.js');
  bridge = createBridge({ pat: 'fixture', runtime: {} }, { createWakeupChannel: () => ({ stop() {} }), runScript: async (script, args) => {
    assert.equal(fs.realpathSync(script), path.join(core, 'skills/comm-bridge/scripts/c4-receive.js'));
    const result = await receive(args, { db: api, queryRoute: async () => ({ decision: 'pending', runtime: 'claude' }), appendEntryEvent: async event => fs.appendFileSync(path.join(root, 'component-events.jsonl'), JSON.stringify(event) + '\n') });
    fs.appendFileSync(path.join(root, 'component-events.jsonl'), JSON.stringify({ component: 'multica', endpoint: args[args.indexOf('--endpoint') + 1], ...result }) + '\n');
    return { ok: true, stdout: JSON.stringify(result), stderr: '' };
  } });
  const tmux = { binary: 'tmux', socketPath, configFile: '/dev/null' };
  const reader = createSessionReader({ connectionOptions: tmux });
  let clock = Date.now();
  const adapter = () => {
    const value = getSessionAdapter('claude', { root, tmux, env, runtimeExecutable: () => path.join(repo, 'test/fixtures/core-session-recorder.cjs') });
    const launch = value.launch.bind(value);
    value.launch = async input => { try { return await launch(input); } catch (error) { events.push({ event: 'fixture_launch_error', message: error.message, stack: error.stack }); throw error; } };
    return value;
  };
  // Recorder executable is passed through the supported adapter seam.
  router = createRouter({ db: api, now: () => clock, readSessionMode: () => ({ mode: 'multi', keyPresent: true }), readLiveIdentity: reader.readLiveIdentity, readCurrentSession: readReadyIdentity, listGroupTmuxSessions: () => groupPaths.listGroupTmuxSessions(tmux), readRuntimeHealth: () => ({ health: 'ok', publicHealth: 'ok' }), getSessionAdapter: adapter, submit: async () => assert.fail('unexpected submit'), deliverControl: async () => assert.fail('unexpected control'), deliverConversation: async (message, identity) => api.markDelivered(message.id, { sessionId: identity.sessionId }), handleExpired: async () => assert.fail('fresh rows expired'), prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {}, diagnostic: (event, fields) => events.push({ event, ...fields }) }, { poolSize: () => 4, readyTimeoutMs: 10000 });
  api.setDrainFence('origin', { reason: 'upgrade', runId: 'acceptance-fixture' });
  const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
  const endpoint = (id, issue) => buildTaskEndpoint({ id, execution_generation: '33333333-3333-4333-8333-333333333333', issue_id: issue });
  const groupA = 'multica:issue-' + a, groupB = 'multica:issue-' + b;
  await bridge.deliverToC4('ZYLO-500 first card', endpoint('task-a', a));
  await bridge.deliverToC4('ZYLO-501 second card', endpoint('task-b', b));
  await router.initialize();
  const drain = async () => {
    for (let i = 0; i < 150; i++) {
      clock += 1000; router.tick(); await router.idle();
      if (!db.prepare("SELECT 1 FROM conversations WHERE status IN ('pending','running')").get()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(JSON.stringify({ rows: db.prepare('SELECT * FROM conversations').all(), events }));
  };
  await drain();
  const initial = db.prepare("SELECT * FROM conversations WHERE direction='in' ORDER BY id").all();
  assert.deepEqual(initial.map(row => row.session_group), [groupA, groupB]);
  assert.ok(initial.every(row => row.status === 'delivered'));
  const liveA = await reader.readLiveIdentity(groupA), liveB = await reader.readLiveIdentity(groupB);
  assert.equal(liveA.ready, true); assert.equal(liveB.ready, true); assert.notEqual(liveA.runId, liveB.runId);
  await bridge.deliverToC4('ZYLO-500 reviewer comment', endpoint('task-a-comment', a)); await drain();
  assert.equal((await reader.readLiveIdentity(groupA)).runId, liveA.runId);
  const memoryDir = groupPaths.groupMemoryDir(groupA, env); fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'inbox.md'), 'acceptance-memory-only-ZYLO-500\n');
  await adapter().stop({ tmuxName: groupPaths.tmuxNameForGroup(groupA), expectedRunId: liveA.runId });
  for (let i = 0; i < 3; i++) { clock += 1000; router.tick(); await router.idle(); }
  // Supervisor is outside this contract fixture: stop and release explicitly
  // through Core APIs after scene refresh prevents stale slot adoption.
  assert.deepEqual(api.releaseSlot(groupA, { runId: liveA.runId, prior: null }), { released: true });
  await bridge.deliverToC4('ZYLO-500 later repair', endpoint('task-a-later', a)); await drain();
  const reactivated = await reader.readLiveIdentity(groupA);
  assert.equal(reactivated.ready, true); assert.notEqual(reactivated.runId, liveA.runId);
  const launches = fs.readFileSync(path.join(root, 'runtime-launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const resumed = launches.find(row => row.runId === reactivated.runId);
  assert.equal(resumed.group, groupA); assert.equal(resumed.memoryStatus, 0); assert.match(resumed.memory, /acceptance-memory-only-ZYLO-500/);
  assert.ok(launches.filter(row => row.group === groupB).every(row => !row.memory.includes('acceptance-memory-only-ZYLO-500')));
  const request = { channel: 'multica', endpoint: endpoint('task-a-later', a) };
  await sendExternal(request, 'fixture transport response', { api, skillsDir: skills, env: { ...env, ZYLOS_SESSION_GROUP: groupA, ZYLOS_RUN_ID: reactivated.runId } });
  const count = db.prepare('SELECT count(*) n FROM conversations').get().n;
  await assert.rejects(sendExternal(request, 'wrong session', { api, skillsDir: skills, env: { ...env, ZYLOS_SESSION_GROUP: groupB } }), { code: 'CROSS_SESSION_OUTBOUND' });
  assert.equal(db.prepare('SELECT count(*) n FROM conversations').get().n, count);
  await bridge.deliverToC4('pre-upgrade card', 'legacy-task@44444444-4444-4444-8444-444444444444'); await drain();
  assert.equal(db.prepare("SELECT session_group FROM conversations WHERE endpoint_id='legacy-task@44444444-4444-4444-8444-444444444444' AND direction='in'").get().session_group, 'multica');
  await sendExternal({ channel: 'multica', endpoint: 'legacy-task@44444444-4444-4444-8444-444444444444' }, 'legacy report route', { api, skillsDir: skills, env: { ...env, ZYLOS_SESSION_GROUP: 'multica' } });
  const rows = db.prepare('SELECT id,direction,endpoint_id,session_group,status,session_id FROM conversations ORDER BY id').all();
  if (evidence) { fs.mkdirSync(evidence, { recursive: true }); fs.writeFileSync(path.join(evidence, 'ledger.json'), JSON.stringify(rows, null, 2)); fs.writeFileSync(path.join(evidence, 'router-events.json'), JSON.stringify(events, null, 2)); }
  t.diagnostic(JSON.stringify({ rows, launches: launches.map(({ group, runId, memoryStatus }) => ({ group, runId, memoryStatus })), limitations: 'Runtime READY, health and model are fixtures; stop/release is explicit, not idle-supervisor driven; Router delivery callback commits ledger without terminal/model turn; send transport is a no-op; legacy report validates C4 ownership only, not platform task completion.' }));
});
