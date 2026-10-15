# Task execution and terminal report state

This slice implements local state and reporting. The bridge coordinator must opt into it; it does not advertise newer protocol capabilities or change the installed service.

Runtime files use `~/zylos/components/multica/task-state/`: one private JSON record and OS mutex file per hashed server/workspace/task identity. Pending payload, original claim, delivery card and confirmation evidence live in that record. Task tokens remain under `components/multica/task-tokens/`. Work repositories belong under the coordinator's workspace root; this module creates no repository or top-level state directory. Files are mode 0600, state directory 0700. Atomic saves fsync the file before rename and fsync the directory. Records never copy claim auth tokens or configuration credentials.

The host needs util-linux `flock` and a POSIX shell. Missing flock fails explicitly; no automatic installation. The subprocess holds a kernel lock only during a state/report operation. Reporter exit closes its pipe and releases this mutex. This is entirely separate from execution occupancy: a dead reporter or released mutex never means the agent or its commands have stopped.

## Coordinator API

`createTaskState(config, {root?, request?, removeTaskToken?})` requires the resolved workspace UUID. `request` has the existing multicaRequest signature; `includeHeaders:true` returns `{data,headers}` with lowercase header names.

- `registerClaim(task)` atomically records original task/workspace/agent/runtime and precise dispatched_at, returning a UUID generation. A repeated identical claim returns the same generation. A changed claim for the same task is rejected; this implementation never silently rotates a generation. Retry children have separate task IDs.
- `get(taskId)` and `list()` return persisted records; `assertCurrent({taskId,generation,requireRunning})` guards preparation or execution. It rejects frozen reports and quiesced execution.
- `setDelivery(taskId,generation,{content,endpoint,dueAt?})` freezes a credential-free card and `taskId@generation` route before delivery. Repeating the same card is safe; changing it is rejected.
- `start(taskId,generation)` sends the exact original runtime_id/dispatched_at. A successful matching running response confirms start; an uncertain response keeps execution blocked. Ordinary response timestamps lose microseconds and are never compared with or substituted for the original claim.
- `markDelivered` requires confirmed start. `markAccepted` returns false for duplicate execution acceptance, independent of uncertain delivery receipts. A restarted coordinator can redeliver an unaccepted frozen card without launching another accepted execution.
- `markQuiesced` is an explicit assertion from the coordinator AFTER the worktree manager has drained commands and the live session has acknowledged it stopped. This module cannot prove native editor activity has ended.
- `report(taskId,generation,action,payload)` requires confirmed start and quiescence. It freezes complete/fail payload before any terminal POST. The same task cannot change that payload. A response is confirmed only by matching identity, terminal status and result fields, not HTTP 200 alone.
- `reconcile(taskId,{generation,replay:false})` queries authoritative history. `replay:true` requires the current generation and may retry only frozen complete, at most three total POST attempts with exponential minimum delay. It first requires running history and re-confirms the original exact claim through generation-aware start. Fail is never blindly replayed. Old callers may request readback but cannot POST.

On restart, inspect `list()`: frozen reports are reconciled, not re-executed. Final results are persisted before token deletion. Cleanup failures retain a flag and never repeat the result POST. Confirmed/conflict/superseded records remain private evidence alongside their original payload. They do not authorize worktree deletion. Missing/inaccessible/paginated-away history remains pending. No stale PID, local TTL or status-only response clears execution occupancy.

## CLI

New task cards carry `task_id@generation` endpoints. `send.js <endpoint> <text>` confirms completion; `report.js fail <endpoint> <text>` reports failure. Both preserve text whitespace. `report.js reconcile <endpoint>` reads back pending results and may perform the bounded exact-claim complete replay described above. A pending/conflict/superseded outcome exits nonzero and gives a recovery command; it is never printed as completed.

Legacy task IDs remain usable for progress only when they have no durable binding. Terminal calls without a generation fail with an explicit recovery instruction rather than guessing the active generation. The coordinator is responsible for sending the correct new endpoint and quiescing work before final reporting.

## Validation boundaries

Local tests cover actual filesystem state, subprocess/HTTP paths, kernel-lock crash release, pending-before-POST, response loss/readback, pagination, permissions, result conflict, timestamp precision, duplicate delivery/acceptance, stale generation rejection, quiescence and token cleanup. Mutation checks remove key guards to prove those tests reject known-bad behavior. These are not live Multica expiration, browser visibility or destructive live-session tests. Complete has no server-side claim fence; the start check and completion are separate requests, and local locks cannot constrain unrelated clients.
