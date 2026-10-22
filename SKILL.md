---
name: multica
version: 0.5.0
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
    - execution/
    - task-state/
    - task-tokens/
    - reply-guard/
    - task-downloads/
    - dispatch-preparations/

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

Task-state locking requires util-linux `flock` on Linux, or the system
`/usr/bin/perl` with standard `Fcntl` on macOS. macOS does not need the `flock`
command. Losing a lock does not prove that task execution has stopped.

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

For issue tasks, final replies containing `mention://` are rejected: completion
does not dispatch mentions. Post mentions using `issue comment add --task`
(with `--parent` for a comment-triggered run), then inspect `trigger_outcomes`.
Once this component observes a comment attempt in the same run, an ordinary
final reply is also rejected because the server may omit it. Put the full
result on the issue, stop work with `task.js quiesce ... --stopped`, then use
`report.js complete-posted <task-id@generation> "<mention-free closing note>"`.
This explicitly acknowledges that the issue already holds the result; it does
not post another comment. If a comment response was lost, read back the issue
before posting again. A saved comment does not prove a mentioned target ran.

The comment guard covers this component's task-scoped comment writes, not
comments posted through other clients or `--as-owner`. Known chat tasks keep
their normal assistant reply behavior. Legacy task tokens without issue/chat
metadata conservatively receive the issue mention check until a fresh claim.

Use the supplemental reporter for progress, failure, or recovery of a pending result:

```bash
node ~/zylos/.claude/skills/multica/scripts/report.js progress <task-id@generation> "<status>"
node ~/zylos/.claude/skills/multica/scripts/report.js fail <task-id@generation> "<reason>"
```

Media replies are not supported in v0.2.21; send text instead.

## Task admission, Agent-owned resources and recovery

For cards with `task_id@generation`, run `task.js begin` exactly as the card says.
Proceed only on `accepted: true`; false means a duplicate, not permission to run
again. Unaccepted cards may be redelivered with the same generation. Older plain
ID cards keep their original reply route.

The component does not invoke Git, prepare repositories or bind working directories.
Read the context manifest and resource metadata; choose authorized Git, API or
existing-directory access yourself, using your native tools. Supplied local paths
are source information, not prepared/verified directories. Preserve task identity
and track your processes and work locations. Report access blockers in the task.

Before completing or failing, finish/stop every task command, child process and
native edit, then run `task.js quiesce <task@generation> --stopped`. This is your
explicit acknowledgement, not a process cancellation mechanism. Optional
`--work-dir <path> --branch <name> --pr-url <url>` records actual work metadata;
no old binding is inferred. Omit filesystem flags for API-only work. Failure sends
work_dir/branch_name only; completion also supports pr_url. Describe multiple
resource results in your final text. Complete through the attached C4 route, or
use `report.js fail`. Pending reports keep their frozen text and identity: use
`report.js reconcile <task@generation>` until authoritative confirmation.

`task.js inspect` exposes lifecycle and historical records without changing them.
The old `exec`, `locate`, and `recover` commands are retired. For an unstarted,
undelivered task, `task.js abandon <task@generation> --reason <text> --stopped`
requires independent verification that previous preparation and task work stopped.
Never delete old records or report success to bypass a failure. Confirmed failures
need new continuation tasks; the Agent chooses how to reuse preserved artifacts.
See [Agent-owned resources](docs/agent-owned-resources.md) for migration, old queued
cards, interrupted preparation, cancellation limits and Piper B1/C2 continuation.
Runtime records and workspace materials survive upgrades; official Server is unchanged.

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

The business CLI mirrors the scoped official business command groups and talks
directly to the configured server. It does not install or invoke the official
CLI. Authentication comes from protected component configuration; keep its PAT
private, never pass it in argv, paste it into examples, or print configuration.
A failed API request does not establish that an official CLI connection or
installation is missing.

Supported command families:

| Group | Commands |
| --- | --- |
| `issue` | list, get, create, update, status, assign, reorder, children, pull-requests, runs, usage, search, run-messages, cancel-task, rerun, timeline/history |
| `issue comment` | list, add, update, delete, resolve, unresolve |
| `issue label` / `issue subscriber` | list, add, remove |
| `issue metadata` | list, get, set, delete |
| `issue property` | list, set, unset |
| `issue wakeup` | list, get, runs (reads only) |
| `project` / `project resource` | list, get, create, update, delete, status / list, add, update, remove |
| `label` / `property` | list, get, create, update, delete / list, get, create, update, archive, unarchive |
| `workspace` / `workspace member` | list, get, create, update / list, invite |
| `agent` / `squad` | list, get, tasks, skills list / list, get, member list |
| `chat` / `attachment` | history, thread / download, upload |

