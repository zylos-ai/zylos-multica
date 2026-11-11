import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError, errorCode, redactSecrets } from '../src/lib/log-redact.js';

test('redacts configured secrets and token-shaped strings', () => {
  const text = 'pat=PAT-VALUE-1 claim=opaque-claim Authorization: Bearer abc.def-ghi, mat_AbC123_x-y mul_Q9/z+= tail';
  assert.equal(redactSecrets(text, ['PAT-VALUE-1', 'opaque-claim', undefined, '']),
    'pat=[REDACTED] claim=[REDACTED] Authorization: Bearer [REDACTED], mat_[REDACTED] mul_[REDACTED] tail');
  assert.equal(redactSecrets('{"Authorization":"Bearer t0k"}'), '{"Authorization":"Bearer [REDACTED]"}');
});

test('very short values are not treated as secrets', () => {
  assert.equal(redactSecrets('a b c', ['a', 'b']), 'a b c');
});

test('child-process argv is removed from the message before truncation', () => {
  const cmd = `node /c4-receive.js --content ${'external card text '.repeat(20)}`;
  const error = Object.assign(new Error(`Command failed: ${cmd}\nboom`), { code: 1, cmd });
  assert.deepEqual(describeError(error), { code: 'EXIT_1', error: 'Command failed: [command omitted]\nboom' });
});

test('secrets are redacted before the 200-character cut', () => {
  const secret = 'S'.repeat(30);
  const { error } = describeError(new Error(`${'x'.repeat(190)}${secret}`), [secret]);
  assert.equal(error, `${'x'.repeat(190)}[REDACTED]`);
  assert.equal(describeError(new Error('y'.repeat(500))).error.length, 200);
});

test('error codes', () => {
  assert.equal(errorCode(Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' })), 'E2BIG');
  assert.equal(errorCode(Object.assign(new Error('x'), { status: 409 })), 'HTTP_409');
  assert.equal(errorCode(Object.assign(new Error('x'), { code: 2 })), 'EXIT_2');
  assert.equal(errorCode(Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM', code: null })), 'SIGNAL_SIGTERM');
  assert.equal(errorCode(new Error('plain')), 'ERROR');
  assert.equal(errorCode(undefined), 'ERROR');
  assert.deepEqual(describeError(Object.assign(new Error('x'), { status: 500 })), { code: 'HTTP_500', status: 500, error: 'x' });
});
