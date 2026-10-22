# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0] - 2026-10-22

### Fixed

- Reject issue-task final replies containing mention URIs and ordinary final
  replies after task-scoped comment attempts, including lost responses. Persist
  the guard across helper restarts and serialize comment writes with completion.
  Add `report.js complete-posted` for an explicit closing acknowledgment after
  the full result is on the issue; chat assistant replies retain their behavior.

### Added

- Broaden the direct-HTTP business CLI across issue queries and mutations,
  comments, labels, subscribers, metadata, all 11 property types, projects and
  resources, workspace members, and agent/squad reads. Add task-token chat
  threads and bounded multipart chat attachment uploads without an official CLI
  dependency.
- Add issue reorder using a paginated status/project column and wakeup
  list/get/runs reads. Wakeup mutations/events remain deferred pending lifecycle
  validation; run commands currently require full UUIDs rather than short IDs.

### Changed

- Default issue update/status/assign to suppress execution; require `--start`
  to opt in. Reorder also suppresses execution. Preserve single-attempt writes,
  controlled file paths and protected configuration authentication.
- Pin the business contract inventory to official v0.6.2 while keeping the
  advertised protocol capability version unchanged.

### Validation and scope

- The merged functionality passes 345 regression tests and Linux/macOS CI.
  Independent live acceptance on the merged main verified issue
  update/status/assign writes and readback without starting runs by default,
  both duplicate-of commands, C4 task delivery, final-reply rejection paths,
  and comment-then-complete-posted reconciliation without duplicate comments.
- Fresh private-chat validation, deferred wakeup mutations/events, and full
  official CLI parity are outside this release's acceptance scope. The pinned
  official source version does not raise the advertised protocol capability.

### Upgrade notes

- Stop active component/helper processes and agent work before upgrading,
  following the existing upgrade procedure. Preserve configuration and task,
  token, reply-guard, and reconciliation state.
- Use `--start` explicitly when an issue update/status/assign should launch
  execution. After posting the full issue result as a task-scoped comment,
  close the run with `report.js complete-posted` instead of resending the body
  through the ordinary final-reply route.

## [0.5.0] - 2026-10-16

### Changed

- Deliver task resources without component-managed Git preparation. Agents choose
  authorized repository access and working directories after task admission;
  missing local Git credentials no longer block task delivery.
- Retire `task.js exec`, `locate`, and `recover`. Use native Agent tools and
  acknowledge stopped work with `quiesce --stopped`; optional execution metadata
  records the actual directory, branch, and PR. Upstream protocol capability
  reporting remains unchanged.
- Preserve admission, exact result reconciliation, old files and reports. Replace
  unaccepted cards with Agent-owned instructions while preserving their originals;
  accepted tasks are not automatically restarted. Confirmed failures require new
  continuation tasks. See [upgrade and migration guidance](docs/agent-owned-resources.md).

### Fixed

- Preserve frozen preparation failures and uncertain terminal reports for
  reconciliation. Allow explicit, idempotent abandonment of unstarted,
  undelivered tasks only after confirming previous work has stopped.

### Upgrade notes

- Stop old service/helper processes and Agent work before activating this version.
  Historical Git bindings and operation records are retained; they are not new
  directory ownership guarantees. Local regression tests do not establish that a
  newly dispatched production task can access its repositories and complete work.

## [0.4.2] - 2026-10-15

### Added

- Explicit failed-run worktree recovery with exact task/generation and baseline
  selection, stopped-work checks, durable replay and idempotent ownership transfer.
  Preserve old artifacts and failed state; reuse existing Server lease/start APIs.

## [0.4.1] - 2026-10-15

### Fixed

- Use macOS system Perl's OS file lock for task-state coordination, fixing task
  intake failures on machines without the Linux `flock` command. Preserve Linux
  locking and release on caller exit without adding npm dependencies.

## [0.4.0] - 2026-10-15

### Fixed

- Keep command occupancy when background process-group members survive a normal
  shell exit, and exclude overlapping parent/child in-place directories atomically.
- Preserve server failure classification for omitted/empty reasons so transient
  network failures retain the platform's retry eligibility.

