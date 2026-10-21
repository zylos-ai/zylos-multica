import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { atomicTaskWrite, withTaskLock } from './task-state.js';

// Serializes comments with completion, including the response-loss window.
// Only metadata is stored: no message body or authentication token.
export function createReplyGuard(config, options = {}) {
  const root = options.replyRoot ?? (options.root ? path.join(options.root, 'reply-guard') : path.join(DATA_DIR, 'reply-guard'));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(root).isDirectory()) throw new Error('invalid reply guard directory');
  fs.chmodSync(root, 0o700);
  return {
    async run(taskId, generation, context, operation) {
      const identity = [new URL(config.base_url).origin, config.workspace_id, taskId, generation || 'legacy'];
      const key = crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
      const file = path.join(root, `${key}.json`);
      return withTaskLock(path.join(root, `${key}.lock`), async () => {
        let record = { identity };
        try {
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try { record = JSON.parse(fs.readFileSync(fd, 'utf8')); } finally { fs.closeSync(fd); }
          if (JSON.stringify(record.identity) !== JSON.stringify(identity)) throw new Error('invalid reply guard identity');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (context?.issue_id) record.issue_id = context.issue_id;
        if (context?.chat_session_id) record.chat_session_id = context.chat_session_id;
        const save = () => (options.replyWrite ?? atomicTaskWrite)(file, record);
        return operation({
          beforeComment() {
            if (record.completion_started) throw new Error('task completion already started; comment rejected');
            record.comment_state = 'uncertain'; save();
          },
          commentSaved() { record.comment_state = 'saved'; save(); },
          freezeLegacyCompletion() { record.completion_started = true; save(); },
          assertComplete(text, contentAlreadyPosted = false) {
            if (record.chat_session_id && !record.issue_id) return;
            if (text.includes('mention://')) {
              throw new Error('Final reply mentions never trigger anyone. Post with issue comment add --task <id> --parent <trigger-comment> (omit --parent for assignment runs), check trigger_outcomes, then complete with a mention-free closing note.');
            }
            if (record.comment_state && !contentAlreadyPosted) {
              throw new Error('This run already posted a comment or its comment outcome is uncertain; the server may drop this final reply. Post the full result with issue comment add first (read back an uncertain write; do not blindly retry), then use report.js complete-posted <task_id@generation> <mention-free closing note> to acknowledge the content is already on the issue.');
            }
          },
        });
      });
    },
  };
}
