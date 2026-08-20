import fs from 'node:fs';
import path from 'node:path';

import { multicaRequest } from './multica-api.js';
import { loadTaskToken } from './task-tokens.js';
import { ensureWorkspaceResolved } from './workspace.js';

const ISSUE_SORTS = new Set(['position', 'title', 'created_at', 'start_date', 'due_date', 'priority']);
const DIRECTIONAL_SORTS = new Set(['title', 'created_at', 'start_date', 'due_date', 'priority']);
const ISSUE_PRIORITIES = new Set(['urgent', 'high', 'medium', 'low', 'none']);
const ISSUE_STATUS_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/;

function apiPath(segment) {
  return encodeURIComponent(String(segment));
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseInteger(value, name, { min = 0 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function assertOutput(value) {
  const output = value || 'json';
  if (!['json', 'table'].includes(output)) throw new Error('--output must be json or table');
  return output;
}

function parseArgs(argv) {
  const positionals = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (!name) throw new Error('invalid empty flag');
    const next = argv[index + 1];
    const value = next !== undefined && !next.startsWith('--') ? argv[++index] : true;
    const existing = flags.get(name);
    flags.set(name, existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value]);
  }
  return { positionals, flags };
}

function one(flags, name, fallback = undefined) {
  const value = flags.get(name);
  if (Array.isArray(value)) throw new Error(`--${name} may only be set once`);
  return value === undefined ? fallback : value;
}

function many(flags, name) {
  const value = flags.get(name);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function bool(flags, name) {
  const value = one(flags, name);
  if (value === undefined) return false;
  if (value !== true) throw new Error(`--${name} does not take a value`);
  return true;
}

function rejectUnknown(flags, allowed) {
  for (const name of flags.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown option --${name}`);
  }
}

function decodeInlineText(value) {
  return value.replace(/\\([nrt\\])/g, (_match, escaped) => ({ n: '\n', r: '\r', t: '\t', '\\': '\\' })[escaped]);
}

function isInsideDirectory(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function readControlledFile(filePath, allowExternalFile, cwd = process.cwd()) {
  const realBase = fs.realpathSync(cwd);
  const absolute = path.resolve(cwd, filePath);
  const realFile = fs.realpathSync(absolute);
  if (!allowExternalFile && !isInsideDirectory(realBase, realFile)) {
    throw new Error(`file path ${JSON.stringify(filePath)} resolves outside the current working directory; pass --allow-external-file to override`);
  }
  return fs.readFileSync(realFile, 'utf8').replace(/\n$/, '');
}

export function resolveTextInput(flags, name, { stdin = process.stdin, cwd = process.cwd() } = {}) {
  const inline = one(flags, name);
  const stdinFlag = bool(flags, `${name}-stdin`);
  const filePath = one(flags, `${name}-file`);
  const sources = [inline !== undefined, stdinFlag, filePath !== undefined].filter(Boolean).length;
  if (sources > 1) throw new Error(`--${name}, --${name}-stdin, and --${name}-file are mutually exclusive`);
  let value;
  if (stdinFlag) value = fs.readFileSync(stdin.fd, 'utf8').replace(/\n$/, '');
  else if (filePath !== undefined) value = readControlledFile(String(filePath), bool(flags, 'allow-external-file'), cwd);
  else if (inline !== undefined) value = decodeInlineText(String(inline));
  return value === undefined ? { present: false } : { present: true, value };
}

export async function createIssue(config, body, request = multicaRequest) {
  return request(config, 'POST', '/api/issues', body, { workspaceHeader: true });
}

async function resolveIssue(config, reference, request) {
  requireText(reference, 'issue key or UUID');
  const issue = await request(config, 'GET', `/api/issues/${apiPath(reference)}`, undefined, { workspaceHeader: true });
  if (!issue || typeof issue.id !== 'string' || issue.id.trim() === '') {
    throw new Error(`issue lookup for ${JSON.stringify(reference)} returned no canonical id`);
  }
  return issue;
}

async function issueCreate(config, flags, request, io) {
  rejectUnknown(flags, new Set([
    'title', 'description', 'description-stdin', 'description-file', 'allow-external-file',
    'status', 'priority', 'parent', 'project', 'stage', 'start-date', 'due-date',
    'allow-duplicate', 'attachment-id', 'output',
  ]));
  // Output mode is validated before any API call: the create below is
  // non-idempotent, so no argument error may surface after it succeeds.
  const output = assertOutput(one(flags, 'output'));
  const title = requireText(one(flags, 'title'), '--title');
  const description = resolveTextInput(flags, 'description', io);
  const body = { title };
  if (description.present) body.description = description.value;
  for (const [flag, field] of [
    ['project', 'project_id'], ['start-date', 'start_date'], ['due-date', 'due_date'],
  ]) {
    const value = one(flags, flag);
    if (value !== undefined) body[field] = value;
  }
  const status = one(flags, 'status');
  if (status !== undefined) {
    if (!ISSUE_STATUS_PATTERN.test(status.trim().toLowerCase())) throw new Error(`invalid --status ${JSON.stringify(status)}`);
    body.status = status;
  }
  const priority = one(flags, 'priority');
  if (priority !== undefined) {
    if (!ISSUE_PRIORITIES.has(priority)) throw new Error(`invalid --priority ${JSON.stringify(priority)}`);
    body.priority = priority;
  }
  const parent = one(flags, 'parent');
  if (parent !== undefined) body.parent_issue_id = (await resolveIssue(config, parent, request)).id;
  const stage = one(flags, 'stage');
  if (stage !== undefined) body.stage = parseInteger(stage, '--stage', { min: 1 });
  if (bool(flags, 'allow-duplicate')) body.allow_duplicate = true;
  const attachmentIds = many(flags, 'attachment-id').map((value) => requireText(value, '--attachment-id'));
  if (attachmentIds.length) body.attachment_ids = [...new Set(attachmentIds.map((value) => value.trim()))];
  return { result: await createIssue(config, body, request), output };
}

async function issueGet(config, positionals, flags, request) {
  rejectUnknown(flags, new Set(['output']));
  const output = assertOutput(one(flags, 'output'));
  if (positionals.length !== 1) throw new Error('issue get requires exactly one issue key or UUID');
  const result = await resolveIssue(config, positionals[0], request);
  return { result, output };
}

async function issueList(config, flags, request) {
  rejectUnknown(flags, new Set(['status', 'priority', 'project', 'limit', 'offset', 'sort', 'direction', 'output']));
  const output = assertOutput(one(flags, 'output', 'table'));
  const params = new URLSearchParams({ workspace_id: config.workspace_id });
  for (const [flag, field] of [['status', 'status'], ['priority', 'priority'], ['project', 'project_id']]) {
    const value = one(flags, flag);
    if (value !== undefined) params.set(field, requireText(value, `--${flag}`).trim());
  }
  const limit = parseInteger(one(flags, 'limit', '50'), '--limit', { min: 1 });
  const offset = parseInteger(one(flags, 'offset', '0'), '--offset');
  params.set('limit', String(limit));
  if (offset) params.set('offset', String(offset));
  const sort = one(flags, 'sort');
  if (sort !== undefined) {
    if (!ISSUE_SORTS.has(sort)) throw new Error(`invalid --sort ${JSON.stringify(sort)}`);
    params.set('sort', sort);
  }
  const direction = one(flags, 'direction');
  if (direction !== undefined) {
    if (!['asc', 'desc'].includes(direction)) throw new Error('--direction must be asc or desc');
    if (!DIRECTIONAL_SORTS.has(sort)) throw new Error('--direction requires a non-position --sort');
    params.set('direction', direction);
  }
  const result = await request(config, 'GET', `/api/issues?${params}`, undefined, { workspaceHeader: true });
  const issues = Array.isArray(result?.issues) ? result.issues : [];
  const total = Number.isFinite(result?.total) ? result.total : issues.length;
  return {
    result: { issues, total, limit, offset, has_more: offset + issues.length < total },
    output,
  };
}

function validateCommentListFlags(flags) {
  const thread = one(flags, 'thread');
  const recentSet = flags.has('recent');
  const tailSet = flags.has('tail');
  const recent = recentSet ? parseInteger(one(flags, 'recent'), '--recent', { min: 1 }) : undefined;
  const tail = tailSet ? parseInteger(one(flags, 'tail'), '--tail') : undefined;
  const rootsOnly = bool(flags, 'roots-only');
  const before = one(flags, 'before');
  const beforeId = one(flags, 'before-id');
  if (thread !== undefined && recentSet) throw new Error('--thread and --recent are mutually exclusive');
  if (rootsOnly && (thread !== undefined || recentSet || tailSet)) throw new Error('--roots-only cannot be combined with --thread, --recent, or --tail');
  if (tailSet && thread === undefined) throw new Error('--tail requires --thread');
  if ((before === undefined) !== (beforeId === undefined)) throw new Error('--before and --before-id must be set together');
  if (before !== undefined && !recentSet && !(thread !== undefined && tailSet)) {
    throw new Error('--before / --before-id require --recent or --thread + --tail');
  }
  return { thread, recentSet, recent, tailSet, tail, rootsOnly, before, beforeId };
}

async function commentList(config, issueRef, flags, request) {
  rejectUnknown(flags, new Set([
    'since', 'thread', 'tail', 'recent', 'roots-only', 'summary', 'full',
    'before', 'before-id', 'output',
  ]));
  const output = assertOutput(one(flags, 'output', 'table'));
  const parsed = validateCommentListFlags(flags);
  const params = new URLSearchParams();
  const since = one(flags, 'since');
  if (since !== undefined) params.set('since', since);
  if (parsed.rootsOnly) params.set('roots_only', 'true');
  if (bool(flags, 'summary')) params.set('summary', 'true');
  if (!parsed.rootsOnly && since === undefined && !parsed.tailSet && !bool(flags, 'full')) params.set('fold', 'true');
  if (parsed.thread !== undefined) params.set('thread', parsed.thread);
  if (parsed.tailSet) params.set('tail', String(parsed.tail));
  if (parsed.recentSet) params.set('recent', String(parsed.recent));
  if (parsed.before !== undefined) {
    params.set('before', parsed.before);
    params.set('before_id', parsed.beforeId);
  }
  const query = params.size ? `?${params}` : '';
  const issueId = (await resolveIssue(config, issueRef, request)).id;
  const result = await request(config, 'GET', `/api/issues/${apiPath(issueId)}/comments${query}`, undefined, { workspaceHeader: true });
  return { result, output };
}

async function commentAdd(config, issueRef, flags, request, io) {
  rejectUnknown(flags, new Set(['content', 'content-stdin', 'content-file', 'allow-external-file', 'parent', 'output']));
  // Validated before the issue lookup and the non-idempotent comment POST.
  const output = assertOutput(one(flags, 'output'));
  const content = resolveTextInput(flags, 'content', io);
  if (!content.present || content.value === '') throw new Error('--content, --content-stdin, or --content-file is required');
  const body = { content: content.value };
  const parent = one(flags, 'parent');
  if (parent !== undefined) body.parent_id = requireText(parent, '--parent').trim();
  const issueId = (await resolveIssue(config, issueRef, request)).id;
  const result = await request(config, 'POST', `/api/issues/${apiPath(issueId)}/comments`, body, { workspaceHeader: true });
  return { result, output };
}

async function chatHistory(config, flags, request, readTaskToken) {
  rejectUnknown(flags, new Set(['task', 'limit', 'before', 'output']));
  const output = assertOutput(one(flags, 'output'));
  const taskId = requireText(one(flags, 'task'), '--task').trim();
  const taskToken = readTaskToken(taskId);
  const params = new URLSearchParams();
  const limit = one(flags, 'limit');
  if (limit !== undefined) params.set('limit', String(parseInteger(limit, '--limit', { min: 1 })));
  const before = one(flags, 'before');
  if (before !== undefined) params.set('before', requireText(before, '--before'));
  const query = params.size ? `?${params}` : '';
  const result = await request(
    { ...config, pat: taskToken },
    'GET',
    `/api/chat/history${query}`,
    undefined,
    { workspaceHeader: true },
  );
  return { result, output };
}

// Remote fields are terminal-hostile: C0/C1 controls (incl. ESC/OSC) can drive
// the terminal parser, and tabs/newlines can forge table structure. Every key
// and cell is rendered as an inert single-line string with visible escapes.
function encodeTableCell(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, (ch) => {
    if (ch === '\t') return '\\t';
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    return `\\x${ch.codePointAt(0).toString(16).padStart(2, '0')}`;
  });
}

function printTable(value, stdout) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.issues) ? value.issues : Array.isArray(value?.messages) ? value.messages : [value];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    stdout.write(`${Object.entries(row).map(([key, item]) => `${encodeTableCell(key)}=${encodeTableCell(item ?? '')}`).join('\t')}\n`);
  }
}

export async function runBusinessCLI(config, argv, dependencies = {}) {
  const request = dependencies.request ?? multicaRequest;
  const readTaskToken = dependencies.loadTaskToken ?? loadTaskToken;
  const io = {
    stdin: dependencies.stdin ?? process.stdin,
    stdout: dependencies.stdout ?? process.stdout,
    cwd: dependencies.cwd ?? process.cwd(),
  };
  const { positionals, flags } = parseArgs(argv);
  const [group, command, subcommand, ...rest] = positionals;
  // --output is pre-validated before dispatch — including before workspace
  // resolution, which on a slug-only config is itself a network call — so an
  // argument error can never surface after any API call. Commands still apply
  // their own default ('json' or 'table') when the flag is absent.
  if (flags.has('output')) assertOutput(one(flags, 'output'));
  const resolveWorkspace = dependencies.ensureWorkspaceResolved ?? ensureWorkspaceResolved;
  // chat history authenticates with the task-scoped token, not the PAT.
  if (group === 'issue') await resolveWorkspace(config, { request });
  let response;
  if (group === 'issue' && command === 'create' && subcommand === undefined) response = await issueCreate(config, flags, request, io);
  else if (group === 'issue' && command === 'get') response = await issueGet(config, [subcommand, ...rest].filter((value) => value !== undefined), flags, request);
  else if (group === 'issue' && command === 'list' && subcommand === undefined) response = await issueList(config, flags, request);
  else if (group === 'issue' && command === 'comment' && subcommand === 'add') {
    if (rest.length !== 1) throw new Error('issue comment add requires exactly one issue key or UUID');
    response = await commentAdd(config, rest[0], flags, request, io);
  } else if (group === 'issue' && command === 'comment' && subcommand === 'list') {
    if (rest.length !== 1) throw new Error('issue comment list requires exactly one issue key or UUID');
    response = await commentList(config, rest[0], flags, request);
  } else if (group === 'chat' && command === 'history' && subcommand === undefined) response = await chatHistory(config, flags, request, readTaskToken);
  else throw new Error('usage: multica.js issue <create|get|list|comment add|comment list> ... | chat history ...');

  if (response.output === 'table') printTable(response.result, io.stdout);
  else io.stdout.write(`${JSON.stringify(response.result, null, 2)}\n`);
  return response.result;
}
