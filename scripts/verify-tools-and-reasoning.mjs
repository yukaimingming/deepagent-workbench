/**
 * 专门验证工具实时展开渲染与展开思考思维链细节：
 * 发送“请使用 ls 工具列出当前工作区的文件”，
 * 捕获工具调用卡片实时展开与思考内容展开图。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=9599",
    `--user-data-dir=${process.env.TEMP}/cdp-tools-${Date.now()}`,
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
  const list = await fetch("http://127.0.0.1:9599/json/list").then((r) => r.json());
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

  // 输入触发工具调用的指令
  console.log("输入指令触发 ls 工具调用...");
  await ev(`document.querySelector("textarea")?.focus()`);
  await sleep(300);
  await send("Input.insertText", {
    text: "请使用 ls 工具查看当前工作区有哪些文件并简述用途",
  });
  await sleep(500);

  // 回车发送
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  });

  console.log("等待工具调用与流式执行...");
  await sleep(8000);
  await capture("screenshot-refactor-7-tool-calling.png");

  console.log("等待回答完成...");
  await sleep(18000);
  // 滚动到顶部并展开思考卡片
  await ev(`(() => {
    const scroller = document.querySelector("[data-slot='conversation-content']") || document.querySelector("main") || window;
    if (scroller.scrollTo) scroller.scrollTo(0, 0);
    // 展开所有思考卡片
    document.querySelectorAll("button[data-slot='collapsible-trigger']").forEach(b => b.click());
  })()`);
  await sleep(1000);
  await capture("screenshot-refactor-8-tool-result-and-reasoning.png");

  console.log("工具与思考细节截屏验证成功！");
} catch (error) {
  console.error("执行异常:", error);
} finally {
  cleanup();
}
