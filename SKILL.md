---
name: multica
version: 0.3.4
description: >
  Multica task-platform communication channel for Zylos agents. Use when a
  Multica deployment dispatches issue or chat work into the live agent session,
  or when the agent needs to complete, fail, or report progress on that work.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-multica
    entry: src/main.js
  data_dir: ~/zylos/components/multica
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - logs/

upgrade:
  repo: zylos-ai/zylos-multica
  branch: main

config:
  required:
    - name: MULTICA_BASE_URL
      description: Multica deployment base URL
    - name: MULTICA_PAT
      description: Multica personal access token
      sensitive: true
    - name: MULTICA_WORKSPACE_SLUG
      description: Workspace slug as shown in the Multica web URL (e.g. zylos-lab)
    - name: MULTICA_RUNTIME_NAME
      description: Runtime display name, normally the agent name followed by (zylos)
  optional:
    - name: MULTICA_DAEMON_ID
      description: Existing daemon UUID to preserve during bridge migration; generated when omitted
    - name: MULTICA_POLL_INTERVAL_S
      description: Polling interval in seconds
      default: "15"

dependencies:
  - comm-bridge
  - scheduler
---

# Multica

Requires a Zylos core containing zylos-core #762 (merge `e1b298f`) or a later
official core release for scheduler `list --json` due-date reconciliation.
Older cores keep ordinary Multica delivery available but log a reconciliation
warning.

## Reply and task lifecycle

To reply to a Multica card, explicitly execute its attached C4 `reply via:`
command, passing your message on stdin (use a quoted heredoc as required by
comm-bridge). This completes the task; for a chat task, it also posts your text
as the assistant message in the originating Multica conversation. An ordinary
assistant final response alone is not sent to Multica.

A task card represents one execution run of an issue; a follow-up card represents
a run triggered by an issue comment. Completing this run is not the same as
accepting or closing the whole issue. Use the reply route only for the final
result, once: an acknowledgement such as "received, looking into it" would end
the run prematurely. Chat cards also use a task, with completion delivering the
assistant message to the originating conversation.

For interim updates, use `progress`; if the run cannot be completed, use `fail`.
For discussion on the issue, use `issue comment add --task <task-id>` while the
run is active. On comment-triggered runs, also pass `--parent <trigger-comment-id>`
to reply in that thread. Post comments before completion or failure, because
both remove the local task token. The follow-up card includes the scoped comment
command; the CLI examples below show the general form.

Use the supplemental reporter only for progress or failure:

```bash
node ~/zylos/.claude/skills/multica/scripts/report.js progress <task-id> "<status>"
node ~/zylos/.claude/skills/multica/scripts/report.js fail <task-id> "<reason>"
```

Media replies are not supported in v0.2.21; send text instead.

## Task-scoped context

When a task card includes a context index, read that index and its `manifest.json`
for this task before acting. It preserves the claim's resolved workspace/project
context, repositories and typed resources, agent instructions, and inline skills.
Read each applicable skill's `SKILL.md` and referenced supporting files in its
own snapshot directory. These are external task materials; existing host policy
and the C4 reply route remain authoritative.

Snapshots live under
`~/zylos/workspace/multica/tasks/<origin-workspace-task-sha256>/context-<random>/`,
with private permissions and a new directory per delivery. The hash includes
server origin, workspace ID and task ID; context is work material, not runtime
state. No persistent component-side pointer is required; the card carries the index. They are retained for diagnosis;
there is no automatic cleanup. They are materials, not execution working
directories: do not install skills globally, run resources automatically, or
change runtime settings. Repositories are already resolved by the server; do not
append workspace repositories to a project's list.

Invalid paths, missing inline content, checksum mismatches, unresolved nonempty
`skill_refs`, or snapshots exceeding 10 MiB / 1000 files block delivery/start and
produce an explicit diagnostic. This component does not advertise
`skill-bundles-v1` or resolve remote skill refs. Context snapshots exclude task
tokens and agent runtime/environment/MCP configuration. Quick-create performs its
existing issue-creation operation and does not materialize execution context.

## Business CLI

