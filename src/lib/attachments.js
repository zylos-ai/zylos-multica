import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const DOWNLOAD_ROOT = path.join(DATA_DIR, 'task-downloads');
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export function taskDownloadDirectory(taskId, root = DOWNLOAD_ROOT) {
  return path.join(root, crypto.createHash('sha256').update(taskId).digest('hex'));
}

// Check every existing ancestor, not just the final directory: a symlinked
// parent would otherwise bypass a lexical containment check.
function secureDirectory(directory) {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try { fs.mkdirSync(current, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('download directory must not contain symlinks or non-directories');
  }
  return absolute;
}

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function taskAttachments(task, issue) {
  return [...(Array.isArray(task.chat_message_attachments) ? task.chat_message_attachments : []),
    ...(Array.isArray(issue?.attachments) ? issue.attachments : [])]
    .filter((item) => item && typeof item.id === 'string' && item.id.trim());
}

export function storeTaskAttachments(task, issue, root = DOWNLOAD_ROOT) {
  const attachments = taskAttachments(task, issue);
  if (!attachments.length) return;
  const directory = secureDirectory(taskDownloadDirectory(task.id, root));
  const destination = path.join(directory, 'attachments.json');
  const content = JSON.stringify({ task_id: task.id, workspace_id: task.workspace_id, attachment_ids: [...new Set(attachments.map((item) => item.id))] });
  // Exclusive creation prevents a forged symlink from being followed. Replayed
  // claims may reuse an identical manifest, but cannot expand its authority.
  try { fs.writeFileSync(destination, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { if (fs.readFileSync(fd, 'utf8') !== content) throw new Error('task attachment manifest changed; inspect task before retrying'); }
    finally { fs.closeSync(fd); }
  }
}

function checkedURL(value, base) {
  if (typeof value !== 'string' || !value || /[\\\u0000-\u0020]/u.test(value) || value.startsWith('//')) throw new Error('invalid attachment download URL');
  const url = new URL(value, base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('unsupported attachment download URL');
  return url;
}

// Explicit opt-in only: callers supply a claimed attachment ID, never a URL.
export async function downloadAttachment(config, { taskId, attachmentId, taskToken, outputDir }, dependencies = {}) {
  const root = dependencies.downloadRoot ?? DOWNLOAD_ROOT;
  const directory = taskDownloadDirectory(taskId, root);
  const destinationDir = outputDir === undefined ? path.join(directory, 'files') : path.resolve(directory, outputDir);
  if (!inside(directory, destinationDir)) throw new Error('--output-dir must stay inside this task download directory');
  secureDirectory(directory);
  let manifest;
  try {
    const fd = fs.openSync(path.join(directory, 'attachments.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { manifest = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
  } catch { throw new Error('no readable attachment manifest for this task; use an attachment from its task card'); }
  if (manifest.task_id !== taskId || !manifest.attachment_ids?.includes(attachmentId)) throw new Error('attachment is not listed for this task');
  if (!manifest.workspace_id || (config.workspace_id && config.workspace_id !== manifest.workspace_id)) throw new Error('attachment task workspace does not match configuration');
  secureDirectory(destinationDir);
  const fetcher = dependencies.fetch ?? fetch;
  const signal = AbortSignal.timeout(60_000);
  const headers = { Authorization: `Bearer ${taskToken}`, 'X-Workspace-ID': manifest.workspace_id };
  const base = checkedURL(config.base_url, undefined);
  let handle;
  let temporary;
  try {
    const metadataResponse = await fetcher(new URL(`/api/attachments/${encodeURIComponent(attachmentId)}`, base), { headers, signal, redirect: 'error' });
    if (!metadataResponse.ok) throw new Error(`attachment metadata HTTP ${metadataResponse.status}`);
    const metadata = await metadataResponse.json();
    if (metadata.id !== attachmentId) throw new Error('attachment metadata ID mismatch');
    const filename = metadata.filename;
    if (typeof filename !== 'string' || !filename || filename === '.' || filename === '..' || /[/\\\u0000-\u001f\u007f]/u.test(filename)) throw new Error('unsafe attachment filename');
    const destination = path.join(destinationDir, filename);
    try {
      fs.lstatSync(destination);
      throw new Error('download destination already exists; choose another task-local output directory');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let url = checkedURL(metadata.download_url, base);
    // Even an absolute same-origin signed URL is sent without credentials.
    let authenticated = !/^https?:/i.test(metadata.download_url) && url.origin === base.origin;
    let response;
    for (let redirects = 0; redirects <= 5; redirects++) {
      response = await fetcher(url, { headers: authenticated ? headers : {}, signal, redirect: 'manual' });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (redirects === 5 || !location) throw new Error('attachment redirect limit or missing location');
      const next = checkedURL(location, url);
      if (url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('attachment redirect downgrades HTTPS');
      authenticated = authenticated && next.origin === base.origin;
      url = next;
    }
    if (!response.ok) throw new Error(`attachment download HTTP ${response.status}`);
    if (Number(response.headers.get('content-length')) > MAX_DOWNLOAD_BYTES) { await response.body?.cancel(); throw new Error('attachment exceeds 100 MiB limit'); }
    if (!response.body) throw new Error('attachment download has no body');
    // Recheck after network awaits, then stage privately. linkSync publishes
    // atomically without overwriting an existing file (including a symlink).
    secureDirectory(destinationDir);
    temporary = path.join(destinationDir, `.download-${crypto.randomUUID()}`);
    handle = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) throw new Error('attachment exceeds 100 MiB limit');
      let offset = 0;
      while (offset < chunk.byteLength) offset += fs.writeSync(handle, chunk, offset, chunk.byteLength - offset);
    }
    fs.closeSync(handle); handle = undefined;
    secureDirectory(destinationDir);
    fs.linkSync(temporary, destination);
    return { id: attachmentId, filename, path: destination, size };
  } catch (error) {
    // Never echo signed URL query strings, credentials, or transport error causes.
    const safe = /^(attachment |unsafe attachment|download destination)/.test(error.message) ? error.message : 'attachment download failed (network, response, or local file error)';
    throw new Error(safe.split(taskToken).join('[REDACTED]'));
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
  }
}
