# Business CLI coverage

Contract inventory: Multica v0.6.2, commit
`7ab92d7622ecd81d179a8d83ae2dea74835a5069`, `server/cmd/multica/cmd_*.go`.
Component version and daemon capability version remain independent; this change
does not claim full v0.6.2 protocol parity. Live server writes are unverified.

The inventory was read before implementation. Status below describes this PR.

| Official group | Commands | Scope |
| --- | --- | --- |
| issue | list, get, create, update, assign, status, children, pull-requests, runs, usage, search, run-messages, cancel-task, rerun | Implement |
| issue comment | list, add, update, delete, resolve, unresolve | Implement; preserve explicit task actor for add |
| issue label | list, add, remove | Implement |
| issue subscriber | list, add, remove | Implement |
| issue metadata | list, get, set, delete | Implement |
| issue property | list, set, unset | Implement |
| issue | reorder | Implement before/after/top/bottom with a paginated status/project column and suppress_run; concurrent changes can require a fresh read |
| issue | timeline/history | Implement including truncation warning and client-side filters |
| issue wakeup | list, get, runs | Implement read-only operations |
| issue wakeup | events, create, update, disable, trigger, delete, checkin | Deferred: checkin changes task completion semantics; recurring-rule and event/condition validation need dedicated lifecycle tests |
| chat | history, thread | Implement with explicit task-scoped authentication |
| attachment | download | Existing bounded task download |
| attachment | upload | Implement bounded multipart chat upload with explicit task token and controlled file paths |
| project | list, get, create, update, delete, status | Implement |
| project resource | list, add, update, remove | Implement |
| label | list, get, create, update, delete | Implement |
| property | list, get, create, update, archive, unarchive | Implement |
| agent | list, get, tasks, skills list | Implement query operations |
| agent | create, update, archive, restore, avatar, skills set/add, env get/set, copy, mcp | Excluded: query-only scope; env exposes credentials; copy/MCP manage runtime configuration |
| squad | list, get, member list | Implement query operations |
| squad | create, update, delete, member add/set-role/remove, activity | Excluded: query-only scope |
| workspace | list, get, create, update, member list/invite | Implement |
| workspace | switch, mcp list/add/update/remove | Excluded: component workspace selection remains protected configuration; MCP may contain secrets/runtime setup |
| daemon, runtime, runtime_profile, setup, plugin, skill, update | all | Excluded: managed runtime model incompatible with this live-session bridge |
| auth, login, config, version | all | Excluded: use component configuration and component lifecycle |
| repo, user, autopilot | all | Outside AGENTS business group scope; repository provisioning and execution automation are not implied |

New issue update/status/assign commands send `suppress_run: true` unless the
caller explicitly passes `--start`. `--no-start` is accepted; combining it with
`--start` is rejected. Reorder always sends `suppress_run: true` and requires
exactly one of before/after/top/bottom. Explicit execution commands rerun/cancel-task remain
named commands, never automatic consequences or retries. All writes are single
attempts. After a successful write, use the corresponding get/list command to
verify current server state before deciding whether another action is needed.

Name resolution must select one unambiguous candidate. Unknown and ambiguous
references fail before mutation. Files retain the controlled-directory rule.
No operation needs the official executable or PAT values in argv.

## Contract limits

- Run operations (`run-messages`, `cancel-task`) require full run UUIDs;
  official CLI short run ID resolution is not implemented.
- Property list/set output uses catalog rows, including stored values and
  option/member display names. The 11 property types enforce canonical values;
  setting an archived definition is rejected. Member lookup failure after a
  successful write falls back to raw actor references.
  Unset returns `{ "deleted": true }`; use list to read back the remaining values.
- Chat history/thread and attachment upload require an active task token, with
  no owner-PAT fallback. Complete/fail removes the token. Upload files must be
  regular and at most 100 MiB, within the current working directory unless
  `--allow-external-file` is explicitly requested; task downloads retain their
  separate task-directory and attachment-allowlist restrictions.
- Local fixtures and reject-path tests cover implementation behavior. No live
  business writes, deployment, or full protocol/official CLI parity are claimed.
  Component and advertised upstream capability versions are unchanged.
