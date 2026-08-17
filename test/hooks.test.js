import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(script, args, options = {}) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    encoding: 'utf8',
    ...options,
  });
}

function runAsync(script, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], options);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('configure writes merged config atomically with mode 0600', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-config-'));
  const input = JSON.stringify({
    MULTICA_BASE_URL: 'https://multica.example',
    MULTICA_PAT: 'pat-value',
    MULTICA_WORKSPACE_ID: 'workspace-1',
    MULTICA_RUNTIME_NAME: 'Agent (zylos)',
  });
  const result = run('hooks/configure.js', [], { env: { ...process.env, HOME: home }, input });
  assert.equal(result.status, 0, result.stderr);
  const configPath = path.join(home, 'zylos/components/multica/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.pat, 'pat-value');
  assert.equal(config.runtime.name, 'Agent (zylos)');
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, /pat-value/);
});

test('post-upgrade is idempotent and preserves removed runtime type', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-upgrade-'));
  const dataDir = path.join(home, 'zylos/components/multica');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ runtime: { name: 'Agent', type: 'unsafe' } }));
  const first = run('hooks/post-upgrade.js', [], { env: { ...process.env, HOME: home } });
  assert.equal(first.status, 0, first.stderr);
  const afterFirst = fs.readFileSync(configPath, 'utf8');
  const second = run('hooks/post-upgrade.js', [], { env: { ...process.env, HOME: home } });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(configPath, 'utf8'), afterFirst);
  const config = JSON.parse(afterFirst);
  assert.equal(config._legacy_runtime_type, 'unsafe');
  assert.equal(config.runtime.type, undefined);
  assert.match(second.stdout, /No migrations needed/);
});

test('post-install generates one stable daemon id and keeps config mode 0600', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-install-'));
  const env = { ...process.env, HOME: home, PATH: '/nonexistent' };
  const first = run('hooks/post-install.js', [], { env });
  assert.equal(first.status, 0, first.stderr);
  const configPath = path.join(home, 'zylos/components/multica/config.json');
  const firstConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.match(firstConfig.daemon_id, /^[0-9a-f-]{36}$/);
  const second = run('hooks/post-install.js', [], { env });
  assert.equal(second.status, 0, second.stderr);
  const secondConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(secondConfig.daemon_id, firstConfig.daemon_id);
  assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
});

test('pre-upgrade creates a private config backup', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-backup-'));
  const dataDir = path.join(home, 'zylos/components/multica');
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(configPath, '{"pat":"secret"}\n', { mode: 0o600 });
  const result = run('hooks/pre-upgrade.js', [], { env: { ...process.env, HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(`${configPath}.backup`, 'utf8'), '{"pat":"secret"}\n');
  assert.equal(fs.statSync(`${configPath}.backup`).mode & 0o777, 0o600);
  assert.doesNotMatch(result.stdout + result.stderr, /secret/);
});

test('send.js completes text and rejects media without a request', async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-send-'));
  const dataDir = path.join(home, 'zylos/components/multica');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    base_url: `http://127.0.0.1:${server.address().port}`,
    pat: 'secret',
    workspace_id: 'workspace-1',
    daemon_id: 'daemon-1',
    runtime: { name: 'Agent (zylos)' },
  }), { mode: 0o600 });
  const env = { ...process.env, HOME: home };
  const textResult = await runAsync('scripts/send.js', ['task-1', 'done'], { env });
  assert.equal(textResult.status, 0, textResult.stderr);
  const progressResult = await runAsync('scripts/report.js', ['progress', 'task-1', 'halfway'], { env });
  assert.equal(progressResult.status, 0, progressResult.stderr);
  const failResult = await runAsync('scripts/report.js', ['fail', 'task-2', 'blocked'], { env });
  assert.equal(failResult.status, 0, failResult.stderr);
  const mediaResult = run('scripts/send.js', ['task-1', '[MEDIA:image]/tmp/a.png'], { env });
  assert.equal(mediaResult.status, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(requests, [
    { url: '/api/daemon/tasks/task-1/complete', body: { output: 'done' } },
    { url: '/api/daemon/tasks/task-1/progress', body: { summary: 'halfway' } },
    { url: '/api/daemon/tasks/task-2/fail', body: { error: 'blocked' } },
  ]);
  server.close();
});
