import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const CDP_PORT = 9415;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-verify-${Date.now()}`,
    "--window-size=1500,1050",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(3500);

let ws;
let id = 1;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const cur = id++;
    const handler = (data) => {
      const res = JSON.parse(data.toString());
      if (res.id === cur) {
        ws.off("message", handler);
        if (res.error) reject(res.error);
        else resolve(res.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id: cur, method, params }));
  });
}

async function capture(filename) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(filename, Buffer.from(data, "base64"));
  console.log(`[截图已保存] -> ${filename}`);
}

async function evalJs(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return res?.result?.value;
}

try {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 Chrome 页面目标");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  await send("Page.enable");
  await send("Runtime.enable");

  console.log("导航到 http://127.0.0.1:5173...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(4000);

  // 输入 prompt
  console.log("输入测试 Prompt: D:\\temp\\aiagent 这个路径有什么内容分析完告诉我");
  await evalJs(`(() => {
    const textarea = document.querySelector('textarea');
    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(textarea, 'D:\\\\temp\\\\aiagent 这个路径有什么内容分析完告诉我');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await sleep(600);

  // 点击发送
  await evalJs(`(() => {
    const btn = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('发送') || b.querySelector('svg'));
    if (btn) btn.click();
  })()`);

  console.log("监控状态变化时序：必须先思考完全，思考完成后才允许流式输出正式内容...");

  let sawThinking = false;
  let sawThinkingEnd = false;
  let sawLeakDuringThinking = false;
  let sawFinalContent = false;
  let jumpedBackToThinking = false;

  for (let i = 1; i <= 10; i++) {
    await sleep(3500);
    const snap = await evalJs(`(() => {
      const text = document.body.innerText || '';
      const isThinking = text.includes('正在思考中') || Boolean(document.querySelector('[data-state="open"]'));
      const hasDoneThinking = text.includes('完成思考');
      const hasToolCalling = text.includes('正在调用工具');
      const hasToolDone = text.includes('已调用工具');
      
      // 正式内容提取
      const proseEl = document.querySelector('.prose') || document.querySelector('[data-role="assistant-content"]');
      let prose = proseEl ? proseEl.innerText : '';
      if (!prose) {
        // 从整个助手消息区域排查除了思考和工具之外的文本
        const paragraphs = Array.from(document.querySelectorAll('p.whitespace-pre-wrap'));
        if (paragraphs.length > 0) {
          prose = paragraphs[paragraphs.length - 1].innerText;
        }
      }
      return { isThinking, hasDoneThinking, hasToolCalling, hasToolDone, proseLen: prose.length, prosePreview: prose.slice(0, 50) };
    })()`);

    console.log(`[时序采样 #${i}]`, snap);

    if (snap?.isThinking) sawThinking = true;
    if (snap?.hasDoneThinking) sawThinkingEnd = true;

    // 检查在思考中正文是否泄露
    if (snap?.isThinking && snap?.proseLen > 0) {
      sawLeakDuringThinking = true;
      console.warn("⚠️ 警告：在正在思考中阶段发现了正文内容！");
    }

    // 检查正文出现后是否又跳回思考中
    if (sawThinkingEnd && snap?.isThinking && !snap?.hasDoneThinking) {
      jumpedBackToThinking = true;
      console.warn("⚠️ 警告：思考完成后居然又跳回了正在思考中！");
    }

    if (snap?.proseLen > 50) sawFinalContent = true;

    if (i === 2) {
      await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-seq-1-thinking-and-tools-fixed.png");
    }
    if (i === 5) {
      await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-seq-2-final-streaming-fixed.png");
    }
  }

  await sleep(3000);
  await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-seq-3-completed-fixed.png");

  console.log("\n====== 时序验证最终结果报告 ======");
  console.log("1. 经历过思考阶段:", sawThinking ? "✅ 正常" : "❌ 未检测到");
  console.log("2. 思考彻底完成阶段:", sawThinkingEnd ? "✅ 正常" : "❌ 未检测到");
  console.log("3. 思考中是否有正文早泄/跳转:", sawLeakDuringThinking ? "❌ 偷跑了" : "✅ 零早泄，完全互斥！");
  console.log("4. 思考完成后是否发生状态回跳:", jumpedBackToThinking ? "❌ 发生回跳" : "✅ 绝对单向流转，0 回跳！");
  console.log("5. 最终正文是否正常流式产出:", sawFinalContent ? "✅ 是" : "❌ 否");
} catch (e) {
  console.error("验证失败:", e);
} finally {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  try { chrome.kill(); } catch {}
  process.exit(0);
}
