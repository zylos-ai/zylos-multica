import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from './config.js';

export const TASK_TOKEN_DIR = path.join(DATA_DIR, 'task-tokens');

function requireSecret(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireTaskToken(value) {
  const token = requireSecret(value, 'task auth token');
  if (!token.startsWith('mat_')) {
    throw new Error('task auth token must use the task-scoped mat_ form');
  }
  return token;
}

function tokenPath(taskId, tokenDir) {
  const id = requireSecret(taskId, 'task id');
  const digest = crypto.createHash('sha256').update(id).digest('hex');
  return path.join(tokenDir, `${digest}.json`);
}

export function storeTaskToken(taskId, authToken, tokenDir = TASK_TOKEN_DIR) {
  const id = requireSecret(taskId, 'task id');
  const token = requireTaskToken(authToken);
  fs.mkdirSync(tokenDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(tokenDir, 0o700);
  const destination = tokenPath(id, tokenDir);
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ task_id: id, auth_token: token })}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

export function loadTaskToken(taskId, tokenDir = TASK_TOKEN_DIR) {
  const id = requireSecret(taskId, 'task id');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(tokenPath(id, tokenDir), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`no active chat token for task ${id}`);
    }
    throw new Error(`failed to read active chat token for task ${id}`);
  }
  if (parsed?.task_id !== id) {
    throw new Error(`invalid active chat token record for task ${id}`);
  }
  try {
    return requireTaskToken(parsed.auth_token);
  } catch {
    throw new Error(`invalid active chat token record for task ${id}`);
  }
}

export function removeTaskToken(taskId, tokenDir = TASK_TOKEN_DIR) {
  try {
    fs.unlinkSync(tokenPath(taskId, tokenDir));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
