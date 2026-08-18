# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Translate explicit quick-create tasks through `start → one issue create →
  complete`, preserving the raw prompt, Unicode-safe title truncation, origin
  stamps, and pre-uploaded attachment IDs.
- Add the first official-shape business CLI slice: issue create/get/list,
  issue comment add/list, and current-conversation chat history.
- Authenticate chat history with the claimed task's scoped token, kept in a
  private per-task file only until a successful terminal callback.

### Changed

- Report the real component and runtime capability version as 0.2.21 so the
  server enables the implemented quick-create contract without claiming the
  later 0.4.3 priority/due capability tier.

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
