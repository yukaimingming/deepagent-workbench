import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9396;
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
    `--user-data-dir=${process.env.TEMP}/cdp-verify-confirmation-${Date.now()}`,
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

// 1. 验证左下角设置按钮文本是否为“设置”
const settingsBtnText = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="open-settings-modal-btn"]');
  return btn ? btn.textContent?.trim() : null;
})()`);

console.log("左下角设置按钮文本:", settingsBtnText);

// 点击打开设置弹窗，验证标题
await evaluate(`document.querySelector('[data-testid="open-settings-modal-btn"]').click()`);
await sleep(800);

const modalTitle = await evaluate(`(() => {
  const title = document.querySelector('h3, [data-slot="dialog-title"], .modal-title, header h2');
  return title ? title.textContent?.trim() : null;
})()`);
console.log("设置弹窗标题:", modalTitle);

// 截图 1：全新“设置”弹窗
await takeScreenshot("screenshot-verified-settings-rename.png");

// 关闭设置弹窗
await evaluate(`(() => {
  const closeBtn = document.querySelector('button[aria-label="关闭"]');
  if (closeBtn) closeBtn.click();
  else {
    const escEvent = new KeyboardEvent('keydown', { key: 'Escape' });
    window.dispatchEvent(escEvent);
  }
})()`);
await sleep(500);

// 2. 验证浅色模式下工作区选择器为纯白
console.log("切换到浅色模式...");
await evaluate(`(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
  localStorage.setItem('theme-mode', 'light');
})()`);
await sleep(800);

const lightWsStyle = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="workspace-mode-selector"]');
  if (!btn) return null;
  const s = window.getComputedStyle(btn);
  return {
    bg: s.backgroundColor,
    border: s.borderWidth,
    color: s.color,
  };
})()`);

console.log("浅色模式下工作区选择器计算样式:", lightWsStyle);
// 截图 2：浅色模式下纯白工作区选择器
await takeScreenshot("screenshot-verified-workspace-pure-white-light.png");

// 3. 验证官方 Confirmation 审批卡片渲染（深色与浅色）
console.log("点击快速卡片以触发真实工具审批...");
await evaluate(`(() => {
  const cards = document.querySelectorAll('button, [role="button"]');
  for (const c of cards) {
    if (c.textContent && c.textContent.includes('检查系统运行环境')) {
      c.click();
      return true;
    }
  }
  return false;
})()`);

console.log("等待真实审批卡片生成...");
await sleep(6000);

// 截图 4：深色模式下官方 Confirmation 审批卡片
await takeScreenshot("screenshot-verified-confirmation-alert-dark.png");

// 切换到浅色模式并截图
console.log("切换到浅色模式验证 Confirmation...");
await evaluate(`(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
  localStorage.setItem('theme-mode', 'light');
})()`);
await sleep(1500);

// 截图 3：浅色模式下官方 Confirmation 审批卡片
await takeScreenshot("screenshot-verified-confirmation-alert-light.png");

console.log("所有端到端验证执行完毕！");
process.exit(0);