- Keep downloaded task materials under `workspace/multica/tasks`, separate from component-owned attachment allowlists; output paths cannot target runtime state.
- Store task context materials in task-scoped workspace snapshots, keeping component runtime state separate.

### Added

- Distinguish saved comments from queued, coalesced, deferred, steered and blocked
  agent-trigger outcomes in table output, preserving the JSON response.

- Task-scoped `attachment download` with claimed-ID checks, binary streaming,
  a 100 MiB cap, credential-safe redirects, and contained non-overwriting files.
- Chat, issue, and follow-up cards include attachment IDs and explicit download
  commands. Downloads remain opt-in; no uploads, execution, or auto-extraction.
- Preserve claim-provided workspace/project resources, resolved repositories,
  agent instructions and inline skills with supporting files in private,
  task-scoped snapshots. All execution card types link the context index (#30).
- Refuse delivery/start when context cannot be safely materialized, including
  unresolved skill refs, invalid supporting paths, and oversized payloads.
- Add a task worktree manager with persistent resource
  bindings, workline/path exclusion, source snapshots and confirmed continuation.
- Add explicit-cwd command execution, quiescence and conservative interruption
  recovery. Preparation is asynchronous and cancellable so lease timers can run.
- Keep work content under `workspace/multica` and execution metadata under the
  component data directory. Claim-aware tasks use durable preparation, explicit
  session admission and generation-bound reporting; unaccepted cards can retry.
- Retain uncertain terminal reports for authoritative result reconciliation and
  preserve task state, tokens, allowlists and execution bindings across upgrades.

## [0.3.4] - 2026-10-15

### Fixed

- Remove misleading automatic-forwarding instructions from chat, task, and
  follow-up cards; reply routing remains supplied by C4 (#27, #28).

### Documentation

- Centralize final completion, progress/failure, and issue-comment guidance in
  the skill. Task cards point unfamiliar agents to that section without
  requiring familiar agents to reread it.

## [0.3.3] - 2026-08-26

### Fixed

- `issue comment add` no longer writes as the component PAT owner by default.
  `--task <task-id>` authenticates the comment with the task's stored `mat_`
  token, mirroring the official daemon CLI, so the server attributes it to the
  agent and does not dispatch a follow-up task back to the agent for its own
  reply (#24). Writing as the PAT owner is now the explicit `--as-owner`
  opt-in (bare flag only — `--as-owner <value>` is rejected like every other
  boolean option); omitting both flags, or naming a task with no stored token,
  is an argument error raised before any request — including before the
  slug-only config's workspace resolution `GET /api/workspaces`.
- Task-token errors and cleanup warnings say `task token` instead of
  `chat token`: the store now serves issue tasks as well as chat tasks (#24).

## [0.3.2] - 2026-08-25

### Fixed

- Comment-triggered tasks now deliver the triggering comment instead of the
  issue body. The claim payload's `trigger_comment_*`, `coalesced_comments`
  and `new_comment_count` fields are rendered as a `[Multica follow-up]` card
  that leads with the new comment (author-labelled, quoted), lists earlier
  coalesced comments, points at the full thread, and demotes the issue
  description to context. First-assignment cards now also carry the
  assigner's `handoff_note`. All new fields pass through the reply-route
  sanitizer. (#21)

### Documentation

- Add a README "Onboarding a new zylos agent" section covering the verified
  flow for connecting an additional agent machine: core upgrade, per-machine
  PAT, workspace slug from the web URL, private PAT delivery, and
  post-install verification.

## [0.3.1] - 2026-08-20

Security release: fixes 6 of the 9 findings from the 2026-08-20 full security
scan of `main@501ec25` (44/44 files, 1 Medium / 8 Low). The remaining 3
findings are explicitly deferred with tracking issues: #17 (poison task
content), #18 (scheduler task-source binding), #19 (attachment preflight).

### Security

- Enforce `https`/`wss` for non-loopback server URLs so PATs and task tokens
  are never sent in cleartext over the network; loopback addresses may keep
  plain `http`/`ws` for local development. (Medium, finding #1)
- Tighten the wakeup WebSocket to origin-only: connection URLs are rebuilt
  from the configured origin instead of trusting server-provided values.
  (finding #4)
- Validate `--output` before any API call: pre-dispatch validation in
  `runBusinessCLI` runs ahead of workspace resolution, so an invalid value
  fails with zero requests even in slug-only configurations; command-level
  validation is retained as defense in depth. (finding #3, hardened after
  exact-head re-review found the slug-only `GET /api/workspaces` gap)
- Quarantine scheduler failures per task row so one malformed task cannot
  stall or poison processing of other tasks. (finding #7)
- Escape terminal control sequences in table output to prevent
  escape-sequence injection via platform-sourced text. (finding #8)
- Sanitize task IDs before embedding them in cards, closing a route-marker
  injection path for platform-sourced identifiers. (finding #6)

## [0.3.0] - 2026-08-19

### Added

- Adopt the official daemon's wakeup WebSocket (`GET /api/daemon/ws`): the
  server's `daemon:task_available` / `daemon:pending_work` hints wake the
  poll loop immediately for near-instant delivery, while claiming stays on
  the HTTP claim path and `poll_interval_s` polling remains the fallback.
  Reconnects use jittered exponential backoff with a stable-connection
  reset; a silent socket is recycled after an idle timeout; hints never
  shorten error backoff. Requires the Node 22+ global WebSocket — older
  runtimes log one warning and stay poll-only. (#12)

### Changed

- Replace the `workspace_id` config parameter with `workspace_slug`
  (`MULTICA_WORKSPACE_SLUG`). The bridge resolves the slug to the workspace
  UUID at startup via `GET /api/workspaces`; an unknown slug fails fast and
  lists the account's available slugs. Legacy `workspace_id` configs are
  migrated in place by the post-install and post-upgrade hooks when the
  server is reachable, or by the daemon on startup otherwise. (#11)

## [0.2.21] - 2026-08-19

### Added

- Translate explicit quick-create tasks through `start → one issue create →
  complete`, preserving the raw prompt, Unicode-safe title truncation, origin
  stamps, and pre-uploaded attachment IDs.
- Add the first official-shape business CLI slice: issue create/get/list,
  issue comment add/list, and current-conversation chat history.
- Authenticate chat history with the claimed task's scoped token, kept in a
  private per-task file only until a successful terminal callback.

### Changed

- Separate the component release version from the upstream compatibility
  track. Daemon registration now reads the code-owned `UPSTREAM_VERSION`
  (currently 0.2.21) rather than coupling capability reporting to package
  metadata; bump it only after aligning with a newer official contract.

### Security

- Validate quick-create inputs before issue creation and never replay an
  ambiguous non-idempotent create failure.
- Constrain CLI file-backed text inputs to the current working directory by
  default, including symlink resolution.
- Document that PAT-authored issue comments can retrigger the same agent and
  require an explicit loop guard in automatic same-issue handlers.

## [0.1.0] - 2026-08-19

### Added

- Multica daemon registration, heartbeat, claim, issue delivery, chat delivery,
  future due-date scheduler handoff, and server-side redispatch preservation.
- Restart-safe reconciliation of failed due-date scheduler handoffs through the
  supported JSON CLI, with latest-row selection and idempotent task-status
  preflight before retryable Multica failure reporting.
- Startup register-response contract probe for `runtimes`, `repos`, and
  `settings`.
- Standard C4 reply routing with text completion plus supplemental progress and
  failure reporting.
- Route-marker sanitization for all Multica-controlled card fields.
- Non-interactive configuration and idempotent install/upgrade hooks with
  atomic mode-0600 config writes.
- Node test coverage for protocol, routing, sanitization, failure, and hook
  behavior.

### Fixed

- Start the bridge through an unconditional thin process entry so PM2 fork
  mode cannot bypass `main()` when `process.argv[1]` points at PM2's wrapper.

### Security

- Keep the Multica PAT out of process arguments and redact it from API errors.
- Neutralize forged C4 `reply via` / `c4-send.js` markers before dispatch.