Issue update/status/assign default to `suppress_run: true`: changing issue data
does not opt into starting a run. `--no-start` makes that default explicit;
`--start` opts into server execution and conflicts with `--no-start`. Reorder
also suppresses execution and requires exactly one of `--before`, `--after`,
`--top`, or `--bottom`; it reads the paginated status/project column before
writing a position. Refresh and inspect after a concurrent column-change error.

Every mutation is a single attempt. After a successful write, use the matching
get/list command to verify current state. If a response is lost, inspect current
state before deciding what to do; do not blindly retry creates, comments,
uploads, reruns, or other writes. All run operations require a full run UUID;
official CLI short run IDs are not supported here. Remaining differences and
deferred commands are listed in [coverage](docs/business-cli-coverage.md).

Examples (replace IDs with values from the current task or read results):

```bash
node ~/zylos/.claude/skills/multica/scripts/multica.js issue create --title "Title" --description "Body"
node ~/zylos/.claude/skills/multica/scripts/multica.js issue get MUL-123
node ~/zylos/.claude/skills/multica/scripts/multica.js issue list --output json
node ~/zylos/.claude/skills/multica/scripts/multica.js issue update MUL-123 --title "Revised title" --no-start
node ~/zylos/.claude/skills/multica/scripts/multica.js issue status MUL-123 in_progress
node ~/zylos/.claude/skills/multica/scripts/multica.js issue assign MUL-123 --to "Piper" --start
node ~/zylos/.claude/skills/multica/scripts/multica.js issue reorder MUL-123 --top
node ~/zylos/.claude/skills/multica/scripts/multica.js issue property set MUL-123 --name "Severity" --value "Major"
node ~/zylos/.claude/skills/multica/scripts/multica.js issue property list MUL-123 --output json
node ~/zylos/.claude/skills/multica/scripts/multica.js issue wakeup list MUL-123
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment add MUL-123 --content "Update" --task <task-id>
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment list MUL-123 --thread <comment-id> --tail 30
node ~/zylos/.claude/skills/multica/scripts/multica.js chat history --task <task-id> --limit 20
node ~/zylos/.claude/skills/multica/scripts/multica.js chat thread --task <task-id> --limit 20
node ~/zylos/.claude/skills/multica/scripts/multica.js attachment upload ./result.png --task <task-id>
node ~/zylos/.claude/skills/multica/scripts/multica.js attachment download <attachment-id> --task <task-id>
node ~/zylos/.claude/skills/multica/scripts/multica.js attachment download <attachment-id> --task <task-id> --output-dir images --output json
```

`chat history`, `chat thread`, and `attachment upload` work only while the
referenced chat task is active. Run them before completing or failing it. The bridge
stores its task-scoped token in a private mode-0600 file and removes it after a
successful `complete` or `fail`; the component PAT is never used for chat
history, thread reads, or uploads. Uploads use multipart form data, are limited
to regular files of at most 100 MiB, and have a 60-second request timeout. Paths
must resolve inside the current working directory unless the caller explicitly
passes `--allow-external-file`; use only authorized task files. An upload is
not a final reply or task completion.

Issue properties support all 11 pinned types: text, multi_text, URL, multi_url,
number, checkbox, date, select, multi_select, actor, and multi_actor. Lists return
named rows beside stored values; option/member display names fall back to raw
IDs when unavailable. Archived definitions cannot receive new values. Use a
JSON array for multi_text/multi_url values containing commas. Member properties
resolve members, not agents or squads; dates use `YYYY-MM-DD`.

Wakeup create/update/disable/trigger/delete/checkin and event catalogs remain
deferred: checkin affects completion semantics, and recurring-rule validation
needs dedicated lifecycle tests. Agent/squad mutation and runtime-management
commands are outside this CLI's scope. Local fixture validation does not verify
live server writes or full official v0.6.2 parity.

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
sandbox against another process changing directories concurrently. Uploads use
the separate command above; comment-attachment creation is outside this scope.
