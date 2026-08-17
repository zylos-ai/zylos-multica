<p align="center">
  <img src="./assets/logo.png" alt="Zylos" height="120">
</p>

<h1 align="center">zylos-multica</h1>

<p align="center">Connect a Multica deployment to a Zylos agent's live session.</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="Node.js"></a>
  <a href="https://zylos.ai"><img src="https://img.shields.io/badge/website-zylos.ai-blue" alt="Website"></a>
</p>

---

- Bridges Multica issue and web-chat tasks into C4 with standard reply routing.
- Preserves server-side redispatch semantics when local delivery fails.
- Supports future due-date handoff through the Zylos scheduler.
- Reconciles failed future handoffs back to Multica for eligible redispatch.
- Reports completion, progress, and failure directly to the Multica daemon API.
- Stores the PAT only in a mode-0600 component config file.

## Due-date reconciliation

The bridge enumerates its one-time handoffs through the scheduler's supported
`list --json --reply-channel multica` interface. For the latest handoff of each
Multica task, a terminal scheduler failure is reconciled only while the parent
task is still active, then reported with `failure_reason: runtime_offline` so
Multica can redispatch when its retry policy permits. The bridge keeps no local
mapping, so the same status preflight remains safe across repeated ticks and
process restarts. It does not parse scheduler human output, import scheduler
internals, or read `scheduler.db`.

## Install

```bash
zylos add zylos-ai/zylos-multica
```

The installer collects the Multica base URL, PAT, workspace ID, and runtime
display name. It generates a stable daemon ID unless an existing ID is supplied
during migration.

## Configuration

Runtime configuration is stored at `~/zylos/components/multica/config.json`:

```json
{
  "enabled": true,
  "base_url": "https://multica.example.com",
  "pat": "stored-locally",
  "workspace_id": "workspace-uuid",
  "daemon_id": "stable-daemon-uuid",
  "poll_interval_s": 15,
  "runtime": {
    "name": "My Agent (zylos)"
  }
}
```

To disable the component, stop its managed process with `pm2 stop zylos-multica`.
Changing `enabled` to `false` by itself makes the process exit, so a PM2 process
configured with automatic restarts will otherwise retry it until `max_restarts`.

The provider type is fixed to `zylos` and cannot be overridden by config.

## Usage

Incoming Multica cards include a standard C4 reply route. A normal reply
completes the task. For supplemental status reporting:

```bash
node ~/zylos/.claude/skills/multica/scripts/report.js progress <task-id> "Investigating"
node ~/zylos/.claude/skills/multica/scripts/report.js fail <task-id> "Blocked by missing input"
```

`scripts/send.js` intentionally rejects `[MEDIA:...]` replies because Multica
v0.1.0 completion output is text-only.

## Migration from the reference bridge

Stop `zylos-multica-bridge` before starting this component so two processes do
not claim from the same runtime. Install with the same base URL, PAT, workspace
ID, and daemon ID; registration is idempotent. Keep the old bridge stopped until
the live issue and chat checks pass.

## Operations

The service fails fast if the register response does not expose the expected
`runtimes`, `repos`, and `settings` contract. Key delivery log messages are
stable monitoring interfaces. PAT values are never included in command
arguments or normal logs.

This component has no browser-facing HTTP surface, so HTTP indexing controls do
not apply.

## Design Notes

Development-time architecture notes live in [docs/DESIGN.md](./docs/DESIGN.md).

## License

[MIT](./LICENSE)
