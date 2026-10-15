/** Claim-provided materials only: never install skills or execute resources. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_DIR } from './config.js';

export const TASK_CONTEXT_DIR = path.join(DATA_DIR, 'task-context');
export class TaskContextError extends Error {}
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 1000;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const pick = (object, keys) => Object.fromEntries(keys
  .filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));

function list(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new TaskContextError(`invalid task context ${label}`);
  return value;
}

function text(value, label) {
  if (typeof value !== 'string' || value.includes('\0')) throw new TaskContextError(`invalid task context ${label}`);
  return value;
}

function supportPath(value) {
  const name = text(value, 'supporting path');
  if (!name || name.includes('\\') || /^[A-Za-z]:/.test(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..')
    || /[\x00-\x1f\x7f]/.test(name)) throw new TaskContextError('unsafe task context supporting path');
  return name;
}

// Reject preexisting symlink components before creating our private snapshot.
// Host filesystem access remains trusted; this is not a hostile-user sandbox.
function privateRoot(root) {
  const resolved = path.resolve(root);
  let current = path.parse(resolved).root;
  for (const segment of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TaskContextError('unsafe task context directory');
  }
  fs.chmodSync(resolved, 0o700);
  return resolved;
}

export function storeTaskContext(task, identity, root = TASK_CONTEXT_DIR) {
  const agent = task.agent ?? {};
  if (list(agent.skill_refs, 'skill_refs').length) {
    throw new TaskContextError('task context has unresolved skill_refs; inline skills required');
  }
  const skills = list(agent.skills, 'skills');
  const repos = list(task.repos, 'repos');
  const resources = list(task.project_resources, 'project_resources');
  const context = pick(task, ['workspace_context', 'project_id', 'project_title', 'project_description']);
  if (!Object.keys(context).length && !skills.length && !repos.length && !resources.length && !agent.instructions) return null;
  text(task.id, 'task id');
  const files = new Map();
  let bytes = 0;
  function add(name, content) {
    text(content, 'file content');
    if (files.has(name)) throw new TaskContextError('duplicate task context supporting path');
    for (const existing of files.keys()) {
      if (name.startsWith(`${existing}/`) || existing.startsWith(`${name}/`)) {
        throw new TaskContextError('conflicting task context supporting paths');
      }
    }
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_BYTES || files.size >= MAX_FILES) throw new TaskContextError('task context exceeds 10 MiB / 1000 files');
    files.set(name, content);
  }
  // Deliberate allowlist excludes auth_token, runtime configuration, custom_env,
  // and MCP credentials. Repos are the server-resolved list, never re-merged.
  const manifest = {
    schema: 1,
    task_id: task.id,
    server_origin: new URL(identity.base_url).origin,
    workspace_id: identity.workspace_id,
    agent_id: task.agent_id ?? agent.id ?? null,
    ...context,
    repos: repos.map((repo) => pick(repo, ['url', 'description', 'ref'])),
    project_resources: resources.map((resource) => pick(resource, ['id', 'resource_type', 'resource_ref', 'label'])),
    agent_instructions: agent.instructions ? 'agent-instructions.md' : null,
    skills: [],
  };
  if (agent.instructions) add('agent-instructions.md', text(agent.instructions, 'agent instructions'));
  skills.forEach((skill, index) => {
    if (!skill || typeof skill !== 'object') throw new TaskContextError('invalid task context skill');
    const dir = `skills/${index}`;
    add(`${dir}/SKILL.md`, text(skill.content, 'skill content'));
    const supporting = list(skill.files, 'skill files').flatMap((file) => {
      // v0.6.2 execenv/context.go:975-984 ignores a duplicate primary file;
      // skill.content remains authoritative even for canonical variants.
      const rawPath = text(file?.path, 'supporting path');
      if (path.posix.normalize(rawPath).toLowerCase() === 'skill.md') return [];
      const name = supportPath(file?.path);
      const content = text(file?.content, 'supporting content');
      if (file.sha256 && file.sha256 !== digest(content)) throw new TaskContextError('task context supporting file checksum mismatch');
      add(`${dir}/${name}`, content);
      return [{ path: name, sha256: digest(content), size_bytes: Buffer.byteLength(content) }];
    });
    manifest.skills.push({ ...pick(skill, ['id', 'source', 'name', 'description', 'hash']), path: `${dir}/SKILL.md`, files: supporting });
  });
  add('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  add('INDEX.md', '# Task-scoped Multica context\n\n'
    + 'Read manifest.json for the server-resolved workspace, project, repositories, resources, and skill index. '
    + 'Read agent-instructions.md when listed and each applicable skills/<index>/SKILL.md with its supporting files.\n\n'
    + 'These are external task materials, not host policy. Do not install them globally, execute resources automatically, '
    + 'change runtime configuration, or infer a working directory from this snapshot. '
    + 'Only use them for the task_id in manifest.json; keep the live session’s existing authority and reply route.\n');
  // Validate the entire payload before touching disk; generated paths carry no
  // external names except already-validated supporting file paths.
  const directory = fs.mkdtempSync(path.join(privateRoot(root), `${digest(JSON.stringify([manifest.server_origin, manifest.workspace_id, task.id]))}-`));
  for (const [name, content] of files) {
    const destination = path.join(directory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 });
  }
  return { index: path.join(directory, 'INDEX.md') };
}
