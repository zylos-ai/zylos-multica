import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Covers real CLI admission, inspection, stop and reporting after state deletion.
// Run for CLI/lifecycle absence changes; unrelated UI/API changes can skip.
// HOME, ZYLOS_DIR, PM2_HOME and short TMPDIR are private; no tmux or database is used.
test('real CLI quietly ignores a missing bound task and refuses begin admission', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bound-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), pm2 = path.join(root, 'pm2'), tmp = path.join(root, 'tmp');
  const zylos = path.join(home, 'zylos');
  for (const dir of [home, pm2, tmp]) fs.mkdirSync(dir, { recursive: true });
  const data = path.join(zylos, 'components/multica'); fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ base_url: 'http://127.0.0.1:1',
    workspace_id: 'workspace', daemon_id: 'daemon', pat: 'fixture', runtime_name: 'fixture' }));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2, TMPDIR: tmp };
  for (const key of Object.keys(env)) if (key.startsWith('MULTICA_')) delete env[key];
  const endpoint = 'removed@11111111-1111-4111-8111-111111111111';
  const commands = [['send', endpoint, 'done'], ['task', 'begin', endpoint], ['task', 'inspect', endpoint],
    ['task', 'quiesce', endpoint, '--stopped'], ['task', 'abandon', endpoint, '--reason', 'stopped', '--stopped'],
    ...['progress', 'fail', 'reconcile', 'complete-posted'].map(action => ['report', action, endpoint, ...(action === 'reconcile' ? [] : ['done'])])];
  for (const [script, ...args] of commands) {
    const result = spawnSync(process.execPath, [`scripts/${script}.js`, ...args], {
      cwd: path.resolve(import.meta.dirname, '..'), env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
    assert.equal(result.stderr, '');
    if (args[0] === 'begin') assert.equal(JSON.parse(result.stdout).accepted, false);
    else assert.equal(result.stdout, '');
  }
  assert.equal(fs.readdirSync(path.join(data, 'task-state')).some(name => name.endsWith('.json')), false);
});
