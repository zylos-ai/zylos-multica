import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import test from 'node:test';

const moduleURL = new URL('../src/lib/task-state.js', import.meta.url).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, description, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await delay(20);
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-lock-'));
  const workers = [];
  t.after(async () => {
    // Detached workers isolate all their helper descendants for failure cleanup.
    for (const worker of workers) {
      try { process.kill(-worker.child.pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await Promise.all(workers.map(worker => until(() => worker.exited, 'worker cleanup')));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const lockfile = path.join(root, `task's "quoted" lock file.lock`);
  function worker(mode = 'hold') {
    const source = `
      import { withTaskLock } from ${JSON.stringify(moduleURL)};
      const release = new Promise(resolve => process.on('message', m => { if (m === 'release') resolve(); }));
      const pending = withTaskLock(${JSON.stringify(lockfile)}, async () => {
        process.send('entered');
        if (${JSON.stringify(mode)} === 'throw') throw new Error('operation failed');
        if (${JSON.stringify(mode)} === 'hold') await release;
        return 42;
      });
      process.send('waiting');
      try { process.send({ result: await pending }); }
      catch (error) { process.send({ error: error.message }); }
      process.disconnect();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...(process.platform === 'darwin' ? { PATH: '/usr/bin:/bin' } : {}) },
    });
    const state = { child, messages: [], exited: false, stderr: '', code: null, signal: null };
    child.on('message', message => state.messages.push(message));
    child.stderr.on('data', data => { state.stderr += data; });
    child.on('error', error => { state.stderr += error.message; });
    child.on('exit', (code, signal) => { Object.assign(state, { exited: true, code, signal }); });
    workers.push(state);
    state.wait = async message => {
      await until(() => state.messages.includes(message) || state.exited, `worker ${message}`);
      assert.ok(state.messages.includes(message), `worker exited before ${message}: ${state.stderr}`);
    };
    state.finish = async () => {
      await until(() => state.exited, 'worker exit');
      assert.equal(state.code, 0, state.stderr);
      return state.messages.find(message => typeof message === 'object');
    };
    return state;
  }
  return { worker, lockfile };
}

test('OS task lock excludes another process and releases on normal completion; quoted path is literal', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const first = f.worker();
  await first.wait('entered');
  const second = f.worker('return');
  await second.wait('waiting');
  await delay(150);
  assert.ok(!second.messages.includes('entered'), 'second process entered a held lock');
  first.child.send('release');
  assert.deepEqual(await first.finish(), { result: 42 });
  await second.wait('entered');
  assert.deepEqual(await second.finish(), { result: 42 });
  assert.equal(fs.statSync(f.lockfile).mode & 0o777, 0o600);
});

test('operation exception propagates and releases the OS lock for another process', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const failing = f.worker('throw');
  assert.deepEqual(await failing.finish(), { error: 'operation failed' });
  const successor = f.worker('return');
  await successor.wait('entered');
  assert.deepEqual(await successor.finish(), { result: 42 });
});

test('SIGKILL of lock holder releases the OS lock and allows a waiting process to finish', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const holder = f.worker();
  await holder.wait('entered');
  const waiter = f.worker('return');
  await waiter.wait('waiting');
  await delay(150);
  assert.ok(!waiter.messages.includes('entered'));
  holder.child.kill('SIGKILL');
  await until(() => holder.exited, 'killed holder exit');
  assert.equal(holder.signal, 'SIGKILL');
  await waiter.wait('entered');
  assert.deepEqual(await waiter.finish(), { result: 42 });
});

test('waiter parent dies before acquisition: helper exits and later contenders do not hang', { timeout: 15000 }, async t => {
  const f = fixture(t);
  const holder = f.worker();
  await holder.wait('entered');
  const waiter = f.worker();
  await waiter.wait('waiting');
  const helpers = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(([, ppid]) => ppid === waiter.child.pid).map(([pid]) => pid);
  assert.ok(helpers.length > 0, 'waiter must have spawned the real lock helper');
  assert.ok(!waiter.messages.includes('entered'));
  waiter.child.kill('SIGKILL');
  await until(() => waiter.exited, 'killed waiter exit');
  // A helper blocked in the kernel may exit only after the live holder releases.
  holder.child.send('release');
  await holder.finish();
  const successor = f.worker('return');
  await successor.wait('entered');
  assert.deepEqual(await successor.finish(), { result: 42 });
  await until(() => helpers.every(pid => !alive(pid)), 'waiter helper exit after release');
});
