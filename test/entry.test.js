import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function spawnPm2LikeService(home) {
  return new Promise((resolve, reject) => {
    const entryUrl = pathToFileURL(path.join(root, 'src/main.js')).href;
    const bootstrap = `process.argv[1] = '/fake/ProcessContainerFork.js'; await import(${JSON.stringify(entryUrl)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', bootstrap], {
      cwd: root,
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sawStart = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`service did not start under PM2-like argv; stdout=${stdout}; stderr=${stderr}`));
    }, 5_000);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (!sawStart && stdout.includes('bridge starting')) {
        sawStart = true;
        child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      if (sawStart) resolve({ stdout, stderr });
      else reject(new Error(`service exited before startup; stdout=${stdout}; stderr=${stderr}`));
    });
  });
}

test('service entry starts when PM2 owns process.argv[1]', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-entry-'));
  const dataDir = path.join(home, 'zylos/components/multica');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    base_url: 'http://127.0.0.1:1',
    pat: 'secret',
    workspace_id: 'workspace-1',
    daemon_id: 'daemon-1',
    poll_interval_s: 1,
    runtime: { name: 'Agent (zylos)' },
  }), { mode: 0o600 });

  const result = await spawnPm2LikeService(home);
  assert.match(result.stdout, /INFO \[multica\] bridge starting/);
  assert.doesNotMatch(result.stdout + result.stderr, /secret/);
});

test('every service launcher points at the unconditional entry', () => {
  const ecosystem = require('../ecosystem.config.cjs');
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const skill = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');

  assert.equal(ecosystem.apps[0].script, 'src/main.js');
  assert.equal(packageJson.scripts.start, 'node src/main.js');
  assert.match(skill, /\n\s+entry: src\/main\.js\n/);
});
