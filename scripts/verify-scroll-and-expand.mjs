/**
 * 滚动到顶部并展开思考折叠卡片，捕获已完成状态下的思考详情展开图
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9566;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-expand-${Date.now()}`,
    "--window-size=1550,980",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(3000);

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

  const capture = async (filename) => {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    fs.writeFileSync(filename, buffer);
    console.log(`[截屏成功] 已保存 ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  await sleep(4000);

  // 1. 初始化 localStorage 注入文件夹和已保存会话
  await ev(`(() => {
    const ws = ["d:\\\\temp\\\\aiagent", "d:\\\\temp\\\\Desktop", "d:\\\\temp\\\\langchain\\\\workspace"];
    localStorage.setItem("deepagent_workspaces_list_v2", JSON.stringify(ws));
    location.reload();
  })()`);
  await sleep(3500);

  // 滚动到顶部并点击展开所有的 Collapsible（思考卡片）
  await ev(`(() => {
    // 找到滚动容器并滚到顶部
    const scroller = document.querySelector("[data-slot='conversation-content']") || document.querySelector("main") || document.querySelector(".overflow-y-auto");
    if (scroller) scroller.scrollTop = 0;
    window.scrollTo(0, 0);

    // 展开所有思考组件
    const triggers = Array.from(document.querySelectorAll("button[data-slot='collapsible-trigger']"));
    triggers.forEach(t => t.click());
  })()`);
  await sleep(1000);

  await capture("screenshot-reasoning-completed-expanded.png");
  console.log("✓ 已捕获思考折叠卡片展开截图！");
} catch (error) {
  console.error("执行异常:", error);
} finally {
  cleanup();
}
