# Task worktree manager (#30)

This is an integration module for the live-session bridge, not a runtime launcher.
The coordinator uses it for claim-aware task processing; it does not advertise
`local-worktree-v1`. Local shared-Git metadata behavior remains subject to the
owner's implementation choice; tests only use disposable fixture repositories.

## Storage and source effects

- Runtime metadata: `~/zylos/components/multica/execution/{bindings,operations,owners,heads}/`.
  SKILL preserves `execution/` across upgrades. JSON files use 0600; newly created
  directories use 0700. Metadata contains no task token or command argv.
- Work content: `~/zylos/workspace/multica/tasks/<task hash>/<generation hash>/<resource hash>/`
  holds worktrees and private snapshot indexes. `~/zylos/workspace/multica/repos/<URL hash>/`
  holds bare caches for claim-resolved Git repositories. Existing repositories are
  not moved. Both roots can be injected for isolated tests.
- `local_directory/worktree` currently uses standard shared Git metadata: original
  source worktree files and its index remain unchanged, but the source Git object
  database receives snapshots, `refs/zylos/snapshots/...` pins those snapshots,
  `refs/heads/zylos/...` identifies task branches, and Git registers worktree admin
  files under its common Git directory. Git may create normal temporary/lock files.
  This is not “no writes to the original repository.” A fully controlled copy
  instead requires a separate object transfer/cache plus dirty-content transfer,
  duplicates disk use, and needs an explicit way to import/push delivered branches.
- `in_place` uses only the declared directory, with realpath-based exclusion. The
  directory remains externally owned. Ancestor/descendant paths conflict; siblings
  remain independent. A shared exclusive coordination file makes path inspection
  and ownership publication atomic across processes. An interrupted coordination
  holder requires explicit stop acknowledgement before recovery. No worktree, branch or source snapshot is
  created for this mode. Unknown modes are rejected; omitted mode means in_place,
  matching the pinned server. Leader tasks skip local-directory assignment,
  following the pinned upstream; claim-resolved repository resources remain available.
  This does not implement squad orchestration.

There is no automatic deletion, reset, pruning, garbage collection, commit of
agent work, or push. Snapshot commits only capture source input; task changes are
committed by the execution agent when appropriate. Ignored untracked files are
excluded; tracked/force-staged files are preserved. Untracked inputs are bounded
at 2000 files / 200 MiB, excluding upstream-generated `.agent_context`/`.multica`
sidecars. File content/index preservation tests do not claim that Git refs and
objects stay unchanged.

## Coordinator API

`createWorktreeManager({config,lifecycle,dataDir?,workRoot?,git?})` requires the
lifecycle API's synchronous `assertCurrent({taskId,generation,requireRunning})`
and `get(taskId)`; explicit recovery also requires `withRecovery` for paired
lifecycle locking and existing prepare-lease validation. The coordinator registers the immutable generation; this
manager never invents or replaces it.

- `await prepare(task, resources?, {generation,signal})` resolves claim resources
  by default, acquires all workline/path ownership in stable order, and prepares
  each independent binding. Resource mode/ref changes create a new workline rather
  than silently continuing a commit from an older resource configuration. Busy raises `WorktreeBusyError` immediately; the
  coordinator keeps the server preparation lease and retries. On acquisition
  failure, only newly acquired locks from that attempt are released, before Git
  mutation. Preparation failures retain bindings/owned content for recovery.
- `inspect(taskId)` is a read-only local record query. `await locate(taskId,
  generation,resourceId)` checks lifecycle running admission, workline/path owner,
  real cwd, Git root/common directory and branch. It returns the exact binding.
- `await run(taskId,generation,resourceId,argv,{signal?})` runs one command with
  explicit cwd (no shell-string interpolation), records durable running/exited
  status, and returns output/exit status/cwd/branch. One task operation is allowed
  at a time, including across processes. The running gate is checked again after
  asynchronous Git validation and immediately before command spawn.
- `await cancelCommands(taskId,generation)` stops commands owned by this manager
  instance and waits for their exit. It cannot prove another process's command
  stopped and never releases workline ownership or substitutes for live-session
  stop acknowledgement. On Unix each command/Git operation has its own process
  group; cancellation retains TERM→KILL escalation even if the direct child closes
  early, then confirms no live descendants remain (Linux /proc group check;
  zombies cannot write). Normal command close also checks the process group:
  redirected background descendants leave a durable `stop_unconfirmed` record and
  retain occupancy. They are not automatically killed on normal close; after
  independently confirming they stopped, use explicit recovery acknowledgement.
  Unknown group termination keeps execution blocked.
- `await quiesce(taskId,generation,{acknowledgedStopped:true})` requires the live
  session to confirm it will perform no further native writes, and rejects any
  running/unknown command. It records worktree Git status/commit, preserves dirty
  artifacts, and releases only shared in_place path occupancy. Workline ownership
  remains until confirmed delivery; the coordinator then calls lifecycle
  `markQuiesced`. Native tool usage is convention-based, not a security sandbox.
