#!/usr/bin/env node
/**
 * zylos-multica-bridge — 把 Luna 挂成 Multica 的 "zylos" runtime。
 * 方案: pages docs/zylos-multica-bridge (+bridge-core / bridge-delivery 模块文档)
 *
 * 主循环: register → { heartbeat → claim → 投递(C4/scheduler) → start } 循环。
 * 无状态: 崩溃重启只需重新 register(幂等)。投递失败不 start, 任务留在
 * dispatched 等服务端 recovery 窗口重派 — 不自建重试。
 */
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CONFIG_PATH = path.join(os.homedir(), "zylos/components/multica-bridge/config.json");
const C4_RECEIVE = path.join(os.homedir(), "zylos/.claude/skills/comm-bridge/scripts/c4-receive.js");
const REPORT_PATH = path.join(os.homedir(), "zylos/components/multica-bridge/report.js");

const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const BACKOFF_STEPS_S = [15, 60, 300];

let runtimeId = null;
let backoffIdx = -1; // -1 = healthy

const log = (level, msg, extra) =>
  console.log(`${new Date().toISOString()} ${level} ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);

async function api(method, apiPath, body, opts = {}) {
  const res = await fetch(cfg.base_url + apiPath, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.pat}`,
      "Content-Type": "application/json",
      ...(opts.workspaceHeader ? { "X-Workspace-Id": cfg.workspace_id } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`${method} ${apiPath} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function register() {
  const resp = await api("POST", "/api/daemon/register", {
    daemon_id: cfg.daemon_id,
    workspace_id: cfg.workspace_id,
    device_name: "dgx-zylos-bridge",
    cli_version: "zylos-bridge/1.0.0",
    runtimes: [
      {
        type: cfg.runtime.type,
        name: cfg.runtime.name,
        version: cfg.runtime.version,
        status: "online",
      },
    ],
  });
  const rt = (resp.runtimes || []).find((r) => r.provider === cfg.runtime.type);
  if (!rt) throw new Error(`register response missing '${cfg.runtime.type}' runtime: ${JSON.stringify(resp).slice(0, 300)}`);
  runtimeId = rt.id;
  log("INFO", "registered", { runtime_id: runtimeId });
}

function c4Deliver(content, endpoint) {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      // --no-reply: 回报走 report.js CLI 而非 c4-send, 无 reply 路由 (也因此免 channel 目录校验)
      [C4_RECEIVE, "--channel", "multica", "--endpoint", endpoint, "--no-reply", "--content", content],
      { timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) log("ERROR", "c4 deliver failed", { endpoint, stderr: String(stderr).slice(0, 200) });
        resolve(!error);
      }
    );
    child.on("error", () => resolve(false));
  });
}

function buildTaskCard(task, issue) {
  const title = issue?.title || task.thread_name || "(无标题)";
  const desc = (issue?.description || "").trim();
  // claim 响应不含 attribution — 派发人从 issue 侧取, 取不到则不显示该行
  const initiator = task.attribution?.initiator?.name || issue?.creator?.name || issue?.created_by_name || null;
  return [
    `[Multica 任务] ${title}`,
    `${initiator ? `派发人: ${initiator} · ` : ""}任务ID: ${task.id}`,
    ``,
    desc || "(无描述 — 以标题为任务内容)",
    ``,
    `—— 完成后回报（必做其一，直接运行）:`,
    `node ${REPORT_PATH} complete ${task.id} "<结论>"`,
    `node ${REPORT_PATH} fail ${task.id} "<原因>"`,
    `长任务(>30min)中途至少一次: node ${REPORT_PATH} progress ${task.id} "<阶段>"`,
  ].join("\n");
}

async function fetchIssue(issueId) {
  try {
    return await api("GET", `/api/issues/${issueId}`, undefined, { workspaceHeader: true });
  } catch (e) {
    log("WARN", "issue fetch failed, card will use thread_name only", { issue_id: issueId, err: e.message });
    return null;
  }
}

/** due date 在未来 → 走 scheduler 定时（分流规则的唯一例外） */
function futureDueDate(issue) {
  const due = issue?.due_date || issue?.dueDate;
  if (!due) return null;
  const t = Date.parse(due);
  return Number.isFinite(t) && t > Date.now() + 60_000 ? new Date(t) : null;
}

function scheduleDeliver(card, task, dueAt) {
  return new Promise((resolve) => {
    const schedulerCli = path.join(os.homedir(), "zylos/.claude/skills/scheduler/scripts/cli.js");
    execFile(
      "node",
      [schedulerCli, "add", card, "--at", dueAt.toISOString(), "--name", `multica-task-${task.id.slice(0, 8)}`, "--reply-channel", "multica", "--reply-endpoint", task.id],
      { timeout: 20_000 },
      (error, _stdout, stderr) => {
        if (error) log("ERROR", "scheduler add failed, falling back to direct C4", { stderr: String(stderr).slice(0, 200) });
        resolve(!error);
      }
    );
  });
}

/** 聊天卡: complete 的 output 会作为 Luna 的回复气泡写回 Multica 聊天 (writeChatCompletionOutcome) */
function buildChatCard(task) {
  const attachments = (task.chat_message_attachments || []).map((a) => a.filename).filter(Boolean);
  const lines = [
    `[Multica 聊天] ${task.thread_name || "(新会话)"}`,
    `会话ID: ${task.chat_session_id} · 任务ID: ${task.id}`,
    ``,
    task.chat_message || "(空消息)",
  ];
  if (attachments.length) lines.push(``, `(随消息附件, 暂不支持拉取: ${attachments.join(", ")})`);
  lines.push(
    ``,
    `—— 这是对话不是任务: 直接把回复内容作为 complete 的结论提交, 它会原样显示为你的聊天气泡（尽快回复）:`,
    `node ${REPORT_PATH} complete ${task.id} "<回复内容>"`,
    `无法回复时: node ${REPORT_PATH} fail ${task.id} "<原因>"`
  );
  return lines.join("\n");
}

async function handleTask(task) {
  // 聊天任务 (Web Chat UI): chat_session_id 非空, issue_id 为空 — 不是 quick-create。
  // claim 响应直接带用户原文 (chat_message), 不需要取 issue。
  if (task.chat_session_id) {
    const delivered = await c4Deliver(buildChatCard(task), task.id);
    if (!delivered) {
      log("WARN", "chat delivery failed, leaving task dispatched", { task_id: task.id });
      return;
    }
    await api("POST", `/api/daemon/tasks/${task.id}/start`, {});
    log("INFO", "chat task delivered and started", { task_id: task.id, chat_session_id: task.chat_session_id });
    return;
  }
  // quick-create 是元任务（期望 runtime 自己跑 `multica issue create` 把 prompt 转成 issue）,
  // zylos 桥不支持 — 明确 fail 并引导正确用法, 而不是投递一张空卡。
  if (!task.issue_id) {
    await api("POST", `/api/daemon/tasks/${task.id}/fail`, {
      error:
        "zylos runtime (Luna) does not handle quick-create meta-tasks. Please create an issue and assign it to the Luna agent instead — the issue title/description will be delivered into Luna's live session.",
    });
    log("INFO", "meta-task rejected with guidance", { task_id: task.id });
    return;
  }
  const issue = await fetchIssue(task.issue_id);
  const card = buildTaskCard(task, issue);
  const dueAt = futureDueDate(issue);

  let delivered;
  if (dueAt) {
    delivered = await scheduleDeliver(card, task, dueAt);
    if (!delivered) delivered = await c4Deliver(card, task.id); // scheduler 故障时降级直投
    log("INFO", "task scheduled", { task_id: task.id, due_at: dueAt.toISOString() });
  } else {
    delivered = await c4Deliver(card, task.id);
  }

  if (!delivered) {
    // 不 start — 任务留在 dispatched, 服务端 recovery 窗口后重派
    log("WARN", "delivery failed, leaving task dispatched for server-side redispatch", { task_id: task.id });
    return;
  }
  await api("POST", `/api/daemon/tasks/${task.id}/start`, {});
  log("INFO", "task delivered and started", { task_id: task.id });
}

async function tick() {
  if (!runtimeId) await register();
  await api("POST", "/api/daemon/heartbeat", { runtime_id: runtimeId });
  const resp = await api("POST", "/api/daemon/tasks/claim", {
    daemon_id: cfg.daemon_id,
    runtime_ids: [runtimeId],
    max_tasks: 1,
  });
  for (const task of resp.tasks || []) {
    log("INFO", "task claimed", { task_id: task.id, issue_id: task.issue_id });
    await handleTask(task);
  }
}

async function main() {
  log("INFO", "bridge starting", { base_url: cfg.base_url, daemon_id: cfg.daemon_id });
  for (;;) {
    try {
      await tick();
      if (backoffIdx >= 0) log("INFO", "recovered from backoff");
      backoffIdx = -1;
    } catch (e) {
      backoffIdx = Math.min(backoffIdx + 1, BACKOFF_STEPS_S.length - 1);
      const level = e.status === 401 ? "ERROR" : "WARN";
      log(level, `tick failed (backoff ${BACKOFF_STEPS_S[backoffIdx]}s)${e.status === 401 ? " — PAT revoked? manual action needed" : ""}`, { err: e.message });
      runtimeId = null; // 退避恢复后重新 register(幂等)
    }
    const delayS = backoffIdx >= 0 ? BACKOFF_STEPS_S[backoffIdx] : cfg.poll_interval_s;
    await new Promise((r) => setTimeout(r, delayS * 1000));
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
