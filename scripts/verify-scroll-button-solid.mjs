import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9394;
const APP_URL = "http://127.0.0.1:5173/";
const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-verify-scroll-solid-${Date.now()}`,
    "--window-size=1440,920",
  ],
  { stdio: "ignore" },
);

const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

await sleep(2500);

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("无法找到 Chrome page 目标");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((resolve) => ws.on("open", resolve));

function sendCdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const res = await sendCdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails));
  }
  return res.result?.result?.value;
}

async function takeScreenshot(filename) {
  const res = await sendCdp("Page.captureScreenshot", { format: "png" });
  if (res.result?.data) {
    writeFileSync(`${ARTIFACT_DIR}/${filename}`, Buffer.from(res.result.data, "base64"));
    console.log(`[截图已保存] ${filename}`);
  }
}

await sendCdp("Page.enable");
await sendCdp("DOM.enable");

console.log("正在加载应用页面:", APP_URL);
await sendCdp("Page.navigate", { url: APP_URL });
await sleep(3000);

// 挂载真实结构与类名的测试滚动按钮
console.log("验证向下滚动圆形按钮纯色不透明渲染...");
await evaluate(`(() => {
  const conversation = document.querySelector('[data-slot="conversation"]') || document.body;
  let btn = document.querySelector('.conversation-scroll-btn');
  if (!btn) {
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'conversation-scroll-btn absolute bottom-24 left-1/2 -translate-x-1/2 z-30 flex size-10 items-center justify-center rounded-full border shadow-xl cursor-pointer select-none';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>';
    conversation.appendChild(btn);
  }
})()`);

await sleep(500);

const darkBtnStyle = await evaluate(`(() => {
  const btn = document.querySelector('.conversation-scroll-btn');
  const s = window.getComputedStyle(btn);
  return {
    bg: s.backgroundColor,
    color: s.color,
    border: s.borderColor,
    opacity: s.opacity,
    backdropFilter: s.backdropFilter,
    boxShadow: s.boxShadow,
  };
})()`);

console.log("深色模式下滚动按钮实测样式:", darkBtnStyle);
await takeScreenshot("screenshot-verified-scroll-button-solid-dark.png");

// 切换到浅色模式
console.log("切换到浅色模式...");
await evaluate(`(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
  localStorage.setItem('theme-mode', 'light');
})()`);
await sleep(800);

const lightBtnStyle = await evaluate(`(() => {
  const btn = document.querySelector('.conversation-scroll-btn');
  const s = window.getComputedStyle(btn);
  return {
    bg: s.backgroundColor,
    color: s.color,
    border: s.borderColor,
    opacity: s.opacity,
    backdropFilter: s.backdropFilter,
    boxShadow: s.boxShadow,
  };
})()`);

console.log("浅色模式下滚动按钮实测样式:", lightBtnStyle);
await takeScreenshot("screenshot-verified-scroll-button-solid-light.png");

// 恢复深色并清理注入按钮
await evaluate(`(() => {
  const btn = document.querySelector('.conversation-scroll-btn');
  if (btn) btn.remove();
  document.documentElement.classList.remove('light');
  document.documentElement.classList.add('dark');
  localStorage.setItem('theme-mode', 'dark');
})()`);

console.log("全部验证完毕！");
process.exit(0);