- `await confirmDelivery(taskId,generation)` requires lifecycle report state
  `confirmed`/action `complete`, quiescence and clean unchanged committed worktree
  output. It updates confirmed line heads and releases line occupancy. A successor
  gets a new directory/branch from that immutable commit. Changed user source
  since the prior snapshot or dirty delivery requires an explicit baseline choice;
  it is never silently discarded or merged. in_place has no reusable commit head.
- `acknowledgeStopped(taskId,generation,{acknowledgedStopped:true})` is an explicit
  recovery action after independently confirming prior execution/preparation is
  stopped. It clears unknown command/operation records, retaining all artifacts.
  It refuses active operations in this manager. No PID, TTL or platform-cancelled
  status is treated as proof that an older process stopped.

Git preparation is asynchronous, has a 120-second operation timeout and accepts
coordinator cancellation. The coordinator's 15-second lease timer must remain
active through preparation and generation-aware start. Normal preparation does not call platform start/claim/lease APIs itself;
explicit recovery validates a preparation lease through the lifecycle provider. Only the coordinator may enable executable
C4 delivery after start is confirmed. `worktree-cli.js` exports the parsing helper
for coordinator wiring (`locate`, `exec`, `quiesce`, `inspect`); it does not add a
standalone runtime or service.

## Evidence and remaining integration

Tests use real temporary Git repositories for dirty-source/index preservation,
separate worktrees, same-line and in_place exclusion, confirmed continuation,
interrupted preparation recovery, stale/start admission, command quiescence,
repo cache resolution and CLI cwd. Timer/cancellation tests cover nonblocking Git
preparation. These are local fixtures, not live Multica/C4 E2E acceptance. Source
contracts: pinned v0.6.2 `daemon/local_directory.go`, `execenv/local_worktree.go`,
`handler/project_resource.go:430–461`. No capability/version changes are made.

## Explicit failed-run recovery (#39)

Use this only after the operator has verified **both execution and preparation
are stopped** for the failed run and the target continuation. Stop proof includes
native edits, background helpers and registered commands; `--stopped` acknowledges
that proof, it does not stop processes. Ordinary active/interrupted operation or
Git preparation slots are rejected, never cleared by this command.

```sh
node scripts/task.js inspect <old-task-id>
node scripts/task.js inspect <target-task-id>
node scripts/task.js recover <old-task-id@generation> \
  --to <target-task-id@generation> \
  --baseline <resource-id>=<full-40-character-commit> --stopped
```

Repeat `--baseline` for every resource. Both tasks must already have local
bindings (the target's blocked preparation creates its binding). Select the old
`base_commit` to restart from the original input, or an independently verified
commit to carry forward committed work. No implicit “latest”, branch name, dirty
snapshot, reset, stash, commit, deletion or push occurs. All old tracked edits,
untracked/ignored files, directories, branches and commits stay in place. The
old lifecycle report stays **confirmed fail**; normal confirmed delivery heads
are not changed. This initial operation supports matching sets of **worktree**
resources only; `in_place`, changed resources, same-task generation replacement,
unprepared source bindings and already-started targets are refused.

The target must have the same workspace/daemon/agent and Issue or chat identity.
A fresh existing `prepare-lease` call checks its remote runtime/identity and
preparing status. The exact original claim's microsecond timestamp is still
checked by the normal Server `start` call after preparation: recovery does not
start a task or bypass admission. No new Server endpoint is required. A remote
claim can change after the lease check; normal start then refuses execution.

`recover()` takes the two lifecycle locks, a recovery OS mutex and both task
operation slots. It validates every resource/owner/baseline before writing a
recovery decision into the old binding. It then records target baselines and a
pending gate, atomically replaces owner records (never leaving an unlocked gap),
marks the old decision transferred, and finally unblocks target preparation.
Writes fsync data and directory entries. Exact retries are idempotent; changed
choices are rejected. A crash retains the decision and all content. Replay the
**identical command** after confirming stopped work; only this recovery's marked
operation slots can be reclaimed under its OS mutex. An interrupted ordinary
preparation is not reclassified as recovery. Do not delete locks manually.

The bridge's next normal retry prepares a fresh directory/branch at the explicit
commit, confirms the original claim, and delivers the normal task card. Recovery
is not task admission; follow `begin` on that card as usual.

Tests cover real local dispatcher/state/worktree execution against a controlled
Server request fixture, dirty artifact retention, commit selection, rejection
controls, duplicate/concurrent calls, every recovery write boundary, and an
actual SIGKILL with replay. They do not claim live Server/C4 acceptance, Piper
host recovery or Git authentication verification; deployment and live recovery
remain separate operator gates.
