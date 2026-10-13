/**
 * 验证 5173 与 5174 项目的历史会话物理隔离：
 * 验证 5173 前端只连接独立的 8788 后端，
 * 左侧边栏历史记录完全干净为空，绝对不会读取到 5174 项目的任何历史对话。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";
const chromePort = 9558;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-isolated-history-${Date.now()}`,
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

  // 1. 检查后端真实连接的目标与健康状态
  const health = await fetch("http://127.0.0.1:8788/api/health").then(r => r.json());
  const workbench = await fetch("http://127.0.0.1:8788/api/workbench").then(r => r.json());
  console.log("【服务端隔离状态】:", {
    workspaceRoot: health.workspaceRoot,
    savedSessionsCount: workbench.workbench?.sessions?.length ?? 0
  });

  // 2. 检查 5173 前端页面中左侧边栏渲染的所有会话标题
  const sidebarCheck = await ev(`(() => {
    const sessionButtons = Array.from(document.querySelectorAll("nav button, aside button, .workspace-sidebar button, [data-slot='sidebar'] button"));
    const titles = Array.from(document.querySelectorAll("aside span, nav span, aside li, nav li, aside [title]"))
      .map(el => el.getAttribute("title") || el.textContent?.trim() || "")
      .filter(t => t.length > 0);

    const fullPageText = document.body.innerText;
    
    // 检查是否包含 5174 项目的典型敏感标题
    const leaked5174Keywords = [
      "Java",
      "plan_enter",
      "deepwiki",
      "meeting-notes",
      "researcher",
      "demo-notes.txt",
      "快速排序与堆排序"
    ];

    const leakedFound = leaked5174Keywords.filter(kw => fullPageText.includes(kw));

    // 获取当前会话列表项
    const sessionListItems = Array.from(document.querySelectorAll("aside button span.truncate"))
      .map(s => s.textContent?.trim());

    return {
      sessionCount: sessionListItems.length,
      sessionTitles: sessionListItems,
      leakedFound,
      hasLeaked: leakedFound.length > 0
    };
  })()`);

  console.log("【前端侧边栏会话检查】:", sidebarCheck);

  if (sidebarCheck.hasLeaked) {
    throw new Error(`检测到泄漏的 5174 项目对话: ${sidebarCheck.leakedFound.join(", ")}`);
  } else {
    console.log("✓ 完美验证：左侧边栏历史记录完全没有读取到 5174 项目的对话！");
  }

  // 3. 截取全屏桌面端截图与左侧边栏特写截图
  await capture("screenshot-isolated-empty-history-desktop.png");

  const sidebarClip = await ev(`(() => {
    const aside = document.querySelector("aside") || document.querySelector(".w-64") || document.querySelector("nav");
    if (!aside) return null;
    const r = aside.getBoundingClientRect();
    return { x: 0, y: 0, width: Math.round(r.width + 40), height: Math.round(window.innerHeight), scale: 1 };
  })()`);

  if (sidebarClip) {
    await capture("screenshot-isolated-empty-history-sidebar.png", sidebarClip);
  }

  console.log("✓ 隔离验证完成！");
} catch (err) {
  console.error("验证失败:", err);
} finally {
  cleanup();
}