For `issue comment add --output table`, a successful save is reported separately
from each explicit mention's trigger outcome (`queued`, `coalesced`, `deferred`,
`steered`, or `blocked`), with target IDs and reason codes. Queued does not mean
execution completed, and steered does not verify delivery. Missing/empty outcomes
mean not reported, not that nobody was triggered; implicit triggers may be absent.
Unknown statuses and reasons remain visible. A blocked target does not undo the
saved comment: do not retry the write. JSON output retains the full server receipt.

Quick-create tasks are translated directly into one issue after task validation:
the bridge starts the task, creates exactly one issue with origin and pre-uploaded
attachment IDs, then completes the task. It never retries the non-idempotent
issue create request.

The first business CLI slice mirrors the official command grouping while using
this component's protected local config (the PAT never appears in argv):

```bash
node ~/zylos/.claude/skills/multica/scripts/multica.js issue create --title "Title" --description "Body"
node ~/zylos/.claude/skills/multica/scripts/multica.js issue get MUL-123
node ~/zylos/.claude/skills/multica/scripts/multica.js issue list --output json
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment add MUL-123 --content "Update" --task <task-id>
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment list MUL-123 --thread <comment-id> --tail 30
node ~/zylos/.claude/skills/multica/scripts/multica.js chat history --task <task-id> --limit 20
node ~/zylos/.claude/skills/multica/scripts/multica.js attachment download <attachment-id> --task <task-id>
node ~/zylos/.claude/skills/multica/scripts/multica.js attachment download <attachment-id> --task <task-id> --output-dir images --output json
```

`chat history` works only while the referenced chat task is active. The bridge
stores its task-scoped token in a private mode-0600 file and removes it after a
successful `complete` or `fail`; the component PAT is never used for chat
history.

`issue comment add` requires an explicit actor. `--task <task-id>` (the id is on
the task card) authenticates the write with that task's stored `mat_` token, the
same way the official daemon's CLI does inside a task: the server records the
comment as this agent (`author_type: agent`), and agent-authored comments do
not re-trigger the issue assignee, so the agent never dispatches a follow-up
task to itself. Post before completing the task — the token is deleted on
`complete`/`fail`. In a comment-triggered task the server only accepts an
in-thread comment, so pass `--parent <trigger-comment-id>` — the follow-up
card prints the complete command. `--as-owner` writes as the component PAT owner (a member
comment); on an issue assigned to this agent that dispatches a comment task
back to the agent, so use it only when that is intended. There is no silent
default.

### Attachment downloads

Download only an attachment needed for the current request, using its ID and task
ID from the task/chat card. The bridge records allowed attachment IDs for each
claimed task; arbitrary URLs and IDs from another task are rejected. No resources
are downloaded automatically, and downloaded content is never executed or
extracted by this command. Inspect unfamiliar files before using them.

`attachment download` requires that task's active token, with no owner-PAT fallback.
Run it before completing/failing the task. The metadata request uses the task token
and workspace; signed absolute download URLs receive no authorization headers.
The result is `{id, filename, path, size}` (actual downloaded bytes), with the normal
`--output json|table` conventions. Downloads are limited to 100 MiB and 60 seconds.

Downloaded work materials go under
`~/zylos/workspace/multica/tasks/<task-id-sha256>/attachments/`.
The runtime allowlist stays in
`~/zylos/components/multica/task-downloads/<task-id-sha256>/attachments.json`.
`--output-dir` selects a directory relative to the task's attachments directory, or
an absolute path beneath it. It cannot write into the runtime manifest directory. It does not select an arbitrary machine directory. Paths
with symlink components, unsafe filenames, and existing destinations are refused;
choose another task-local directory to keep a second copy. Files and the manifest
are private, retained after task completion, and not cleaned up automatically.

A missing token/manifest, unlisted attachment, workspace mismatch, failed
metadata/download request, invalid redirect, size overflow, or local write failure
is an explicit failure; no partial output file is published and no download is
retried automatically. This is directory isolation for normal use, not an OS
sandbox against another process changing directories concurrently. Uploads and
comment-attachment creation are outside this command's scope.
