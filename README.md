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
- Converts validated quick-create tasks into exactly one origin-stamped issue,
  including pre-uploaded attachment IDs.
- Provides an official-shape business CLI slice for issue create/get/list,
  issue comment add/list, and current-conversation chat history.
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

Due-date reconciliation requires a Zylos core that includes
[zylos-core #762](https://github.com/zylos-ai/zylos-core/pull/762), specifically
merge `e1b298f` or a later official core release. On older cores, ordinary
Multica delivery continues, but scheduler reconciliation is unavailable and
logs a warning because `scheduler list --json` is not supported.

```bash
zylos add zylos-ai/zylos-multica
```

The installer collects the Multica base URL, PAT, workspace slug, and runtime
display name. It generates a stable daemon ID unless an existing ID is supplied
during migration.

## Onboarding a new zylos agent

Checklist for connecting an additional Zylos agent machine to an existing
Multica workspace. The flow below matches a verified real onboarding of a
second agent machine.

1. **Upgrade zylos-core first.** The install preview reports the required core
   level (see [Install](#install)); upgrade before installing so due-date
   reconciliation works from day one:

   ```bash
   zylos upgrade --self
   ```

2. **Create a dedicated PAT for the new machine.** The account model: a PAT is
   a machine registration credential, while identity lives at the agent layer.
   Reuse the same Multica account, but issue one token per machine — never
   share an existing machine's PAT. In the Multica web UI:
   Settings → API Tokens → Create (suggested name: `<agent>-bridge`).

3. **Gather the three config values.**
   - `base_url` — the deployment origin, exactly what the browser address bar
     shows, without a path (e.g. `https://multica.example.com`).
   - `workspace_id` — the workspace UUID. It is **not visible in the web UI**
     (page URLs show the slug, not the UUID). Query it with the PAT:

     ```bash
     curl -s -H "Authorization: Bearer $PAT" https://multica.example.com/api/workspaces
     ```

     The response lists each workspace's `id`, `slug`, and `name`.
   - `runtime.name` — the display name shown in the Runtimes panel,
     e.g. `"My Agent (zylos)"`.

4. **Install and configure.**

   ```bash
   zylos add zylos-ai/zylos-multica
   ```

   The installer prompts for every required value. Deliver the PAT to the new
   machine's operator over a private channel only — never in a group chat or
   task record. It is stored solely in the mode-0600 component config.

5. **Verify.** After the service starts:
   - `pm2 status zylos-multica` shows `online` with no restarts;
   - the delivery log records a successful registration;
   - the new runtime appears in the workspace's Runtimes panel;
   - a test web-chat message reaches the agent and the reply closes the task.

Chat and issue tasks are claimed on a `poll_interval_s` cadence (default 15s),
so a queued message can wait up to one full interval before delivery. Lower the
value in the component config for snappier interactive chat.

## Configuration

Runtime configuration is stored at `~/zylos/components/multica/config.json`:

```json
{
  "enabled": true,
  "base_url": "https://multica.example.com",
  "pat": "stored-locally",
  "workspace_slug": "my-workspace",
  "daemon_id": "stable-daemon-uuid",
  "poll_interval_s": 15,
  "runtime": {
    "name": "My Agent (zylos)"
  }
}
```

`workspace_slug` is the slug shown in the workspace's web URL. The bridge
resolves it to the workspace UUID at startup through `GET /api/workspaces`
with the component PAT; an unknown slug fails fast with the account's
available slugs listed. A pre-slug config that still stores `workspace_id`
keeps working: post-install rewrites it to the slug form when the server is
reachable, and the daemon performs the same migration on startup otherwise.

To disable the component, stop its managed process with `pm2 stop zylos-multica`.
Changing `enabled` to `false` by itself makes the process exit, so a PM2 process
configured with automatic restarts will otherwise retry it until `max_restarts`.

The provider type is fixed to `zylos` and cannot be overridden by config.

### Version tracks

The component release version and the upstream compatibility version are
independent. `package.json` / `SKILL.md` describe the zylos-multica release,
while `src/lib/upstream-version.js` records the latest official Multica CLI
capability level whose business semantics this bridge implements. Daemon
registration uses that `UPSTREAM_VERSION` for both `cli_version` and runtime
version; it never derives the capability gate from the package version.

The current upstream compatibility level is 0.2.21. Update it only when the
bridge is aligned with a newer official business-command contract and the
matching server behavior and regression tests have been verified.

## Usage

Incoming Multica cards include a standard C4 reply route. A normal reply
completes the task. For supplemental status reporting:

```bash
node ~/zylos/.claude/skills/multica/scripts/report.js progress <task-id> "Investigating"
node ~/zylos/.claude/skills/multica/scripts/report.js fail <task-id> "Blocked by missing input"
```

`scripts/send.js` intentionally rejects `[MEDIA:...]` replies because Multica
v0.2.21 completion output is text-only.

### Quick-create and business commands

Quick-create is recognized only from `task.kind === "quick_create"`. The prompt
and attachment-ID array are validated before issue creation, then the bridge
runs `start → one create → complete`. An ambiguous create failure is reported
to the task and never replayed, avoiding duplicate issues.

The business CLI reads the same mode-0600 component config, so the PAT does not
appear in process arguments:

```bash
node ~/zylos/.claude/skills/multica/scripts/multica.js issue create --title "Title" --description "Body"
node ~/zylos/.claude/skills/multica/scripts/multica.js issue get MUL-123
node ~/zylos/.claude/skills/multica/scripts/multica.js issue list --output json
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment add MUL-123 --content "Update"
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment list MUL-123 --thread <comment-id> --tail 30
node ~/zylos/.claude/skills/multica/scripts/multica.js chat history --task <task-id> --limit 20
```

`chat history` requires the task id from the active chat card. The bridge keeps
that task's scoped token in a private mode-0600 file and deletes it after a
successful complete/fail callback; the component PAT cannot access this API.

Comments added with the component PAT are attributed to its member actor. If
the issue is assigned to the same agent, `issue comment add` can dispatch a new
comment task back to that agent. Avoid calling it from an automatic same-issue
handler unless an explicit trigger/loop guard prevents self-retriggering.

Inline description/content values decode `\\n`, `\\r`, `\\t`, and `\\\\` like
the official CLI. The `--description-file` / `--content-file` forms preserve
text and reject paths outside the current working directory (including symlink
escapes) unless `--allow-external-file` is explicitly passed.

## Migration from the reference bridge

Stop `zylos-multica-bridge` before starting this component so two processes do
not claim from the same runtime. Install with the same base URL, PAT, workspace
slug, and daemon ID; registration is idempotent. Keep the old bridge stopped
until the live issue and chat checks pass.

## Delivery latency

The bridge adopts the official daemon's wakeup WebSocket. After
registration it holds a wakeup WebSocket to `GET /api/daemon/ws`
(PAT-authenticated); when the server pushes a `daemon:task_available` or
`daemon:pending_work` hint, the poll loop wakes immediately and claims over
the existing HTTP claim path, so delivery is near-instant while claiming
semantics are unchanged. (The official daemon can additionally negotiate a
`tasks.claim` RPC over this socket; the bridge deliberately keeps claiming
on HTTP — a supported official fallback — to avoid the double-claim race
surface that WS-first claiming has to manage.) The `poll_interval_s` loop keeps running as the
fallback delivery path: if the socket drops, the bridge reconnects with
jittered exponential backoff (1s → 30s, reset after 10s of stable
connection) and polling covers the gap. A silent socket is recycled after
60s without frames. Wakeup hints never shorten error backoff.

The wakeup socket needs the global `WebSocket` client (Node 22+). On older
Node runtimes the bridge logs one warning and stays poll-only.

## Operations

The service fails fast if the register response does not expose the registered
`zylos` runtime ID. Optional `repos` / `settings` fields may be absent or null.
Key delivery log messages are stable monitoring interfaces. PAT values are
never included in command arguments or normal logs.

This component has no browser-facing HTTP surface, so HTTP indexing controls do
not apply.

## Design Notes

Development-time architecture notes live in [docs/DESIGN.md](./docs/DESIGN.md).

## License

[MIT](./LICENSE)
