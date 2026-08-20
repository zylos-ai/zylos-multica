# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
