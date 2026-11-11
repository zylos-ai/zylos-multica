/** Log-safe error descriptions: no credentials, no child-process argv. */

const MAX_ERROR_CHARS = 200;

export function redactSecrets(text, secrets = []) {
  let value = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 4) value = value.split(secret).join('[REDACTED]');
  }
  return value
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(mat|mul)_[A-Za-z0-9._~+/=-]+/g, '$1_[REDACTED]');
}

export function errorCode(error) {
  if (typeof error?.code === 'string' && error.code) return error.code.slice(0, 64);
  if (Number.isInteger(error?.status)) return `HTTP_${error.status}`;
  if (Number.isInteger(error?.code)) return `EXIT_${error.code}`;
  if (error?.killed || error?.signal) return `SIGNAL_${error.signal || 'UNKNOWN'}`;
  return 'ERROR';
}

/**
 * Child-process errors carry the full argv in `cmd` and repeat it in the
 * message ("Command failed: node c4-receive.js ... --content <card>"); the
 * card is external content, so it is removed before anything is logged.
 */
export function describeError(error, secrets = []) {
  let message = String(error?.message ?? error ?? 'unknown error');
  if (typeof error?.cmd === 'string' && error.cmd) message = message.split(error.cmd).join('[command omitted]');
  // Redact before truncating so a secret cut at the boundary is never left partially visible.
  message = redactSecrets(message, secrets).slice(0, MAX_ERROR_CHARS);
  return {
    code: errorCode(error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    error: message,
  };
}
