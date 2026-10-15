# Agent-owned resource access (#44)

The component transports task context and lifecycle events. It never prepares
repositories, invokes Git, chooses an access method, or verifies a working directory.
Official Multica Server behavior is unchanged.

Before: claim → snapshot → clone/fetch/worktree preparation + prepare lease →
claim-aware start → C4 → begin → bound exec → Git-based quiesce → result.

Now: claim → snapshot → claim-aware start → C4 → begin → Agent chooses authorized
access and work directories → Agent stops its work → explicit quiesce → result.
Missing Git credentials therefore cannot prevent task delivery. Context storage,
claim identity, and Server start remain required. The Agent reports a concrete
access blocker if its available tools cannot complete the work.

## Commands and result metadata

Run `task.js begin task@generation` before work. Only `accepted: true` admits work;
false means duplicate delivery. Use native Agent tools for all commands and edits.
The component neither launches nor cancels those processes. Track the task's tools,
children and background jobs; stop or await all of them before acknowledging stop:

```
node scripts/task.js quiesce task@generation --stopped --work-dir /chosen/path --branch chosen-branch --pr-url https://example.test/pr/1
```

Metadata flags are optional and describe actual Agent work. For API-only work,
omit filesystem metadata. The component does not derive metadata from historical
bindings or inspect Git. Completion sends the explicit metadata with output;
failure sends work_dir/branch_name with error (Server failure schema has no pr_url).
For multiple repositories, describe each directory/ref/result in the final text.
Use the attached C4 route to complete, `report.js fail` to fail, and
`report.js reconcile` to recover an uncertain frozen result. Report retries retain
exact task/generation/runtime/claim and result matching. Cancellation is observed
through existing Server reconciliation; there is no new process cancellation API.

`task.js inspect task@generation` shows lifecycle state and read-only legacy
bindings/operation markers. `exec`, `locate` and `recover` are retired with explicit
guidance; choose tools and continuation locations yourself. `abandon` is for an
unstarted, undelivered task only and requires `--reason text --stopped` after
verification that old preparation and task processes have stopped.

## Existing installations and retained work

Upgrade/deployment remains an owner-authorized operation. Stop the old service and
verify old helper/Git process groups and Agent work have stopped before activating
the new version. PID age, a restart, or a stale operation marker alone does not
prove stop. No file, branch, binding, owner record, operation marker, report, or
repository is removed by migration. Downgrading requires checking these retained
records and newer task activity; old owner records are not made safe by a downgrade.

- **Prepared, not accepted:** reuse the same claim/generation. Replace the frozen
  card with Agent-owned instructions; preserve the original under delivery_history.
  Historical paths remain hints to inspect, not verified or exclusively owned work.
- **Unfinished preparation:** resume context/start/delivery without retrying Git or
  interpreting old retry counters as new access failures. The old snapshot stays
  intact; the new card includes its resource data. If old preparation was interrupted,
  the Agent must verify stop before reusing those paths.
- **Already accepted:** no automatic redelivery or repeated begin. Continue the
  accepted work using native tools; inspect retained records and acknowledge stop
  using the new command before reporting. Old queued cards do not revive exec.
- **Frozen preparation failure or terminal report:** preserve the decision and
  reconcile it; never turn it into success or resume its business work. An old
  operation marker or unconfirmed command blocks automatic preparation-failure
  finalization until explicit `abandon ... --stopped` acknowledgement. Historical
  ownership markers stay in place; this version does not use them to gate new work.
- **Confirmed failure:** create/dispatch a new continuation task. Keep the original
  result and files. Agent decides whether to reuse, copy, fetch, or use an authorized
  API, and verifies that the selected paths are safe. The component does not transfer
  Git baselines or manufacture replacement task identities.

Piper B1/C2: the old confirmed authentication failures remain failed. Following
separate production upgrade authorization, request new dispatches, run begin once,
and let Piper select its available authorized API or Git access. If access is still
insufficient, report the blocker from the admitted task. Reuse old artifacts only
after checking their provenance and that previous work stopped. This change has
local fixture coverage, not production acceptance or deployment authorization.

## Historical code and tests

`src/lib/worktrees.js`, `worktree-cli.js`, and `preparation-failure.js` are dormant
historical implementation modules with no supported runtime imports/callers.
The corresponding prior Git-manager suites are retained under `historical/` as
`.history.js` reference files. They document the old workflow, are excluded from
normal test discovery, and do not validate the new Agent-owned workflow.
