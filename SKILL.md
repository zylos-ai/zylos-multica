---
name: multica
version: 0.2.21
description: >
  Multica task-platform communication channel for Zylos agents. Use when a
  Multica deployment dispatches issue or chat work into the live agent session,
  or when the agent needs to complete, fail, or report progress on that work.
type: communication

lifecycle:
  npm: true
  service:
    type: pm2
    name: zylos-multica
    entry: src/main.js
  data_dir: ~/zylos/components/multica
  hooks:
    configure: hooks/configure.js
    post-install: hooks/post-install.js
    pre-upgrade: hooks/pre-upgrade.js
    post-upgrade: hooks/post-upgrade.js
  preserve:
    - config.json
    - logs/

upgrade:
  repo: zylos-ai/zylos-multica
  branch: main

config:
  required:
    - name: MULTICA_BASE_URL
      description: Multica deployment base URL
    - name: MULTICA_PAT
      description: Multica personal access token
      sensitive: true
    - name: MULTICA_WORKSPACE_SLUG
      description: Workspace slug as shown in the Multica web URL (e.g. zylos-lab)
    - name: MULTICA_RUNTIME_NAME
      description: Runtime display name, normally the agent name followed by (zylos)
  optional:
    - name: MULTICA_DAEMON_ID
      description: Existing daemon UUID to preserve during bridge migration; generated when omitted
    - name: MULTICA_POLL_INTERVAL_S
      description: Polling interval in seconds
      default: "15"

dependencies:
  - comm-bridge
  - scheduler
---

# Multica

Requires a Zylos core containing zylos-core #762 (merge `e1b298f`) or a later
official core release for scheduler `list --json` due-date reconciliation.
Older cores keep ordinary Multica delivery available but log a reconciliation
warning.

Normal replies to a Multica card complete its task through the standard C4
reply route. Use the supplemental reporter only for progress or failure:

```bash
node ~/zylos/.claude/skills/multica/scripts/report.js progress <task-id> "<status>"
node ~/zylos/.claude/skills/multica/scripts/report.js fail <task-id> "<reason>"
```

Media replies are not supported in v0.2.21; send text instead.

Quick-create tasks are translated directly into one issue after task validation:
the bridge starts the task, creates exactly one issue with origin and pre-uploaded
attachment IDs, then completes the task. It never retries the non-idempotent
issue create request.

The first business CLI slice mirrors the official command grouping while using
this component's protected local config (the PAT never appears in argv):

```bash
node ~/zylos/.claude/skills/multica/scripts/multica.js issue create --title "Title" --description "Body"
node ~/zylos/.claude/skills/multica/scripts/multica.js issue get MUL-123
node ~/zylos/.claude/skills/multica/scripts/multica.js issue list --output json
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment add MUL-123 --content "Update"
node ~/zylos/.claude/skills/multica/scripts/multica.js issue comment list MUL-123 --thread <comment-id> --tail 30
node ~/zylos/.claude/skills/multica/scripts/multica.js chat history --task <task-id> --limit 20
```

`chat history` works only while the referenced chat task is active. The bridge
stores its task-scoped token in a private mode-0600 file and removes it after a
successful `complete` or `fail`; the component PAT is never used for chat
history.

`issue comment add` writes as the component PAT owner's member actor. On an
issue assigned to this same agent, that comment can dispatch another comment
task back to the agent. Do not call it from an automatic same-issue handling
loop unless the workflow has an explicit trigger/loop guard.
