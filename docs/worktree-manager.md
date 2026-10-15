> Historical design, superseded by [Agent-owned resources](agent-owned-resources.md) in #44. The commands and automatic Git workflow below are no longer active. Retained for prior-version evidence.

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

Repeat `--baseline` for every resource in the **old** run. Both tasks must already have local
bindings (the target's blocked preparation creates its binding). Select the old
`base_commit` to restart from the original input, or an independently verified
commit to carry forward committed work. No implicit “latest”, branch name, dirty
snapshot, reset, stash, commit, deletion or push occurs. All old tracked edits,
untracked/ignored files, directories, branches and commits stay in place. The
old lifecycle report stays **confirmed fail**; normal confirmed delivery heads
are not changed. Every old **worktree** resource must match a target resource by
identity, source, mode, ref and workline; ordering is irrelevant. The target may
add resources, including a private repository, which use normal preparation and
host Git authentication. Additions need no old-run baseline. Removed/replaced
shared resources, `in_place` shared resources, same-task generation replacement,
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
commit and prepares every added resource before confirming the original claim
and delivering the normal task card. Added-resource failure follows the bounded
preparation-failure policy below; only target-owned occupancy is released, and
the old failed run and its artifacts stay unchanged. Recovery
is not task admission; follow `begin` on that card as usual.

Tests cover real local dispatcher/state/worktree execution against a controlled
Server request fixture, dirty artifact retention, commit selection, rejection
controls, duplicate/concurrent calls, every recovery write boundary, and an
actual SIGKILL with replay. They do not claim live Server/C4 acceptance, Piper
host recovery or Git authentication verification; deployment and live recovery
remain separate operator gates.


## Failed preparation and operator abandon (#42)

Git authentication/authorization, missing repositories and invalid refs fail
immediately. Network/timeouts and unclassified preparation errors get at most
three attempts with persisted minimum backoff of 15 then 30 seconds; the normal
poll cadence may make delays longer. Backoff continues renewing preparation
leases. Busy worklines, active/interrupted operations, unconfirmed subprocess
stop, service shutdown and lease failure do not spend this budget. C4 handoff or
start-confirmation errors keep their existing reconciliation path.

Failure to materialize required task context terminates immediately: an
incomplete context cannot be delivered safely, and raw claims containing tokens
are never persisted as retry input. Retained context and task files remain for
diagnosis. Git diagnostics are reduced to fixed reason categories and a safe
resource identifier; raw stderr/URLs are not copied into reports or logs.

An operator may terminate an unstarted, undelivered task explicitly:

```sh
node scripts/task.js abandon <task-id@generation> --reason 'preparation cannot proceed'
```

The reason is frozen; repeat the identical command after interruption. It first
closes begin/preparation admission durably, then releases only exact-generation
owned workline/path locks after acquiring the stopped preparation operation
slot. Normally exited Git preparation has already released its cache lock.
Active or interrupted operations and retained cache locks remain blocked until
existing explicit stop verification/recovery is performed. Abandon never kills
processes, deletes worktrees/branches/files, chooses a baseline, or clears another
run's ownership. An identical completed abandonment remains idempotent even
when later tasks own the workline. Pending recovery transfers must be replayed
before abandonment; completed transfers can release only the target's ownership.

After safe local release, the bridge uses the original claim-aware `start`
solely to report `fail` with `environment_prepare_failed` (v0.6.2 nonretryable
Server reason). It never delivers a card or admits execution. A lost/stale start
or uncertain terminal response remains pending with the original claim and
frozen reason. Existing fail reconciliation never blindly repeats an attempted
fail POST. Local capacity can therefore be free while Server confirmation is
still pending; inspect the lifecycle report before claiming remote completion.

Durable intent, binding phase and marked abandonment operation slots allow
restart replay after partial local release. Tests use actual Git, worktrees,
CLI/HTTP fixtures and SIGKILL, including Core→Core+docs recovery and subsequent
cycles. Private-repository transport and Server responses in integration tests
are controlled fixtures, not live fleet acceptance.
