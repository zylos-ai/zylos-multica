import fs from 'node:fs';
import path from 'node:path';
import { encodeIssuePropertyValue, buildIssuePropertyRows, issuePropertyNeedsMembers } from './business-properties.js';

// Contracts: Multica v0.6.2 server/cmd/multica/cmd_*.go.
// Planning validates local input before workspace resolution or mutation.
const enc = (value) => encodeURIComponent(String(value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_STATUSES = ['planned', 'in_progress', 'paused', 'completed', 'cancelled'];
const PROPERTY_TYPES = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'actor', 'multi_actor', 'multi_text', 'multi_url'];
const list = (result, key) => Array.isArray(result) ? result : result?.[key] ?? [];

function match(rows, reference, keys = ['name', 'title', 'slug']) {
  const ref = reference.trim().toLowerCase();
  const ranks = [
    rows.filter((row) => String(row.id).toLowerCase() === ref),
    rows.filter((row) => keys.some((key) => typeof row[key] === 'string' && row[key].toLowerCase() === ref)),
    /^[0-9a-f-]{4,}$/i.test(ref) ? rows.filter((row) => String(row.id).toLowerCase().startsWith(ref)) : [],
    rows.filter((row) => keys.some((key) => typeof row[key] === 'string' && row[key].toLowerCase().includes(ref))),
  ];
  for (const candidates of ranks) {
    if (candidates.length > 1) throw new Error('ambiguous reference; use the full UUID');
    if (candidates.length === 1) return candidates[0];
  }
  throw new Error('reference not found');
}

export function planExtendedCommand(args, flags, h) {
  const { one, many, bool, rejectUnknown, requireText, parseInteger, assertOutput, resolveTextInput, resolveIssue, io, readTaskToken } = h;
  const [group, command, ...tail] = args;
  const value = (name, fallback) => one(flags, name, fallback);
  const text = (name) => requireText(value(name), `--${name}`);
  const exact = (items, count) => {
    if (items.length !== count || items.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`command requires exactly ${count} argument(s)`);
  };
  const allow = (...names) => rejectUnknown(flags, new Set(['output', ...names]));
  const stringFields = (names) => Object.fromEntries(names.filter((name) => flags.has(name)).map((name) => {
    const item = value(name);
    if (typeof item !== 'string') throw new Error(`--${name} requires a value`);
    return [name.replaceAll('-', '_'), item];
  }));
  const enumValue = (item, choices, name) => {
    if (!choices.includes(item)) throw new Error(`invalid ${name}; expected ${choices.join(', ')}`);
    return item;
  };
  const status = (item) => {
    if (typeof item !== 'string' || !/^[a-z0-9][a-z0-9_]{0,31}$/.test(item.trim().toLowerCase())) throw new Error('invalid issue status');
    return item;
  };
  const priority = (item) => enumValue(item, ['urgent', 'high', 'medium', 'low', 'none'], 'priority');
  const suppressRun = () => {
    const start = bool(flags, 'start');
    if (bool(flags, 'no-start') && start) throw new Error('--start and --no-start are mutually exclusive');
    return !start;
  };
  const output = () => assertOutput(value('output'));
  const plan = (execute, workspace = true) => ({ execute, output: output(), workspace });
  const api = (config, request) => (method, endpoint, body) => request(config, method, endpoint, body, { workspaceHeader: true });
  const resolve = async (config, request, kind, ref) => {
    requireText(ref, `${kind} reference`);
    if (UUID.test(ref)) return { id: ref };
    const query = kind === 'workspaces' ? '' : `?workspace_id=${enc(config.workspace_id)}`;
    const data = await api(config, request)('GET', `/api/${kind}${query}`);
    const rows = list(data, kind);
    if (kind !== 'workspaces') return match(rows, ref);
    const normalized = ref.trim().toLowerCase();
    const exact = rows.filter((row) => row.slug?.toLowerCase() === normalized);
    const prefix = normalized.replaceAll('-', '');
    const candidates = exact.length ? exact : /^[0-9a-f]{4,32}$/.test(prefix)
      ? rows.filter((row) => row.id.replaceAll('-', '').toLowerCase().startsWith(prefix)) : [];
    if (candidates.length !== 1) throw new Error(candidates.length ? 'ambiguous workspace reference; use the full UUID' : 'workspace reference not found');
    return candidates[0];
  };
  const actor = async (config, request, ref, kinds = ['member', 'agent', 'squad'], idOnly = false) => {
    if (idOnly && !UUID.test(ref)) throw new Error('actor id must be a UUID');
    const candidates = [];
    for (const kind of kinds) {
      const endpoint = kind === 'member' ? `/api/workspaces/${enc(config.workspace_id)}/members`
        : kind === 'agent' ? `/api/agents?workspace_id=${enc(config.workspace_id)}` : '/api/squads';
      const rows = list(await api(config, request)('GET', endpoint), `${kind}s`);
      candidates.push(...rows.map((row) => ({ ...row, id: row.user_id ?? row.id, name: row.name ?? row.display_name, actor_type: kind })));
    }
    const selected = match(candidates, ref, ['name', 'email']);
    return { type: selected.actor_type, id: selected.id };
  };
  const actorFlags = (name, idName, optional = false) => {
    if (flags.has(name) && flags.has(idName)) throw new Error(`--${name} and --${idName} are mutually exclusive`);
    if (!flags.has(name) && !flags.has(idName)) {
      if (optional) return undefined;
      throw new Error(`--${name} or --${idName} is required`);
    }
    const idOnly = flags.has(idName);
    const ref = text(idOnly ? idName : name);
    if (idOnly && !UUID.test(ref)) throw new Error(`--${idName} must be a UUID`);
    return { ref, idOnly };
  };
  const issuePath = async (config, request, ref) => `/api/issues/${enc((await resolveIssue(config, ref, request)).id)}`;
  const nonempty = (body) => { if (!Object.keys(body).length) throw new Error('no fields to update'); };

  if (group === 'issue' && command === 'wakeup' && ['list', 'get', 'runs'].includes(tail[0])) {
    const [action, ...items] = tail;
    exact(items, action === 'list' ? 1 : 2); allow();
    return plan(async (config, request) => {
      const endpoint = `${await issuePath(config, request, items[0])}/wakeups`;
      if (action === 'runs') return api(config, request)('GET', `${endpoint}/${enc(items[1])}/runs`);
      const rows = await api(config, request)('GET', endpoint);
      if (!Array.isArray(rows)) throw new Error('invalid wakeup list response');
      if (action === 'list') return rows;
      const row = rows.find((item) => item.id === items[1]);
      if (!row) throw new Error('wakeup not found');
      return row;
    });
  }

  if (group === 'issue' && command === 'reorder') {
    exact(tail, 1); allow('before', 'after', 'top', 'bottom');
    const targets = ['before', 'after', 'top', 'bottom'].filter((name) => flags.has(name));
    if (targets.length !== 1) throw new Error('choose exactly one of --before, --after, --top, --bottom');
    const mode = targets[0];
    const reference = ['before', 'after'].includes(mode) ? text(mode) : undefined;
    if (!reference && !bool(flags, mode)) throw new Error(`--${mode} cannot be false`);
    return plan(async (config, request) => {
      const call = api(config, request), endpoint = await issuePath(config, request, tail[0]);
      const target = await call('GET', endpoint);
      if (!target?.status) throw new Error('issue has no status; cannot determine column');
      const other = reference ? await resolveIssue(config, reference, request) : undefined;
      if (other?.id === target.id) throw new Error('cannot reorder an issue relative to itself');
      const rows = [], seen = new Set();
      for (let offset = 0; ;) {
        const query = new URLSearchParams({ workspace_id: config.workspace_id, status: target.status, sort: 'position', limit: '100', offset: String(offset) });
        if (target.project_id) query.set('project_id', target.project_id);
        const page = await call('GET', `/api/issues?${query}`);
        if (!Array.isArray(page?.issues)) throw new Error('invalid issue column response');
        for (const row of page.issues) {
          if (!row?.id || seen.has(row.id)) throw new Error('invalid or repeated issue in column; read again before reorder');
          if (!Number.isFinite(row.position)) throw new Error('invalid issue position');
          seen.add(row.id); rows.push(row);
        }
        offset += page.issues.length;
        if (!page.issues.length || typeof page.total === 'number' && page.total > page.issues.length && offset >= page.total) break;
      }
      if (!seen.has(target.id)) throw new Error('issue moved out of column; read again before reorder');
      const ordered = rows.filter((row) => row.id !== target.id);
      let index = mode === 'bottom' ? ordered.length : 0;
      if (other) {
        index = ordered.findIndex((row) => row.id === other.id);
        if (index < 0) throw new Error('relative issue is not in the same status/project column');
        if (mode === 'after') index++;
      }
      if (!ordered.length) return target;
      const position = index === 0 ? ordered[0].position - 1 : index === ordered.length ? ordered.at(-1).position + 1
        : (ordered[index - 1].position + ordered[index].position) / 2;
      if (!Number.isFinite(position) || index > 0 && position <= ordered[index - 1].position || index < ordered.length && position >= ordered[index].position) throw new Error('column positions exhausted; refresh board before reordering');
      if (position === target.position) return target;
      return call('PUT', endpoint, { position, suppress_run: true });
    });
  }

  if (group === 'attachment' && command === 'upload') {
    exact(tail, 1); allow('task', 'allow-external-file');
    const taskId = text('task'), token = readTaskToken(taskId);
    const root = fs.realpathSync(io.cwd), file = fs.realpathSync(path.resolve(io.cwd, tail[0]));
    const relative = path.relative(root, file);
    if (!bool(flags, 'allow-external-file') && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error('file resolves outside the current working directory');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error('attachment must be a regular file <= 100 MiB');
    const bytes = fs.readFileSync(file);
    return plan(async (config, request) => {
      const form = new FormData();
      form.append('file', new Blob([bytes]), path.basename(file));
      form.append('task_id', taskId);
      const result = await request({ ...config, pat: token }, 'POST', '/api/upload-file', undefined, { workspaceHeader: true, multipart: form, timeoutMs: 60_000 });
      if (!result?.id) throw new Error('upload response missing attachment id; inspect task attachments before retrying');
      const filename = path.basename(file), label = filename.replace(/[\\[\]()]/g, '\\$&');
      const prefix = result.content_type?.startsWith('image/') ? '!' : '!file';
      return { id: result.id, filename, markdown_url: result.markdown_url, markdown: `${prefix}[${label}](${result.markdown_url})` };
    });
  }

  if (group === 'issue' && ['timeline', 'history'].includes(command)) {
    exact(tail, 1); allow('activity-only', 'action', 'since', 'tail', 'full-id');
    const actions = many(flags, 'action').flatMap((item) => requireText(item, '--action').split(',')).map((item) => item.trim()).filter(Boolean);
    const activityOnly = bool(flags, 'activity-only') || actions.length > 0;
    if (flags.has('full-id')) bool(flags, 'full-id');
    const last = parseInteger(value('tail', 0), '--tail');
    const since = flags.has('since') ? Date.parse(text('since')) : undefined;
    if (since !== undefined && (!Number.isFinite(since) || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(text('since')))) throw new Error('--since must be RFC3339');
    return plan(async (config, request) => {
      const endpoint = `${await issuePath(config, request, tail[0])}/timeline`;
      const result = await request(config, 'GET', endpoint, undefined, { workspaceHeader: true, includeHeaders: true });
      const truncated = Object.entries(result.headers ?? {}).find(([key]) => key.toLowerCase() === 'x-timeline-truncated')?.[1];
      if (truncated) io.stderr.write('warning: timeline truncated by server cap; older entries are missing. Durations and first transitions cannot be concluded from this read.\n');
      let rows = (result.data ?? []).filter((row) => (!activityOnly || row.type === 'activity') && (!actions.length || actions.includes(row.action)) && (since === undefined || Date.parse(row.created_at) > since));
      if (last) rows = rows.slice(-last);
      return rows;
    });
  }

  if (group === 'issue' && ['update', 'status', 'assign'].includes(command)) {
    exact(tail, command === 'status' ? 2 : 1);
    const fields = ['title', 'priority', 'status', 'project', 'start-date', 'due-date', 'stage', 'position', 'parent', 'duplicate-of'];
    allow(...(command === 'update' ? [...fields, 'description', 'description-stdin', 'description-file', 'allow-external-file', 'assignee', 'assignee-id']
      : command === 'assign' ? ['to', 'to-id', 'unassign'] : ['duplicate-of']), 'start', 'no-start');
    const suppress = suppressRun();
    const body = command === 'update' ? stringFields(['title', 'priority', 'status', 'start-date', 'due-date']) : {};
    if (command === 'status') body.status = status(tail[1]);
    if (body.status !== undefined) status(body.status);
    if (body.priority !== undefined) priority(body.priority);
    if (command === 'update') {
      const description = resolveTextInput(flags, 'description', io);
      if (description.present) body.description = description.value;
      if (flags.has('stage')) body.stage = parseInteger(value('stage'), '--stage', { min: 1 });
      if (flags.has('position')) {
        body.position = Number(text('position'));
        if (!Number.isFinite(body.position)) throw new Error('--position must be finite');
      }
    }
    const duplicate = flags.has('duplicate-of') ? text('duplicate-of') : undefined;
    if (duplicate && (body.status !== undefined && body.status !== 'cancelled' || body.description !== undefined)) throw new Error('--duplicate-of requires --status cancelled and cannot change description');
    if (duplicate) body.status = 'cancelled';
    const unassign = command === 'assign' && bool(flags, 'unassign');
    const target = command === 'assign' ? actorFlags('to', 'to-id', unassign)
      : command === 'update' ? actorFlags('assignee', 'assignee-id', true) : undefined;
    if (unassign && target) throw new Error('--unassign and --to/--to-id are mutually exclusive');
    if (unassign && flags.has('no-start')) throw new Error('--no-start cannot be used with --unassign');
    if (command === 'update' && !Object.keys(body).length && !['project', 'parent'].some((key) => flags.has(key)) && !target) throw new Error('no fields to update');
    // Parse optional references before the first request, including bare flags.
    const refs = stringFields(['project', 'parent']);
    return plan(async (config, request) => {
      const endpoint = await issuePath(config, request, tail[0]);
      const payload = { ...body, suppress_run: suppress };
      if ('project' in refs) payload.project_id = refs.project ? (await resolve(config, request, 'projects', refs.project)).id : null;
      if ('parent' in refs) payload.parent_issue_id = refs.parent ? (await resolveIssue(config, refs.parent, request)).id : null;
      if (duplicate) payload.duplicate_of_issue_id = (await resolveIssue(config, duplicate, request)).id;
      if (unassign) Object.assign(payload, { assignee_type: null, assignee_id: null });
      else if (target) {
        const selected = await actor(config, request, target.ref, undefined, target.idOnly);
        Object.assign(payload, { assignee_type: selected.type, assignee_id: selected.id });
      }
      const result = await api(config, request)('PUT', endpoint, payload);
      if (duplicate && !Object.hasOwn(result ?? {}, 'duplicate_of')) throw new Error('write returned without the expected duplicate link; inspect issue before retrying');
      return result;
    });
  }

  if (group === 'issue' && ['children', 'pull-requests', 'usage', 'runs'].includes(command)) {
    exact(tail, 1);
    allow(...(command === 'runs' ? ['active', 'siblings', 'full-id'] : []));
    const active = command === 'runs' && bool(flags, 'active');
    const siblings = command === 'runs' && bool(flags, 'siblings');
    if (flags.has('full-id')) bool(flags, 'full-id');
    return plan(async (config, request) => {
      const endpoint = await issuePath(config, request, tail[0]);
      const suffix = command === 'runs' ? 'task-runs' : command;
      const query = new URLSearchParams();
      if (active || siblings) query.set('active', 'true');
      if (siblings) query.set('scope', 'family');
      return api(config, request)('GET', `${endpoint}/${suffix}${query.size ? `?${query}` : ''}`);
    });
  }
  if (group === 'issue' && command === 'search') {
    exact(tail, 1); allow('limit', 'include-closed');
    const limit = parseInteger(value('limit', 20), '--limit', { min: 1 });
    const includeClosed = bool(flags, 'include-closed');
    return plan((config, request) => api(config, request)('GET', `/api/issues/search?${new URLSearchParams({ q: tail[0], workspace_id: config.workspace_id, limit: String(limit), ...(includeClosed ? { include_closed: 'true' } : {}) })}`));
  }
  if (group === 'issue' && ['run-messages', 'cancel-task', 'rerun'].includes(command)) {
    exact(tail, 1); allow(...(command === 'run-messages' ? ['since'] : []));
    // The official CLI also resolves short run ids; full UUIDs avoid accidental cross-issue resolution.
    if (command !== 'rerun' && !UUID.test(tail[0])) throw new Error('run command requires a full run UUID');
    const since = command === 'run-messages' ? parseInteger(value('since', 0), '--since') : 0;
    return plan(async (config, request) => {
      if (command === 'rerun') return api(config, request)('POST', `${await issuePath(config, request, tail[0])}/rerun`, {});
      const endpoint = `/api/tasks/${enc(tail[0])}`;
      return command === 'cancel-task' ? api(config, request)('POST', `${endpoint}/cancel`, {}) : api(config, request)('GET', `${endpoint}/messages${since ? `?since=${since}` : ''}`);
    });
  }
  if (group === 'issue' && command === 'label') {
    const [action, ...items] = tail;
    if (!['list', 'add', 'remove'].includes(action)) return null;
    exact(items, action === 'list' ? 1 : 2); allow('full-id');
    if (flags.has('full-id')) bool(flags, 'full-id');
    return plan(async (config, request) => {
      const endpoint = `${await issuePath(config, request, items[0])}/labels`;
      if (action === 'list') return list(await api(config, request)('GET', endpoint), 'labels');
      const label = await resolve(config, request, 'labels', items[1]);
      if (action === 'add') return list(await api(config, request)('POST', endpoint, { label_id: label.id }), 'labels');
      await api(config, request)('DELETE', `${endpoint}/${enc(label.id)}`);
      return list(await api(config, request)('GET', endpoint), 'labels');
    });
  }
  if (group === 'issue' && command === 'subscriber') {
    const [action, ...items] = tail;
    if (!['list', 'add', 'remove'].includes(action)) return null;
    exact(items, 1); allow(...(action === 'list' ? [] : ['user', 'user-id']));
    const target = action === 'list' ? undefined : actorFlags('user', 'user-id', true);
    return plan(async (config, request) => {
      const endpoint = await issuePath(config, request, items[0]);
      if (action === 'list') return api(config, request)('GET', `${endpoint}/subscribers`);
      const selected = target ? await actor(config, request, target.ref, ['member', 'agent'], target.idOnly) : undefined;
      return api(config, request)('POST', `${endpoint}/${action === 'add' ? 'subscribe' : 'unsubscribe'}`, selected ? { user_type: selected.type, user_id: selected.id } : {});
    });
  }
  if (group === 'issue' && command === 'metadata') {
    const [action, ...items] = tail;
    if (!['list', 'get', 'set', 'delete'].includes(action)) return null;
    exact(items, 1); allow(...(action === 'list' ? [] : action === 'set' ? ['key', 'value', 'type'] : ['key']));
    const key = action !== 'list' ? text('key') : undefined;
    if (key && !/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(key)) throw new Error('invalid metadata key');
    let parsed;
    if (action === 'set') {
      if (typeof value('value') !== 'string') throw new Error('--value is required');
      const raw = value('value');
      const type = enumValue(value('type', ''), ['', 'string', 'number', 'bool'], '--type');
      if (type === 'string') parsed = raw;
      else if (type === 'number') { parsed = Number(raw); if (!raw.trim() || !Number.isFinite(parsed)) throw new Error('invalid number'); }
      else if (type === 'bool') { enumValue(raw, ['true', 'false'], '--value'); parsed = raw === 'true'; }
      else { try { parsed = JSON.parse(raw); } catch { parsed = raw; } if (parsed === null || typeof parsed === 'object') parsed = raw; }
    }
    return plan(async (config, request) => {
      const endpoint = `${await issuePath(config, request, items[0])}/metadata`;
      if (action === 'set') return api(config, request)('PUT', `${endpoint}/${enc(key)}`, { value: parsed });
      if (action === 'delete') return api(config, request)('DELETE', `${endpoint}/${enc(key)}`);
      let result;
      try { result = await api(config, request)('GET', endpoint); }
      catch (error) { if (action === 'list' && error.status === 404) return {}; throw error; }
      const metadata = result?.metadata ?? {};
      if (action === 'list') return metadata;
      if (!Object.hasOwn(metadata, key)) throw new Error('metadata key not found');
      return metadata[key];
    });
  }
  if (group === 'issue' && command === 'comment' && ['update', 'delete', 'resolve', 'unresolve'].includes(tail[0])) {
    const [action, ...items] = tail; exact(items, 1);
    allow(...(action === 'update' ? ['content', 'content-stdin', 'content-file', 'allow-external-file', 'expected-revision'] : []));
    let body;
    if (action === 'update') {
      const content = resolveTextInput(flags, 'content', io);
      if (!content.present) throw new Error('--content is required');
      body = { content: content.value, expected_revision: parseInteger(value('expected-revision'), '--expected-revision', { min: 1 }) };
    }
    return plan(async (config, request) => {
      const endpoint = `/api/comments/${enc(items[0])}`;
      return api(config, request)(action === 'update' ? 'PUT' : action === 'resolve' ? 'POST' : 'DELETE', `${endpoint}${action === 'delete' ? '/keep-replies' : action === 'update' ? '' : '/resolve'}`, body);
    });
  }

  if (group === 'chat' && command === 'thread') {
    if (tail.length > 1) throw new Error('chat thread accepts at most one id');
    allow('task', 'limit', 'before');
    const token = readTaskToken(text('task'));
    const query = new URLSearchParams();
    if (tail.length) query.set('id', tail[0]);
    if (flags.has('limit')) query.set('limit', String(parseInteger(value('limit'), '--limit', { min: 1 })));
    if (flags.has('before')) query.set('before', text('before'));
    return plan((config, request) => api({ ...config, pat: token }, request)('GET', `/api/chat/thread${query.size ? `?${query}` : ''}`));
  }

  if (group === 'project' && command === 'resource') {
    const [action, ...items] = tail;
    if (!['list', 'add', 'update', 'remove'].includes(action)) return null;
    exact(items, ['update', 'remove'].includes(action) ? 2 : 1);
    allow(...(['list', 'remove'].includes(action) ? ['full-id'] : [...(action === 'add' ? ['type'] : []), 'url', 'default-branch-hint', 'local-path', 'daemon-id', 'ref-label', 'execution-mode', 'ref', 'label', 'clear-label', 'position']));
    const body = stringFields(['label']);
    if (flags.has('full-id')) bool(flags, 'full-id');
    if (bool(flags, 'clear-label')) { if (flags.has('label')) throw new Error('--label and --clear-label conflict'); body.label = null; }
    if (flags.has('position')) body.position = parseInteger(value('position'), '--position');
    const resourceType = value('type', 'github_repo');
    if (action === 'add') body.resource_type = requireText(resourceType, '--type');
    const ref = stringFields(['url', 'default-branch-hint', 'local-path', 'daemon-id', 'ref-label', 'execution-mode']);
    if (ref.ref_label !== undefined) { ref.label = ref.ref_label; delete ref.ref_label; }
    for (const key of Object.keys(ref)) ref[key] = ref[key].trim();
    for (const key of ['url', 'local_path', 'daemon_id']) if (key in ref && !ref[key]) throw new Error(`--${key.replaceAll('_', '-')} cannot be empty`);
    if (ref.execution_mode) enumValue(ref.execution_mode, ['in_place', 'worktree'], '--execution-mode');
    let rawRef;
    if (flags.has('ref')) {
      const raw = value('ref');
      if (typeof raw !== 'string') throw new Error('--ref requires a value');
      if (raw.trim().startsWith('{')) { rawRef = JSON.parse(raw); if (!rawRef || Array.isArray(rawRef)) throw new Error('--ref must be an object'); }
      else { if (action === 'add' && resourceType !== 'github_repo') throw new Error('non-JSON --ref is only supported for github_repo'); ref.ref = raw.trim(); }
    }
    if (action === 'add' && !rawRef && (resourceType === 'github_repo' ? !ref.url : resourceType === 'local_directory' ? !ref.local_path || !ref.daemon_id : true)) throw new Error('resource requires a complete --ref or required type shortcuts');
    if (action === 'update' && !Object.keys(body).length && !Object.keys(ref).length && !rawRef) throw new Error('no fields to update');
    return plan(async (config, request) => {
      const endpoint = `/api/projects/${enc((await resolve(config, request, 'projects', items[0])).id)}/resources`;
      if (action === 'list') return list(await api(config, request)('GET', endpoint), 'resources');
      let resource;
      if (items[1]) resource = match(list(await api(config, request)('GET', endpoint), 'resources'), items[1], ['label']);
      if (action === 'remove') return api(config, request)('DELETE', `${endpoint}/${enc(resource.id)}`);
      const payload = { ...body };
      if (rawRef) payload.resource_ref = rawRef;
      else if (Object.keys(ref).length) {
        const type = resource?.resource_type ?? resourceType;
        const allowed = type === 'github_repo' ? ['url', 'default_branch_hint', 'ref'] : type === 'local_directory' ? ['local_path', 'daemon_id', 'label', 'execution_mode'] : [];
        if (Object.keys(ref).some((key) => !allowed.includes(key))) throw new Error('resource shortcuts do not match resource type; use a complete JSON --ref');
        const merged = { ...(resource?.resource_ref ?? {}), ...ref };
        for (const key of ['default_branch_hint', 'ref', 'label', 'execution_mode']) if (merged[key] === '') delete merged[key];
        if (type === 'github_repo' && !merged.url || type === 'local_directory' && (!merged.local_path || !merged.daemon_id)) throw new Error('resource reference is missing required fields');
        payload.resource_ref = merged;
      }
      return api(config, request)(action === 'add' ? 'POST' : 'PUT', `${endpoint}${resource ? `/${enc(resource.id)}` : ''}`, payload);
    });
  }

  if (['project', 'label'].includes(group) && ['list', 'get', 'create', 'update', 'delete', 'status'].includes(command)) {
    if (group === 'label' && command === 'status') return null;
    exact(tail, ['list', 'create'].includes(command) ? 0 : command === 'status' ? 2 : 1);
    const fields = group === 'project' ? ['title', 'description', 'status', 'icon', 'lead', 'start-date', 'due-date'] : ['name', 'color', 'description'];
    allow(...(command === 'list' ? ['full-id', group === 'project' ? 'status' : 'resource-type'] : ['get', 'delete', 'status'].includes(command) ? [] : [...fields, ...(group === 'project' && command === 'create' ? ['repo'] : group === 'label' && command === 'create' ? ['resource-type'] : [])]));
    if (flags.has('full-id')) bool(flags, 'full-id');
    const body = stringFields(fields.filter((name) => name !== 'lead'));
    if (command === 'create') { text(group === 'project' ? 'title' : 'name'); if (group === 'label') text('color'); }
    if (command === 'status') body.status = enumValue(tail[1], PROJECT_STATUSES, 'status');
    if (group === 'project' && body.status !== undefined) enumValue(body.status, PROJECT_STATUSES, 'status');
    if (group === 'label' && flags.has('resource-type')) enumValue(text('resource-type'), ['issue', 'skill'], '--resource-type');
    if (group === 'label' && command === 'create') body.resource_type = value('resource-type', 'issue');
    if (body.color !== undefined && !/^#[0-9a-f]{6}$/i.test(body.color)) throw new Error('--color must be #rrggbb');
    const lead = flags.has('lead') ? text('lead') : undefined;
    const repos = many(flags, 'repo').map((item) => requireText(item, '--repo'));
    if (command === 'update' && !lead) nonempty(body);
    return plan(async (config, request) => {
      const kind = `${group}s`, endpoint = `/api/${kind}`;
      if (command === 'list') {
        const query = new URLSearchParams({ workspace_id: config.workspace_id });
        for (const flag of ['status', 'resource-type']) if (flags.has(flag)) query.set(flag.replaceAll('-', '_'), value(flag));
        return list(await api(config, request)('GET', `${endpoint}?${query}`), kind);
      }
      const payload = { ...body };
      if (lead) { const selected = await actor(config, request, lead, ['member', 'agent']); payload.lead_type = selected.type; payload.lead_id = selected.id; }
      if (repos.length) payload.resources = repos.map((url) => ({ resource_type: 'github_repo', resource_ref: { url } }));
      if (command === 'create') return api(config, request)('POST', endpoint, payload);
      const id = (await resolve(config, request, kind, tail[0])).id;
      return api(config, request)(command === 'get' ? 'GET' : command === 'delete' ? 'DELETE' : 'PUT', `${endpoint}/${enc(id)}`, ['get', 'delete'].includes(command) ? undefined : payload);
    });
  }

  const propertyRef = async (config, request, reference) => match(list(await api(config, request)('GET', '/api/properties?include_archived=true'), 'properties'), reference, ['name']);
  const options = (raw, previous = []) => raw.map((item) => {
    requireText(item, '--option');
    const split = item.lastIndexOf(':#');
    const name = (split > 0 ? item.slice(0, split) : item).trim();
    const color = split > 0 ? item.slice(split + 1) : '#6b7280';
    if (!name || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('invalid property option');
    const old = previous.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    return { name, color, ...(old ? { id: old.id } : {}) };
  });
  if (group === 'property' && ['list', 'get', 'create', 'update', 'archive', 'unarchive'].includes(command)) {
    exact(tail, ['list', 'create'].includes(command) ? 0 : 1);
    allow(...(command === 'list' ? ['include-archived'] : ['create', 'update'].includes(command) ? ['name', 'description', 'icon', 'option', ...(command === 'create' ? ['type'] : [])] : []));
    const body = stringFields(['name', 'description', 'icon', 'type']);
    if (command === 'create') { text('name'); enumValue(text('type'), PROPERTY_TYPES, '--type'); }
    const rawOptions = many(flags, 'option');
    options(rawOptions);
    if (rawOptions.length && command === 'create' && !['select', 'multi_select'].includes(body.type)) throw new Error('--option requires select or multi_select');
    if (command === 'update' && !rawOptions.length) nonempty(body);
    const archived = command === 'list' && bool(flags, 'include-archived');
    return plan(async (config, request) => {
      if (command === 'list') return list(await api(config, request)('GET', `/api/properties${archived ? '?include_archived=true' : ''}`), 'properties');
      if (command === 'create') return api(config, request)('POST', '/api/properties', { ...body, ...(rawOptions.length ? { config: { options: options(rawOptions) } } : {}) });
      const property = await propertyRef(config, request, tail[0]);
      if (command === 'get') return property;
      if (['archive', 'unarchive'].includes(command)) return api(config, request)('PATCH', `/api/properties/${enc(property.id)}`, { archived: command === 'archive' });
      if (rawOptions.length && !['select', 'multi_select'].includes(property.type)) throw new Error('--option requires select or multi_select');
      return api(config, request)('PATCH', `/api/properties/${enc(property.id)}`, { ...body, ...(rawOptions.length ? { config: { options: options(rawOptions, property.config?.options) } } : {}) });
    });
  }
  if (group === 'issue' && command === 'property') {
    const [action, ...items] = tail;
    if (!['list', 'set', 'unset'].includes(action)) return null;
    exact(items, 1); allow(...(action === 'list' ? [] : action === 'set' ? ['name', 'value'] : ['name']));
    const name = action !== 'list' ? text('name') : undefined;
    const raw = action === 'set' ? value('value') : undefined;
    if (action === 'set' && typeof raw !== 'string') throw new Error('--value is required');
    return plan(async (config, request) => {
      const endpoint = await issuePath(config, request, items[0]);
      const catalog = list(await api(config, request)('GET', '/api/properties?include_archived=true'), 'properties');
      const render = async (bag = {}) => {
        const names = {};
        if (issuePropertyNeedsMembers(catalog, bag)) {
          try {
            const members = list(await api(config, request)('GET', `/api/workspaces/${enc(config.workspace_id)}/members`), 'members');
            for (const member of members) if (member.name) names[`member:${member.user_id}`] = member.name;
          } catch { /* Display lookup must not turn an acknowledged write into a retry. */ }
        }
        return buildIssuePropertyRows(catalog, bag, names);
      };
      if (action === 'list') return render((await api(config, request)('GET', endpoint)).properties);
      const property = match(catalog, name, ['name']);
      const target = `${endpoint}/properties/${enc(property.id)}`;
      if (action === 'unset') { await api(config, request)('DELETE', target); return { deleted: true }; }
      const parsed = await encodeIssuePropertyValue(property, raw, async (ref) => `member:${(await actor(config, request, ref, ['member'])).id}`);
      return render((await api(config, request)('PUT', target, { value: parsed }))?.properties);
    });
  }

  if (['agent', 'squad'].includes(group)) {
    const nested = command === 'member' || command === 'skills';
    const action = nested ? tail[0] : command;
    const items = nested ? tail.slice(1) : tail;
    if (!(action === 'list' || (!nested && ['get', 'tasks'].includes(action))) || group === 'squad' && command === 'tasks') return null;
    if (nested && !((group === 'squad' && command === 'member') || (group === 'agent' && command === 'skills'))) return null;
    exact(items, action === 'list' && !nested ? 0 : 1);
    allow(...(!nested && action === 'list' ? ['include-archived', 'full-id'] : action === 'tasks' ? ['limit', 'before', 'full-id'] : []));
    if (flags.has('full-id')) bool(flags, 'full-id');
    const archived = bool(flags, 'include-archived');
    const query = new URLSearchParams();
    if (action === 'tasks') {
      query.set('limit', String(parseInteger(value('limit', 50), '--limit', { min: 1 })));
      if (flags.has('before')) query.set('before', text('before'));
      if (output() === 'json') query.set('include_usage', 'true');
    }
    return plan(async (config, request) => {
      if (action === 'list' && !nested) {
        if (group === 'agent') query.set('workspace_id', config.workspace_id);
        if (archived) query.set('include_archived', 'true');
      }
      const endpoint = `/api/${group}s${items.length ? `/${enc(items[0])}` : ''}${nested ? `/${command === 'member' ? 'members' : 'skills'}` : action === 'tasks' ? '/tasks' : ''}`;
      if (action === 'tasks') {
        const result = await request(config, 'GET', `${endpoint}?${query}`, undefined, { workspaceHeader: true, includeHeaders: true });
        const cursor = Object.entries(result.headers ?? {}).find(([key]) => key.toLowerCase() === 'x-agent-tasks-next-cursor')?.[1];
        if (cursor) io.stderr.write(`More runs available; use --before ${JSON.stringify(cursor)} to fetch the next page.\n`);
        return result.data;
      }
      return api(config, request)('GET', `${endpoint}${query.size ? `?${query}` : ''}`);
    });
  }
  if (group === 'workspace') {
    const nested = command === 'member';
    const action = nested ? tail[0] : command;
    const items = nested ? tail.slice(1) : tail;
    if (!['list', 'get', 'create', 'update', 'invite'].includes(action) || action === 'invite' && !nested || nested && !['list', 'invite'].includes(action)) return null;
    const required = action === 'invite' ? 1 : 0;
    if (items.length < required || items.length > required + (['get', 'update', 'invite'].includes(action) || nested ? 1 : 0)) throw new Error('invalid workspace arguments');
    allow(...(action === 'list' ? ['full-id'] : action === 'invite' ? ['role'] : ['create', 'update'].includes(action) ? ['name', ...(action === 'create' ? ['slug'] : []), 'description', 'description-stdin', 'context', 'context-stdin', 'issue-prefix'] : []));
    if (flags.has('full-id')) bool(flags, 'full-id');
    if (bool(flags, 'description-stdin') && bool(flags, 'context-stdin')) throw new Error('one stdin cannot feed both description and context');
    const body = stringFields(['name', 'slug', 'issue-prefix']);
    for (const field of ['description', 'context']) { const input = resolveTextInput(flags, field, io); if (input.present) body[field] = input.value; }
    if (action === 'create') { text('name'); text('slug'); }
    if (action === 'update') nonempty(body);
    if (body.issue_prefix !== undefined) requireText(body.issue_prefix, '--issue-prefix');
    const role = action === 'invite' ? enumValue(requireText(value('role', 'member'), '--role').trim().toLowerCase(), ['member', 'admin'], '--role') : undefined;
    return plan(async (config, request) => {
      if (action === 'list' && !nested) return api(config, request)('GET', '/api/workspaces');
      if (action === 'create') return api(config, request)('POST', '/api/workspaces', body);
      const reference = items[action === 'invite' ? 1 : 0] ?? config.workspace_id;
      const id = (await resolve(config, request, 'workspaces', reference)).id;
      const endpoint = `/api/workspaces/${enc(id)}`;
      if (nested) return api(config, request)(action === 'invite' ? 'POST' : 'GET', `${endpoint}/members`, action === 'invite' ? { email: items[0].trim().toLowerCase(), role } : undefined);
      return api(config, request)(action === 'update' ? 'PATCH' : 'GET', endpoint, action === 'update' ? body : undefined);
    }, nested || !['list', 'create'].includes(action));
  }
  return null;
}
