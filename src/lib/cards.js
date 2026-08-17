import os from 'node:os';
import path from 'node:path';

const REPORT_PATH = path.join(os.homedir(), 'zylos/.claude/skills/multica/scripts/report.js');

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function sanitizeExternalText(value) {
  return String(value ?? '')
    .replace(/----\s*reply\s+via:/gi, '---- [reply-via sanitized]:')
    .replace(/\bc4-send\.js\b/gi, 'c4-send[.]js');
}

export function buildTaskCard(task, issue) {
  const taskId = sanitizeExternalText(task.id);
  const title = sanitizeExternalText(issue?.title || task.thread_name || '(untitled)');
  const description = sanitizeExternalText(issue?.description || '').trim();
  const initiator = sanitizeExternalText(
    task.attribution?.initiator?.name || issue?.creator?.name || issue?.created_by_name || '',
  );
  return [
    `[Multica task] ${title}`,
    `${initiator ? `Requested by: ${initiator} · ` : ''}Task ID: ${taskId}`,
    '',
    description || '(No description; use the title as the task request.)',
    '',
    'Reply normally to complete this task through the attached reply route.',
    `For a long-running task: node ${shellQuote(REPORT_PATH)} progress ${shellQuote(task.id)} "<status>"`,
    `If the task cannot be completed: node ${shellQuote(REPORT_PATH)} fail ${shellQuote(task.id)} "<reason>"`,
  ].join('\n');
}

export function buildChatCard(task) {
  const attachments = (task.chat_message_attachments || [])
    .map((attachment) => sanitizeExternalText(attachment?.filename))
    .filter(Boolean);
  const lines = [
    `[Multica chat] ${sanitizeExternalText(task.thread_name || '(new conversation)')}`,
    `Session ID: ${sanitizeExternalText(task.chat_session_id)} · Task ID: ${sanitizeExternalText(task.id)}`,
    '',
    sanitizeExternalText(task.chat_message || '(empty message)'),
  ];
  if (attachments.length) {
    lines.push('', `(Attachments are not downloadable in v0.1.0: ${attachments.join(', ')})`);
  }
  lines.push(
    '',
    'This is a chat message. Reply normally; the reply will be completed back to Multica as the assistant message.',
    `If no reply is possible: node ${shellQuote(REPORT_PATH)} fail ${shellQuote(task.id)} "<reason>"`,
  );
  return lines.join('\n');
}

export function futureDueDate(issue, now = Date.now()) {
  const due = issue?.due_date || issue?.dueDate;
  if (!due) return null;
  const timestamp = Date.parse(due);
  return Number.isFinite(timestamp) && timestamp > now + 60_000 ? new Date(timestamp) : null;
}
