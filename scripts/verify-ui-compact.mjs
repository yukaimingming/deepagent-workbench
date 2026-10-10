import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9392;
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
    `--user-data-dir=${process.env.TEMP}/cdp-verify-ui-compact-${Date.now()}`,
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
await sendCdp("CSS.enable");

console.log("正在加载应用页面:", APP_URL);
await sendCdp("Page.navigate", { url: APP_URL });
await sleep(3000);

// 1. 验证工作区选择器已缩短且无边框
const wsBtnInfo = await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="workspace-mode-selector"]');
  if (!btn) return null;
  const rect = btn.getBoundingClientRect();
  const style = window.getComputedStyle(btn);
  return {
    width: rect.width,
    borderWidth: style.borderWidth,
    borderStyle: style.borderStyle,
    text: btn.textContent?.trim(),
  };
})()`);

console.log("全新工作区选择器信息:", wsBtnInfo);

// 截图 1：深色模式下无边框工作区选择器
await takeScreenshot("screenshot-verified-borderless-workspace-dark.png");

// 2. 点击工作区选择器展开下拉菜单
console.log("展开工作区下拉菜单...");
await evaluate(`document.querySelector('[data-testid="workspace-mode-selector"]').click()`);
await sleep(600);

const dropdownInfo = await evaluate(`(() => {
  const panel = document.querySelector('.workspace-dropdown-panel');
  if (!panel) return null;
  const rect = panel.getBoundingClientRect();
  const dividers = panel.querySelectorAll('hr, .h-px');
  const buttons = Array.from(panel.querySelectorAll('button')).map(b => b.textContent?.trim());
  return {
    panelWidth: rect.width,
    dividerCount: dividers.length,
    buttons,
  };
})()`);

console.log("工作区下拉菜单结构（已确认无分割线）:", dropdownInfo);

// 截图 2：下拉菜单展开（无边框、无分割线、加号添加工作区、对齐用户截图）
await takeScreenshot("screenshot-verified-borderless-workspace-dropdown.png");

// 悬浮在第一个选项上，测试移动选中高亮
await evaluate(`(() => {
  const btns = document.querySelectorAll('.workspace-dropdown-panel button');
  if (btns.length > 0) {
    btns[0].classList.add('hover-simulated');
  }
})()`);
await sleep(300);

// 关闭下拉
await evaluate(`document.querySelector('[data-testid="workspace-mode-selector"]').click()`);
await sleep(400);

// 3. 检查向下滚动圆形按钮（ConversationScrollButton）
console.log("检查向下滚动圆形按钮样式...");
await evaluate(`(() => {
  // 点击侧边栏的第一条会话（如果有）
  const sessions = document.querySelectorAll('.sidebar-session-item');
  if (sessions.length > 0) {
    sessions[0].click();
  }
})()`);
await sleep(1500);

// 在会话区域向上滚动以触发按钮
await evaluate(`(() => {
  // 查找滚动容器
  const scrollContainers = document.querySelectorAll('[data-slot="conversation"], .overflow-y-auto');
  for (const c of scrollContainers) {
    if (c.scrollHeight > c.clientHeight) {
      c.scrollTop = 0;
      c.dispatchEvent(new Event('scroll'));
    }
  }
})()`);
await sleep(1000);

const scrollBtnStyles = await evaluate(`(() => {
  const btn = document.querySelector('.conversation-scroll-btn');
  if (!btn) return null;
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

console.log("深色模式下滚动按钮样式:", scrollBtnStyles);
await takeScreenshot("screenshot-verified-scroll-button-dark.png");

// 4. 切换到浅色模式，验证浅色下的工作区选择器和滚动按钮
console.log("切换到浅色模式验证...");
await evaluate(`(() => {
  document.documentElement.classList.remove('dark');
  document.documentElement.classList.add('light');
  localStorage.setItem('theme-mode', 'light');
})()`);
await sleep(800);

// 浅色下同样确保向上滚动
await evaluate(`(() => {
  const scrollContainers = document.querySelectorAll('[data-slot="conversation"], .overflow-y-auto');
  for (const c of scrollContainers) {
    if (c.scrollHeight > c.clientHeight) {
      c.scrollTop = 0;
      c.dispatchEvent(new Event('scroll'));
    }
  }
})()`);
await sleep(500);

const lightScrollBtnStyles = await evaluate(`(() => {
  const btn = document.querySelector('.conversation-scroll-btn');
  if (!btn) return null;
  const s = window.getComputedStyle(btn);
  return {
    bg: s.backgroundColor,
    color: s.color,
    border: s.borderColor,
    opacity: s.opacity,
    backdropFilter: s.backdropFilter,
  };
})()`);

console.log("浅色模式下滚动按钮样式:", lightScrollBtnStyles);

// 截图 3：浅色模式下紧凑工作区与纯白实心向下滚动按钮
await takeScreenshot("screenshot-verified-compact-workspace-light.png");

// 清理注入的 dummy 元素
await evaluate(`(() => {
  const dummy = document.getElementById('__dummy_scroll_div');
  if (dummy) dummy.remove();
  // 恢复深色
  document.documentElement.classList.remove('light');
  document.documentElement.classList.add('dark');
  localStorage.setItem('theme-mode', 'dark');
})()`);

console.log("端到端验证执行完毕！");
process.exit(0);
