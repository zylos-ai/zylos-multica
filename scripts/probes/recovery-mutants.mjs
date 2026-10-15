#!/usr/bin/env node
// Semantic negative controls. Copies the source into temporary fixtures; never
// mutates the checkout. No network, platform identity or service required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mutants = [
  ['post-before-pending', [
    ['        save(record); // Must succeed before ANY terminal POST.\n', ''],
    ['    save(record);\n    let response;', '    let response;'],
  ], 'failed pending write'],
  ['ignore-generation', [['record.generation !== generation', 'false']], 'permission denial retains'],
  ['http200-is-success', [["const differences = Object.keys(completeFields).filter(k => (remote.result[k] ?? completeFields[k]) !== (report.payload[k] ?? completeFields[k]));", "const differences = [];"]], 'HTTP 200 completed -> conflict'],
  ['empty-body-start', [['      runtime_id: record.runtime_id, dispatched_at: record.dispatched_at,\n    });', '    });']], 'claims and starts persist'],
  ['skip-replay-claim-check', [['    try { await startRequest(record); }\n    catch {', '    try { /* mutant */ }\n    catch {']], 'initial terminal report revalidates'],
  ['ignore-fail-metadata', [['          // Fail SQL COALESCE preserves old metadata for empty/omitted input.\n          if (report.payload[field] && remote[field] !== report.payload[field]) differences.push(`task.${field}`);', '          /* mutant ignores submitted failed-task metadata */']], 'failed report checks every'],
];
for (const [name, replacements, pattern] of mutants) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-recovery-mutant-'));
  try {
    for (const part of ['src', 'test', 'package.json']) fs.cpSync(path.join(root, part), path.join(dir, part), { recursive: true });
    const file = path.join(dir, 'src/lib/task-state.js');
    let source = fs.readFileSync(file, 'utf8');
    for (const [oldText, newText] of replacements) {
      assert.equal(source.split(oldText).length, 2, `${name}: mutation anchor must occur exactly once`);
      source = source.replace(oldText, newText);
    }
    fs.writeFileSync(file, source);
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, 'test/task-state.test.js'], { cwd: dir, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, `${name}: mutant must fail an assertion, got ${result.status}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout + result.stderr, /AssertionError/, `${name}: syntax/fixture failure is not a semantic negative control`);
    console.log(`REJECTED ${name}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
