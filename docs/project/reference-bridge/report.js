#!/usr/bin/env node
/**
 * report.js — Luna 对 Multica 任务的一条命令回报。
 * 用法: report.js <complete|fail|progress> <task_id> <text>
 * 凭证直连 Multica(不经 bridge 进程) — bridge 崩溃不阻断回报。
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_PATH = path.join(os.homedir(), "zylos/components/multica-bridge/config.json");

async function main() {
  const [action, taskId, ...rest] = process.argv.slice(2);
  const text = rest.join(" ").trim();
  const usage = "usage: report.js <complete|fail|progress> <task_id> <text>";
  if (!taskId || !text || !["complete", "fail", "progress"].includes(action)) {
    console.error(usage);
    process.exit(2);
  }
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const bodyByAction = {
    complete: { output: text },
    fail: { error: text },
    progress: { summary: text },
  };
  const res = await fetch(`${cfg.base_url}/api/daemon/tasks/${taskId}/${action}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.pat}`, "Content-Type": "application/json" },
    body: JSON.stringify(bodyByAction[action]),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`FAILED: ${action} ${taskId} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`OK: task ${taskId} ${action} reported`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
