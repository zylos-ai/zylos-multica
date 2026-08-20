# zylos-multica design

## Purpose

zylos-multica presents a Zylos agent as a Multica daemon runtime while keeping
the agent's existing C4 session as the execution context. Multica owns task
state, C4 owns message delivery, and scheduler owns future handoffs. The only
local task state is the scoped auth token for each active chat task.

## Flow

```text
Multica daemon API
  register -> heartbeat -> claim
                         |
                         +-- issue/chat -> C4 -> normal reply -> send.js -> complete
                         +-- future due -> scheduler -> C4 -> normal reply -> complete
                         +-- quick-create -> start -> one issue create -> complete
```

The bridge calls `start` only after C4 accepts a direct delivery or scheduler
accepts a durable future handoff. If both scheduler and direct C4 delivery fail,
the task remains dispatched for Multica's server-side recovery path.

## Process entry

PM2, the component lifecycle manifest, and `npm start` all launch
`src/main.js`. This thin process entry invokes the exported `main()`
unconditionally; `src/index.js` owns the bridge implementation and exports its
test seams without inferring direct execution from `process.argv`.

## Quick-create and business API

Only an explicit daemon `kind=quick_create` enters the translator. Validation
derives a Unicode-safe title from the first non-empty prompt line, preserves the
description byte-for-byte as a JavaScript string, validates pre-uploaded
attachment IDs, and stamps `origin_type=quick_create` plus the daemon task ID.
The single non-idempotent issue create is shared with the business CLI; only
terminal callbacks may be retried.

`scripts/multica.js` exposes six business leaves aligned with the upstream Go
CLI: issue create/get/list, issue comment add/list, and chat history. It uses the
component's local config and the shared HTTP layer; file-backed text inputs are
confined to the working directory unless explicitly overridden.

Chat history is task-scoped server-side. On a chat claim, the bridge atomically
stores the returned `mat_` token in a per-task mode-0600 file under a mode-0700
directory. `chat history --task <task-id>` uses that token instead of the
component PAT. A successful complete/fail callback removes the file; the server
also revokes the token when the task ends.

## Startup contract probe

Registration is both idempotent setup and the compatibility probe. Startup
requires the response to expose `runtimes` and include the registered `zylos`
runtime ID. Optional `repos` / `settings` fields are not consumed and may be
absent or null. A server version, when present, is diagnostic only.

## Trust boundaries

- The PAT lives only in the mode-0600 component `config.json` and is sent in the
  Authorization header, never process arguments.
- Active chat-task tokens live only in hashed-name mode-0600 files, never argv
  or logs, and are removed after a successful terminal callback.
- Provider type and component protocol version are code-controlled and cannot
  be overridden by configuration.
- Multica-controlled card text is sanitized for forged C4 `reply via` and
  `c4-send.js` markers before dispatch.
- Child processes use `execFile` argument arrays with timeouts.
- Multica task IDs embedded in optional report commands are shell-quoted.

## Configuration

Required fields are `base_url`, `pat`, `workspace_slug`, `daemon_id`, and
`runtime.name`. The slug is resolved to the workspace UUID at startup via
`GET /api/workspaces`; a legacy `workspace_id` config is rewritten in place by
the post-install/post-upgrade hooks or by the daemon on startup.
`poll_interval_s` defaults to 15 and is constrained to 1–300. The configure
and migration hooks use temp-file-plus-rename writes and enforce mode 0600.

## Due-date reconciliation

The bridge enumerates scheduler handoffs through the supported
`list --json --reply-channel multica` contract. Rows are constrained to
one-time Multica handoffs and reduced to the latest `next_run_at` per
`reply_endpoint`. A failed latest row triggers a Multica task-status preflight;
only an active parent is failed with `failure_reason: runtime_offline`, allowing
the server's existing retry policy to redispatch it. Terminal parents are
skipped, making repeated ticks and restarts idempotent without local mapping.
The component never parses scheduler human output, imports scheduler internals,
or reads the scheduler database.
