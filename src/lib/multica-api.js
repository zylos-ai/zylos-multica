const REQUEST_TIMEOUT_MS = 30_000;

function redact(value, secret) {
  return secret ? String(value).split(secret).join('[REDACTED]') : String(value);
}

export async function multicaRequest(config, method, apiPath, body, options = {}) {
  const response = await fetch(new URL(apiPath, `${config.base_url}/`), {
    method,
    headers: {
      Authorization: `Bearer ${config.pat}`,
      'Content-Type': 'application/json',
      ...(options.workspaceHeader ? { 'X-Workspace-Id': config.workspace_id } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const raw = await response.text().catch(() => '');
  if (!response.ok) {
    const detail = redact(raw.slice(0, 300), config.pat);
    const error = new Error(`${method} ${apiPath} -> HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    error.status = response.status;
    throw error;
  }
  if (response.status === 204 || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${method} ${apiPath} returned invalid JSON`);
  }
}

export function reportTask(config, action, taskId, text) {
  const bodies = {
    complete: { output: text },
    progress: { summary: text },
    fail: { error: text },
  };
  if (!Object.hasOwn(bodies, action)) throw new Error(`Unsupported report action: ${action}`);
  return multicaRequest(config, 'POST', `/api/daemon/tasks/${encodeURIComponent(taskId)}/${action}`, bodies[action]);
}
