#!/usr/bin/env node
// Local feasibility probe only. Does not claim Multica/C4 E2E or sandbox enforcement.
// Keeps all artifacts for inspection; run in a fresh --output directory.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output')) {
  throw new Error('Usage: node scripts/probes/worktree-isolation.mjs [--output <new-directory>]');
}
const root = args.length ? path.resolve(args[1]) : fs.mkdtempSync(path.join(os.tmpdir(), 'multica-worktree-probe-'));
if (args.length) fs.mkdirSync(root, { mode: 0o700 });
const source = path.join(root, 'source');
fs.mkdirSync(source);
const git = (cwd, ...argv) => execFileSync('git', ['-C', cwd, ...argv], { encoding: 'utf8' }).trim();
git(source, 'init', '-q');
git(source, 'config', 'user.name', 'Worktree Probe');
git(source, 'config', 'user.email', 'probe@example.invalid');
fs.writeFileSync(path.join(source, 'shared.txt'), 'baseline\n');
git(source, 'add', 'shared.txt');
git(source, 'commit', '-qm', 'probe baseline');
const bindings = {};
for (const id of ['a', 'b']) {
  const cwd = path.join(root, `task-${id}`);
  git(source, 'worktree', 'add', '-b', `probe-${id}`, cwd);
  bindings[id] = { cwd, branch: `probe-${id}` };
}
fs.writeFileSync(path.join(root, 'bindings.json'), JSON.stringify(bindings, null, 2), { mode: 0o600 });
const write = (id) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', `
    const fs=require('node:fs');
    fs.writeFileSync('shared.txt',${JSON.stringify(`task-${id}\n`)});
    fs.writeFileSync('artifact.txt',${JSON.stringify(`deliverable-${id}\n`)});
  `], { cwd: bindings[id].cwd, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`writer ${id}: ${code}`)));
});
await Promise.all(['a', 'b'].map(write));
// A separate process reads persisted bindings, simulating loss of this process's memory.
const recovery = JSON.parse(execFileSync(process.execPath, ['-e', `
  const fs=require('node:fs'),p=require('node:path'),cp=require('node:child_process');
  const bindings=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
  const result={};
  for(const [id,b] of Object.entries(bindings)) result[id]={
    text:fs.readFileSync(p.join(b.cwd,'shared.txt'),'utf8'),
    artifact:fs.readFileSync(p.join(b.cwd,'artifact.txt'),'utf8'),
    branch:cp.execFileSync('git',['-C',b.cwd,'branch','--show-current'],{encoding:'utf8'}).trim(),
    status:cp.execFileSync('git',['-C',b.cwd,'status','--porcelain'],{encoding:'utf8'})
  };
  process.stdout.write(JSON.stringify(result));
`, path.join(root, 'bindings.json')], { encoding: 'utf8' }));
function validateBinding(id, observed) {
  assert.equal(observed.text, `task-${id}\n`);
  assert.equal(observed.artifact, `deliverable-${id}\n`);
  assert.equal(observed.branch, `probe-${id}`);
  assert.match(observed.status, / M shared.txt/);
  assert.match(observed.status, /\?\? artifact.txt/);
}
for (const id of ['a', 'b']) validateBinding(id, recovery[id]);
assert.equal(fs.readFileSync(path.join(source, 'shared.txt'), 'utf8'), 'baseline\n');
assert.equal(git(source, 'status', '--porcelain'), '');
assert.notEqual(bindings.a.cwd, bindings.b.cwd);
// Known-bad binding control: the same check rejects B as A's execution location.
assert.throws(() => validateBinding('a', recovery.b), { code: 'ERR_ASSERTION' });
const badBindingRejected = true;
const evidence = {
  probe: 'local-worktree-cwd', passed: true, tasks: recovery,
  sourceUnchanged: true, freshProcessReadback: true, badBindingRejected,
  limits: ['Not a Multica claim/restart or C4 E2E test', 'Not permission sandbox enforcement', 'No production process was restarted'],
};
fs.writeFileSync(path.join(root, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output: root, ...evidence }, null, 2)}\n`);
