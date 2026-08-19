# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Adopt the official daemon's wakeup WebSocket (`GET /api/daemon/ws`): the
  server's `daemon:task_available` / `daemon:pending_work` hints wake the
  poll loop immediately for near-instant delivery, while claiming stays on
  the HTTP claim path and `poll_interval_s` polling remains the fallback.
  Reconnects use jittered exponential backoff with a stable-connection
  reset; a silent socket is recycled after an idle timeout; hints never
  shorten error backoff. Requires the Node 22+ global WebSocket — older
  runtimes log one warning and stay poll-only. (#12)

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
