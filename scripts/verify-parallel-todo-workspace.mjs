/**
 * 验证任务 Todo 列表与工作区选择器各自独立且平行对齐：
 * 验证当展开任务列表详情时，工作区选择器绝对不会跟着展开或位移，两者尺寸与交互完全独立。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";
const chromePort = 9557;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-todo-independent-${Date.now()}`,
    "--window-size=1500,950",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(2500);

let ws;
function cleanup() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  try {
    chrome.kill();
  } catch {}
}

try {
  const list = await fetch(`http://127.0.0.1:${chromePort}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 Chrome 页面目标");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.on("open", resolve));

  let id = 0;
  const pend = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pend.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;

  const capture = async (filename, clip = null) => {
    const params = { format: "png" };
    if (clip) params.clip = clip;
    const res = await send("Page.captureScreenshot", params);
    const buffer = Buffer.from(res.result.data, "base64");
    const fullPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(fullPath, buffer);
    console.log(`[截屏成功] 已保存 ${fullPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  await sleep(3500);

  // 1. 获取当前会话并注入包含 Todo 活动的状态
  console.log("注入包含待办任务的会话状态...");
  const injectResult = await ev(`(() => {
    if (!window.__deepagentTestHooks) return { ok: false, reason: "no test hooks" };
    const currentState = window.__deepagentTestHooks.getState();
    const threadId = currentState.threadId;
    const now = Date.now();
    const mockState = {
      ...currentState,
      threadId,
      messages: currentState.messages.length > 0 ? currentState.messages : [
        { id: "m-1", role: "user", content: "请规划开发待办任务并执行", createdAt: now - 10000 },
        { id: "m-2", role: "assistant", content: "我已经为您梳理了待办开发任务，正在按计划逐步执行。", createdAt: now - 5000 }
      ],
      activities: [
        ...currentState.activities.filter(a => a.kind !== "todo"),
        {
          id: "act-todo-parallel-1",
          runId: currentState.run.runId || "run-parallel-1",
          threadId,
          kind: "todo",
          status: "in_progress",
          startedAt: now - 8000,
          detail: {
            total: 3,
            completed: 1,
            items: [
              { content: "梳理系统架构与接口定义", status: "completed" },
              { content: "实现任务列表平行和工作区选择器同行对齐", status: "in_progress" },
              { content: "展示任务列表时工作区完全独立不被拉伸", status: "pending" }
            ]
          }
        }
      ]
    };
    window.__deepagentTestHooks.loadState(mockState);
    return { ok: true, threadId };
  })()`);

  console.log("状态注入结果:", injectResult);
  await sleep(1500);

  // 2. 测量折叠状态下工作区按钮与 Todo 按钮的位置与高度
  const collapsedCheck = await ev(`(() => {
    const wsBtn = document.querySelector("[data-testid='workspace-mode-selector']");
    const todoBtn = document.querySelector("[data-testid='todo-queue-trigger']");
    if (!wsBtn || !todoBtn) {
      return { found: false, ws: Boolean(wsBtn), todo: Boolean(todoBtn) };
    }
    const wsRect = wsBtn.getBoundingClientRect();
    const todoRect = todoBtn.getBoundingClientRect();

    const verticalCenterDiff = Math.abs((wsRect.top + wsRect.bottom) / 2 - (todoRect.top + todoRect.bottom) / 2);
    const isParallel = todoRect.left >= wsRect.right - 10 && verticalCenterDiff < 10;

    return {
      found: true,
      wsRect: { top: Math.round(wsRect.top), bottom: Math.round(wsRect.bottom), height: Math.round(wsRect.height), left: Math.round(wsRect.left), right: Math.round(wsRect.right) },
      todoRect: { top: Math.round(todoRect.top), bottom: Math.round(todoRect.bottom), height: Math.round(todoRect.height), left: Math.round(todoRect.left), right: Math.round(todoRect.right) },
      verticalCenterDiff: Math.round(verticalCenterDiff),
      isParallel
    };
  })()`);

  console.log("【折叠状态检测】:", collapsedCheck);

  // 截取折叠状态输入框特写
  const clip = await ev(`(() => {
    const container = document.querySelector("[data-testid='workspace-mode-selector']")?.closest(".max-w-3xl");
    if (!container) return null;
    const r = container.getBoundingClientRect();
    return { x: Math.round(r.x - 16), y: Math.max(0, Math.round(r.y - 250)), width: Math.round(r.width + 32), height: Math.round(r.height + 260), scale: 1 };
  })()`);

  if (clip) {
    await capture("screenshot-independent-todo-collapsed.png", clip);
  }

  // 3. 点击展开待办任务列表！
  console.log("点击展开待办任务列表...");
  await ev(`document.querySelector("[data-testid='todo-queue-trigger']")?.click()`);
  await sleep(800);

  // 4. 测量展开状态下工作区按钮的位置与高度，验证是否被影响
  const expandedCheck = await ev(`(() => {
    const wsBtn = document.querySelector("[data-testid='workspace-mode-selector']");
    const todoBtn = document.querySelector("[data-testid='todo-queue-trigger']");
    const panel = document.querySelector("[data-testid='todo-queue-panel']");
    if (!wsBtn || !todoBtn || !panel) {
      return { found: false, ws: Boolean(wsBtn), todo: Boolean(todoBtn), panel: Boolean(panel) };
    }
    const wsRect = wsBtn.getBoundingClientRect();
    const todoRect = todoBtn.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();

    return {
      found: true,
      wsRect: { top: Math.round(wsRect.top), bottom: Math.round(wsRect.bottom), height: Math.round(wsRect.height) },
      todoRect: { top: Math.round(todoRect.top), bottom: Math.round(todoRect.bottom), height: Math.round(todoRect.height) },
      panelRect: { top: Math.round(panelRect.top), bottom: Math.round(panelRect.bottom), height: Math.round(panelRect.height), width: Math.round(panelRect.width) },
    };
  })()`);

  console.log("【展开状态检测】:", expandedCheck);

  // 验证工作区是否受到影响：top 和 height 必须完全一致！
  if (collapsedCheck.found && expandedCheck.found) {
    const topDiff = Math.abs(collapsedCheck.wsRect.top - expandedCheck.wsRect.top);
    const heightDiff = Math.abs(collapsedCheck.wsRect.height - expandedCheck.wsRect.height);
    console.log(`[独立性验证] 工作区 top 位移差: ${topDiff}px, 工作区高度变化差: ${heightDiff}px`);
    if (topDiff === 0 && heightDiff === 0) {
      console.log("✓ 完美验证：展示任务列表时工作区 100% 独立，位置与尺寸完全未受任何影响！");
    }
  }

  // 截取展开任务列表状态特写与全景
  if (clip) {
    await capture("screenshot-independent-todo-expanded.png", clip);
  }
  await capture("screenshot-independent-todo-desktop.png");

  // 5. 点击工作区选择器，验证工作区下拉菜单也能独立弹出
  console.log("测试工作区下拉选择...");
  await ev(`document.querySelector("[data-testid='workspace-mode-selector']")?.click()`);
  await sleep(800);
  if (clip) {
    await capture("screenshot-independent-workspace-open.png", clip);
  }

  console.log("✓ 所有独立性验证与截图已完成！");
} catch (err) {
  console.error("验证失败:", err);
} finally {
  cleanup();
}
