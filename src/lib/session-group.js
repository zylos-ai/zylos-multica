/** Endpoint identity is self-contained: routing never consults local task state. */
const ID = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATION = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidSessionGroup(value) {
  return typeof value === 'string' && value.length <= 95 && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value);
}

export function parseTaskEndpoint(endpoint, { allowLegacy = false } = {}) {
  if (typeof endpoint !== 'string' || !endpoint || /[\s/\\\0]/.test(endpoint)) throw new Error('invalid task endpoint');
  const parts = endpoint.split('|');
  if (parts.length > 2) throw new Error('invalid task endpoint route');
  let route;
  if (parts.length === 2) {
    const match = /^(issue|chat):(.+)$/.exec(parts[1]);
    if (!match || !UUID.test(match[2])) throw new Error('invalid task endpoint route');
    route = { routeType: match[1], routeId: match[2] };
  }
  const identity = parts[0].split('@');
  if (!ID.test(identity[0])) throw new Error('invalid task id');
  if (identity.length === 1 && allowLegacy) return { taskId: identity[0], ...route };
  if (identity.length !== 2 || !GENERATION.test(identity[1])) {
    throw new Error('Terminal reporting requires task_id@generation from the current task card; legacy tasks need explicit recovery, not an inferred generation');
  }
  return { taskId: identity[0], generation: identity[1], ...route };
}

export function sessionGroupForEndpoint(endpoint) {
  const { routeType, routeId } = parseTaskEndpoint(endpoint, { allowLegacy: true });
  if (!routeType) return ''; // Recognized pre-migration addresses retain the total session.
  const group = `${routeType}-${routeId}`;
  if (!isValidSessionGroup(group)) throw new Error('invalid session group');
  return group;
}

export function buildTaskEndpoint(task, generation = task.execution_generation) {
  // Rendering a previously frozen card must preserve its historical route.
  if (task.execution_endpoint !== undefined) {
    const parsed = parseTaskEndpoint(task.execution_endpoint, { allowLegacy: !generation });
    if (parsed.taskId !== task.id || parsed.generation !== generation) throw new Error('task delivery identity mismatch');
    return task.execution_endpoint;
  }
  const identity = `${task.id}${generation ? `@${generation}` : ''}`;
  const routeType = task.issue_id ? 'issue' : task.chat_session_id ? 'chat' : undefined;
  const routeId = task.issue_id || task.chat_session_id;
  const endpoint = `${identity}${routeType ? `|${routeType}:${routeId}` : ''}`;
  parseTaskEndpoint(endpoint, { allowLegacy: !generation });
  return endpoint;
}
