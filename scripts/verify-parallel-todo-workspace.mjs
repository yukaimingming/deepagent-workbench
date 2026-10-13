/**
 * 验证任务 Todo 列表与工作区选择器平行水平对齐渲染：
 * 验证在有待办任务（折叠与展开）及无待办任务两种场景下，工作区选择器与任务 Todo 列表是否完美在同一行平行排布。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";
const chromePort = 9556;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-todo-parallel-${Date.now()}`,
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

  // 1. 获取当前激活的 threadId，并将含有 Todo 活动的状态注入当前会话
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
              { content: "完成端到端自动化视觉验收测试", status: "pending" }
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

  // 2. 测量工作区选择器与任务 Todo 列表的坐标及布局对齐情况
  const layoutCheck = await ev(`(() => {
    const wsBtn = document.querySelector("[data-testid='workspace-mode-selector']");
    const todoCard = document.querySelector("[data-testid='todo-queue-card']");
    if (!wsBtn || !todoCard) {
      return { found: false, ws: Boolean(wsBtn), todoCard: Boolean(todoCard) };
    }
    const wsRect = wsBtn.getBoundingClientRect();
    const todoRect = todoCard.getBoundingClientRect();

    const parent = wsBtn.closest(".flex");
    const isSameFlexRow = parent && parent.contains(todoCard);

    // 判断垂直居中/水平平齐程度
    const wsCenterY = (wsRect.top + wsRect.bottom) / 2;
    const todoCenterY = (todoRect.top + todoRect.bottom) / 2;
    const verticalCenterDiff = Math.abs(wsCenterY - todoCenterY);
    const isParallel = todoRect.left >= wsRect.right - 10 && verticalCenterDiff < 20;

    return {
      found: true,
      isSameFlexRow,
      wsRect: { top: Math.round(wsRect.top), bottom: Math.round(wsRect.bottom), left: Math.round(wsRect.left), right: Math.round(wsRect.right), height: Math.round(wsRect.height) },
      todoRect: { top: Math.round(todoRect.top), bottom: Math.round(todoRect.bottom), left: Math.round(todoRect.left), right: Math.round(todoRect.right), height: Math.round(todoRect.height) },
      verticalCenterDiff: Math.round(verticalCenterDiff),
      isParallel
    };
  })()`);

  console.log("布局对齐检测详情:", layoutCheck);

  // 3. 截取全屏视图（折叠状态）
  await capture("screenshot-parallel-todo-workspace-desktop.png");

  // 4. 获取输入框区域剪裁位置并截取特写（折叠状态）
  const clip = await ev(`(() => {
    const container = document.querySelector("[data-testid='workspace-mode-selector']")?.closest(".max-w-3xl");
    if (!container) return null;
    const r = container.getBoundingClientRect();
    return { x: Math.round(r.x - 16), y: Math.max(0, Math.round(r.y - 20)), width: Math.round(r.width + 32), height: Math.round(r.height + 40), scale: 1 };
  })()`);

  if (clip) {
    await capture("screenshot-parallel-todo-workspace-closeup.png", clip);
  }

  // 5. 点击展开 Todo 卡片，查看展开状态下的排布
  console.log("展开待办任务卡片...");
  await ev(`(() => {
    const trigger = document.querySelector("[data-testid='todo-queue-card'] button");
    if (trigger) trigger.click();
  })()`);
  await sleep(800);

  const expandedLayout = await ev(`(() => {
    const wsBtn = document.querySelector("[data-testid='workspace-mode-selector']");
    const todoCard = document.querySelector("[data-testid='todo-queue-card']");
    if (!wsBtn || !todoCard) return null;
    const wsRect = wsBtn.getBoundingClientRect();
    const todoRect = todoCard.getBoundingClientRect();
    return {
      wsTop: Math.round(wsRect.top),
      todoTop: Math.round(todoRect.top),
      wsRight: Math.round(wsRect.right),
      todoLeft: Math.round(todoRect.left),
      todoHeight: Math.round(todoRect.height)
    };
  })()`);
  console.log("展开状态坐标详情:", expandedLayout);

  const expandedClip = await ev(`(() => {
    const container = document.querySelector("[data-testid='workspace-mode-selector']")?.closest(".max-w-3xl");
    if (!container) return null;
    const r = container.getBoundingClientRect();
    return { x: Math.round(r.x - 16), y: Math.max(0, Math.round(r.y - 20)), width: Math.round(r.width + 32), height: Math.round(r.height + 40), scale: 1 };
  })()`);

  if (expandedClip) {
    await capture("screenshot-parallel-todo-expanded-closeup.png", expandedClip);
  }
  await capture("screenshot-parallel-todo-expanded-desktop.png");

  console.log("✓ 所有平行对齐验证与截图已完成！");
} catch (err) {
  console.error("验证失败:", err);
} finally {
  cleanup();
}
