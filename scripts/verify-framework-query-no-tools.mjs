/**
 * 验证用户提问「介绍一下agentscope java构架」时：
 * 1. 纯框架/知识问答不再误触发工具卡片（无 ls / read_file 卡片误显）；
 * 2. 正文内容具备流畅平滑的逐词流式输出过程；
 * 3. 截图证明流式打字与无工具卡片的纯净界面。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9577;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-fw-${Date.now()}`,
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

  // 输入「介绍一下agentscope java构架」并发送
  const fillInput = `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '介绍一下agentscope java构架');
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
  console.log("已发送消息：「介绍一下agentscope java构架」，开始监控流式与工具卡片...");

  // 监控正文流式输出阶段并抓拍截图
  let capturedStreaming = false;
  let hasToolsAppeared = false;

  for (let i = 0; i < 60; i++) {
    await sleep(800);
    const checkState = `
      (() => {
        const bodyText = document.body.innerText;
        // 是否出现了工具卡片
        const toolCard = document.querySelector('.border-zinc-800') && (bodyText.includes('列出工作区文件') || bodyText.includes('读取文件内容') || bodyText.includes('PARAMETERS'));
        // 是否正在流式吐字（正文 caret 或 content 长度大于 50 且仍在流式）
        const caret = document.querySelector('.streaming-caret');
        const hasContent = bodyText.includes('AgentScope') || bodyText.includes('架构') || bodyText.includes('Java');
        const isFinished = bodyText.includes('复制回答') && !caret;
        return {
          hasTools: Boolean(toolCard),
          hasStreamingCaret: Boolean(caret),
          hasContent,
          isFinished,
          length: bodyText.length,
          sample: bodyText.slice(-200)
        };
      })()
    `;
    const res = await send("Runtime.evaluate", { expression: checkState, returnByValue: true });
    const val = res.result?.value;
    if (val) {
      if (val.hasTools) {
        hasToolsAppeared = true;
      }
      if (val.hasStreamingCaret && !capturedStreaming && val.hasContent) {
        console.log("捕获到正文平滑流式输出中！", val);
        const shot = await send("Page.captureScreenshot", { format: "png" });
        const shotPath = path.join(artifactDir, "screenshot-framework-streaming.png");
        fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
        console.log("已保存流式正文输出截图：", shotPath);
        capturedStreaming = true;
      }
      if (val.isFinished) {
        console.log("回答生成已彻底结束：", val);
        break;
      }
    }
  }

  // 最终完成截图
  await sleep(1000);
  const shotFinal = await send("Page.captureScreenshot", { format: "png" });
  const shotFinalPath = path.join(artifactDir, "screenshot-framework-final.png");
  fs.writeFileSync(shotFinalPath, Buffer.from(shotFinal.data, "base64"));
  console.log("已保存最终完成截图：", shotFinalPath);

  console.log("验证总结：", {
    hasToolsAppeared,
    capturedStreaming
  });

} catch (err) {
  console.error("验证过程出错：", err);
} finally {
  cleanup();
}
