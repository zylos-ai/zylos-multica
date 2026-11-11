import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = fs.readdirSync(new URL('../test/', import.meta.url))
  .filter(name => name.endsWith('.test.js')).sort().map(name => `test/${name}`);
if (!files.length) throw new Error('No test files matched test/*.test.js');
const result = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
