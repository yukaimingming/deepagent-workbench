/**
 * 诊断输入「请使用 execute 或 ls 工具查看当前目录文件并说明用途。」时的全部前端状态变化
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9611;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-ls-${Date.now()}`,
    "--window-size=1550,980",
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

const artifactDir = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

try {
  const list = await fetch(`http://127.0.0.1:${chromePort}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 Chrome 页面");

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
      const msgId = ++id;
      pend.set(msgId, (res) => resolve(res.result));
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send("Page.enable");
  await send("DOM.enable");
  await send("Runtime.enable");

  console.log("正在加载前端页面 http://127.0.0.1:5173 ...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(3500);

  // 输入 prompt
  const fillInput = `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '请使用 execute 或 ls 工具查看当前目录文件并说明用途。');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `;
  await send("Runtime.evaluate", { expression: fillInput, returnByValue: true });
  await sleep(300);

  const clickSend = `
    (() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `;
  await send("Runtime.evaluate", { expression: clickSend, returnByValue: true });
  console.log("已发送指令，开始监控各阶段状态与工具卡片...");

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const inspect = `
      (() => {
        const body = document.body.innerText;
        const toolCards = Array.from(document.querySelectorAll('[class*="tool-"], .border-zinc-800'))
          .map(el => el.innerText.slice(0, 50));
        const reasoningTriggers = Array.from(document.querySelectorAll('button:has(svg.lucide-brain)'))
          .map(el => el.innerText.trim());
        const caret = Boolean(document.querySelector('.streaming-caret'));
        const finished = body.includes('复制回答');
        return {
          toolCount: toolCards.length,
          toolCards,
          reasoningTriggers,
          caret,
          finished,
          bodySnippet: body.slice(-200)
        };
      })()
    `;
    const res = await send("Runtime.evaluate", { expression: inspect, returnByValue: true });
    const val = res.result?.value;
    console.log(`[tick ${i}]`, val);
    if (val?.finished && !val.caret) {
      break;
    }
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(artifactDir, "screenshot-debug-ls-problem.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("已保存复现截图：", shotPath);

} catch (err) {
  console.error("执行过程出错：", err);
} finally {
  cleanup();
}
