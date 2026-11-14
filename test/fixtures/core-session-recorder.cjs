#!/usr/bin/env node
// Only the external model process is replaced. Core's tmux adapter and memory
// reader remain real; READY here is fixture-produced, never hook/auth evidence.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('fixture-1'); process.exit(0); }
if (process.argv.includes('--help')) { console.log('--model --effort'); process.exit(0); }
const root = process.env.ZYLOS_DIR, group = process.env.ZYLOS_SESSION_GROUP;
const read = spawnSync(process.execPath, [path.join(root, '.claude/skills/zylos-memory/scripts/read-work-memory.js'), '--json'], { env: process.env, encoding: 'utf8' });
const record = { group, runId: process.env.ZYLOS_RUN_ID, memoryStatus: read.status, memory: read.stdout, memoryError: read.stderr };
fs.appendFileSync(path.join(root, 'runtime-launches.jsonl'), JSON.stringify(record) + '\n');
const dir = path.join(root, 'activity-monitor/session-groups', group);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'current-session.json'), JSON.stringify({ runId: record.runId, sessionId: `fixture-${record.runId}`, ts: Date.now(), startupControlIds: [] }));
setInterval(() => {}, 1000);
