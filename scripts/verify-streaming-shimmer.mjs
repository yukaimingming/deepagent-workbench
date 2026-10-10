/**
 * 验证思考内容流式输出与 Elements 官方 Shimmer 微光动效
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9555;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-shimmer-${Date.now()}`,
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

  // 输入一条需要思考并回答的问题
  const fillInput = `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '请详细解释什么是微光动效（Shimmer Effect），以及在 AI 思考状态中它的交互价值');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `;
  const filled = await send("Runtime.evaluate", { expression: fillInput, returnByValue: true });
  console.log("填写输入框：", filled.result?.value);
  await sleep(500);

  // 点击发送
  const clickSend = `
    (() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    })()
  `;
  const sent = await send("Runtime.evaluate", { expression: clickSend, returnByValue: true });
  console.log("点击发送：", sent.result?.value);

  // 轮询并抓拍思考流式状态（正在思考中，Shimmer 亮白扫光）
  console.log("等待思考状态出现并进行流式过程捕获...");
  let capturedThinking = false;
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const checkState = `
      (() => {
        const bodyText = document.body.innerText;
        const hasThinking = bodyText.includes('正在思考中') || bodyText.includes('思考中');
        const shimmerEl = document.querySelector('[style*="--spread"]') || document.querySelector('.bg-clip-text');
        const reasoningContent = document.querySelector('[data-state="open"]') || document.querySelector('.font-mono');
        return {
          hasThinking,
          hasShimmer: Boolean(shimmerEl),
          shimmerStyle: shimmerEl ? shimmerEl.getAttribute('style') : null,
          contentPreview: reasoningContent ? reasoningContent.innerText.slice(0, 100) : ''
        };
      })()
    `;
    const res = await send("Runtime.evaluate", { expression: checkState, returnByValue: true });
    const val = res.result?.value;
    if (val && val.hasThinking && !capturedThinking) {
      console.log("捕获到思考中状态！", val);
      // 捕获思考流式中的截图
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const targetPath = path.join(artifactDir, "screenshot-streaming-shimmer-active.png");
      fs.writeFileSync(targetPath, Buffer.from(shot.data, "base64"));
      console.log("已保存流式思考与 Shimmer 截图：", targetPath);
      capturedThinking = true;
      break;
    }
  }

  // 继续等待思考完成和正文流式输出
  console.log("等待思考完成与正文流式生成...");
  let capturedComplete = false;
  for (let i = 0; i < 40; i++) {
    await sleep(800);
    const checkComplete = `
      (() => {
        const bodyText = document.body.innerText;
        const hasFinishedThinking = bodyText.includes('完成思考') || bodyText.includes('已完成思考');
        const hasAnswer = bodyText.includes('微光') || bodyText.includes('Shimmer');
        return {
          hasFinishedThinking,
          hasAnswer,
          bodySample: bodyText.slice(-300)
        };
      })()
    `;
    const res = await send("Runtime.evaluate", { expression: checkComplete, returnByValue: true });
    const val = res.result?.value;
    if (val && val.hasFinishedThinking && val.hasAnswer) {
      console.log("思考完成且正文已生成！", val);
      await sleep(1500); // 稍微等待更多正文吐出
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const targetPath = path.join(artifactDir, "screenshot-streaming-shimmer-complete.png");
      fs.writeFileSync(targetPath, Buffer.from(shot.data, "base64"));
      console.log("已保存思考完成与流式回答截图：", targetPath);
      capturedComplete = true;
      break;
    }
  }

  console.log("测试流程执行完毕，捕获状态：", { capturedThinking, capturedComplete });
} catch (err) {
  console.error("执行出错：", err);
} finally {
  cleanup();
}
