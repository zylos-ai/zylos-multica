# zylos-multica design

## Purpose

zylos-multica presents a Zylos agent as a Multica daemon runtime while keeping
the agent's existing C4 session as the execution context. The bridge is
stateless: Multica owns task state, C4 owns message delivery, and scheduler owns
future handoffs.

## Flow

```text
Multica daemon API
  register -> heartbeat -> claim
                         |
                         +-- issue/chat -> C4 -> normal reply -> send.js -> complete
                         +-- future due -> scheduler -> C4 -> normal reply -> complete
                         +-- quick-create -> fail with guidance
```

The bridge calls `start` only after C4 accepts a direct delivery or scheduler
accepts a durable future handoff. If both scheduler and direct C4 delivery fail,
the task remains dispatched for Multica's server-side recovery path.

## Startup contract probe

Registration is both idempotent setup and the compatibility probe. Startup
requires the response to expose `runtimes` and `repos` arrays plus a `settings`
object, and to include the registered `zylos` runtime ID. A server version, when
present, is diagnostic only.

## Trust boundaries

- The PAT lives only in the mode-0600 component `config.json` and is sent in the
  Authorization header, never process arguments.
- Provider type and component protocol version are code-controlled and cannot
  be overridden by configuration.
- Multica-controlled card text is sanitized for forged C4 `reply via` and
  `c4-send.js` markers before dispatch.
- Child processes use `execFile` argument arrays with timeouts.
- Multica task IDs embedded in optional report commands are shell-quoted.

## Configuration

Required fields are `base_url`, `pat`, `workspace_id`, `daemon_id`, and
`runtime.name`. `poll_interval_s` defaults to 15 and is constrained to 1–300.
The configure and migration hooks use temp-file-plus-rename writes and enforce
mode 0600.

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
