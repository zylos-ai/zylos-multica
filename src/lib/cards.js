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

const MULTICA_CLI_PATH = path.join(os.homedir(), 'zylos/.claude/skills/multica/scripts/multica.js');

function quoteBlock(text) {
  return String(text)
    .split(/\r\n|\n|\r/u)
    .map((line) => `> ${line}`)
    .join('\n');
}

function authorLabel(authorType, authorName, fallback = 'A user') {
  const name = sanitizeExternalText(authorName).trim();
  if (authorType === 'agent') return name ? `Another agent (${name})` : 'Another agent';
  return name || fallback;
}

function taskCardFooter(taskId) {
  return [
    'Reply normally to complete this task through the attached reply route.',
    // The command copies use the sanitized ID too: shell quoting alone leaves
    // C4's reply-route marker substrings intact, so a noncanonical task ID
    // must not reintroduce a forged route after the display-field sanitization.
    `For a long-running task: node ${shellQuote(REPORT_PATH)} progress ${shellQuote(taskId)} "<status>"`,
    `If the task cannot be completed: node ${shellQuote(REPORT_PATH)} fail ${shellQuote(taskId)} "<reason>"`,
  ];
}

// A comment-triggered run: the server queued a new task on an issue this
// runtime already worked on because someone commented. The claim payload
// carries the triggering comment (and any earlier comments coalesced into
// this run); the card must lead with THAT, not with the issue text, or the
// agent answers the original request again (zylos-multica #21).
function buildFollowUpCard(task, issue) {
  const taskId = sanitizeExternalText(task.id);
  const title = sanitizeExternalText(issue?.title || task.thread_name || '(untitled)');
  const description = sanitizeExternalText(issue?.description || '').trim();
  const issueRef = sanitizeExternalText(issue?.identifier || task.issue_id || '');
  const author = authorLabel(task.trigger_author_type, task.trigger_author_name);
  const comment = sanitizeExternalText(task.trigger_comment_content).trim();
  const lines = [
    `[Multica follow-up] ${title}`,
    `Requested by: ${author} · Task ID: ${taskId}`,
    '',
    `${author} left a NEW COMMENT on this issue. Reply to THIS comment — do not treat the original issue text below as the request:`,
    '',
    comment ? quoteBlock(comment) : '> (empty comment)',
  ];
  const coalesced = Array.isArray(task.coalesced_comments) ? task.coalesced_comments : [];
  if (coalesced.length) {
    lines.push('', `This run also covers ${coalesced.length} earlier comment(s) posted before it started — address them too:`);
    for (const item of coalesced) {
      const who = authorLabel(item?.author_type, item?.author_name);
      const when = sanitizeExternalText(item?.created_at).trim();
      const body = sanitizeExternalText(item?.content).trim() || '(empty comment)';
      lines.push(`- ${who}${when ? ` (${when})` : ''}:`, quoteBlock(body));
    }
  }
  const newCount = Number(task.new_comment_count) || 0;
  if (newCount > 0 && issueRef) {
    lines.push(
      '',
      `${newCount} other comment(s) were posted on this issue since your last run. Full thread: node ${shellQuote(MULTICA_CLI_PATH)} issue comment list ${shellQuote(issueRef)}`,
    );
  }
  if (description) {
    lines.push('', 'Original issue description (context only):', quoteBlock(description));
  }
  lines.push('', ...taskCardFooter(taskId));
  return lines.join('\n');
}

export function buildTaskCard(task, issue) {
  if (task?.trigger_comment_id || task?.trigger_comment_content) return buildFollowUpCard(task, issue);
  const taskId = sanitizeExternalText(task.id);
  const title = sanitizeExternalText(issue?.title || task.thread_name || '(untitled)');
  const description = sanitizeExternalText(issue?.description || '').trim();
  const initiator = sanitizeExternalText(
    task.attribution?.initiator?.name || issue?.creator?.name || issue?.created_by_name || '',
  );
  const handoff = sanitizeExternalText(task.handoff_note || '').trim();
  const lines = [
    `[Multica task] ${title}`,
    `${initiator ? `Requested by: ${initiator} · ` : ''}Task ID: ${taskId}`,
    '',
    description || '(No description; use the title as the task request.)',
  ];
  if (handoff) {
    lines.push('', 'Handoff note from the assigner (scoping instruction for this run, not a comment to reply to):', quoteBlock(handoff));
  }
  lines.push('', ...taskCardFooter(taskId));
  return lines.join('\n');
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
    lines.push('', `(Chat attachments are not downloadable in v0.2.21: ${attachments.join(', ')})`);
  }
  lines.push(
    '',
    'This is a chat message. Reply normally; the reply will be completed back to Multica as the assistant message.',
    // Sanitized for the same reason as the task-card commands above.
    `If no reply is possible: node ${shellQuote(REPORT_PATH)} fail ${shellQuote(sanitizeExternalText(task.id))} "<reason>"`,
  );
  return lines.join('\n');
}

export function futureDueDate(issue, now = Date.now()) {
  const due = issue?.due_date || issue?.dueDate;
  if (!due) return null;
  const timestamp = Date.parse(due);
  return Number.isFinite(timestamp) && timestamp > now + 60_000 ? new Date(timestamp) : null;
}
