# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

### Security

- Keep the Multica PAT out of process arguments and redact it from API errors.
- Neutralize forged C4 `reply via` / `c4-send.js` markers before dispatch.
