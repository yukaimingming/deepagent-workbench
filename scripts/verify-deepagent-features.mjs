/**
 * 验证 DeepAgent 内置功能（write_todos 计划分解、工具调用卡片、思考中）并截图。
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
    "--remote-debugging-port=9399",
    `--user-data-dir=${process.env.TEMP}/cdp-features-${Date.now()}`,
    "--window-size=1500,950",
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
  const list = await fetch("http://127.0.0.1:9399/json/list").then((r) => r.json());
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

  const capture = async (name) => {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    fs.writeFileSync(`screenshot-${name}.png`, buffer);
    console.log(`[截屏成功] 已保存 screenshot-${name}.png (${(buffer.length / 1024).toFixed(1)} KB)`);
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  await sleep(4000);

  // 输入触发 write_todos 和工具调用的指令
  console.log("发送指令触发 write_todos 和文件系统工具...");
  await ev(`document.querySelector("textarea")?.focus()`);
  await sleep(300);
  await send("Input.insertText", {
    text: "请使用 write_todos 工具制定3步计划：1. 查看当前工作区文件；2. 说明各文件用途；3. 输出总结。然后执行第1步查看文件。",
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

  // 观察流式生成
  console.log("等待流式事件与工具调用...");
  await sleep(8000);
  await capture("6-deepagent-features-streaming");

  console.log("等待执行收尾...");
  await sleep(25000);
  await capture("6-deepagent-features-final");

  console.log("完成 DeepAgent 功能验证截屏！");
} catch (error) {
  console.error("执行失败:", error);
} finally {
  cleanup();
}
