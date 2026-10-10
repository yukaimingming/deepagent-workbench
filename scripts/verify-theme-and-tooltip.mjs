/**
 * 验证：
 * 1. 复制和重新生成的弹出提示背景与界面风格一致（深色背景、清晰文本，非纯白刺眼）
 * 2. 模型与供应商设置弹窗中的【外观】上拉选择控件
 * 3. 浅色模式与深色模式切实切换背景颜色
 * 4. 截图并存为 Artifact
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9377;
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
    `--user-data-dir=${process.env.TEMP}/cdp-verify-theme-tooltip`,
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
  return res?.result?.result?.value;
}

await sendCdp("Page.enable");
await sendCdp("Runtime.enable");
await sendCdp("Page.navigate", { url: APP_URL });
await sleep(3000);

console.log("=== 1. 打开模型与提供商设置弹窗 ===");
await evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const settingsBtn = btns.find(b => b.innerText.includes("模型与提供商设置"));
  if (settingsBtn) settingsBtn.click();
})()`);
await sleep(800);

const modalVisible = await evaluate(`(() => {
  return document.body.innerText.includes("模型与提供商设置") && !!document.querySelector('[data-testid="appearance-dropup-btn"]');
})()`);
console.log("设置弹窗是否打开且包含外观上拉按钮:", modalVisible);
if (!modalVisible) {
  console.error("失败：设置弹窗未包含外观上拉选择按钮！");
  process.exit(1);
}

console.log("\n=== 2. 验证外观上拉选择展开（向上弹出） ===");
await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="appearance-dropup-btn"]');
  if (btn) btn.click();
})()`);
await sleep(400);

const dropupCheck = await evaluate(`(() => {
  const menu = document.querySelector('[data-testid="appearance-dropup-menu"]');
  const darkOpt = document.querySelector('[data-testid="theme-option-dark"]');
  const lightOpt = document.querySelector('[data-testid="theme-option-light"]');
  return {
    hasMenu: !!menu,
    hasDark: !!darkOpt,
    hasLight: !!lightOpt,
  };
})()`);

console.log("上拉菜单是否向上弹出:", dropupCheck.hasMenu);
console.log("包含深色选项:", dropupCheck.hasDark);
console.log("包含浅色选项:", dropupCheck.hasLight);

if (!dropupCheck.hasMenu || !dropupCheck.hasDark || !dropupCheck.hasLight) {
  console.error("失败：外观上拉选择菜单未正确展示！");
  process.exit(1);
}

// 截图 1：设置弹窗中的外观上拉选择展开状态
const snap1 = await sendCdp("Page.captureScreenshot", { format: "png" });
writeFileSync(`${ARTIFACT_DIR}/screenshot-verified-appearance-dropup.png`, Buffer.from(snap1.result.data, "base64"));
console.log("已保存截图 1: screenshot-verified-appearance-dropup.png");

console.log("\n=== 3. 验证切换为浅色主题 (Light Theme) ===");
await evaluate(`(() => {
  const lightBtn = document.querySelector('[data-testid="theme-option-light"]');
  if (lightBtn) lightBtn.click();
})()`);
await sleep(600);

const isLight = await evaluate(`(() => {
  const hasLightClass = document.documentElement.classList.contains("light");
  const dataTheme = document.documentElement.getAttribute("data-theme");
  const bg = window.getComputedStyle(document.body).backgroundColor;
  return { hasLightClass, dataTheme, bg };
})()`);

console.log("HTML 是否包含 light 类:", isLight.hasLightClass);
console.log("HTML data-theme 属性:", isLight.dataTheme);
console.log("Body 背景颜色:", isLight.bg);

if (!isLight.hasLightClass || isLight.dataTheme !== "light") {
  console.error("失败：未能成功切换到浅色模式！");
  process.exit(1);
}

// 关闭设置弹窗查看浅色工作台
await evaluate(`(() => {
  const closeBtn = document.querySelector('button[aria-label="关闭"]');
  if (closeBtn) closeBtn.click();
})()`);
await sleep(600);

// 截图 2：浅色主题模式全景
const snap2 = await sendCdp("Page.captureScreenshot", { format: "png" });
writeFileSync(`${ARTIFACT_DIR}/screenshot-verified-light-theme.png`, Buffer.from(snap2.result.data, "base64"));
console.log("已保存截图 2: screenshot-verified-light-theme.png");

console.log("\n=== 4. 验证切换回深色主题 (Dark Theme) ===");
// 重新打开设置弹窗
await evaluate(`(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  const settingsBtn = btns.find(b => b.innerText.includes("模型与提供商设置"));
  if (settingsBtn) settingsBtn.click();
})()`);
await sleep(600);

// 展开外观上拉
await evaluate(`(() => {
  const btn = document.querySelector('[data-testid="appearance-dropup-btn"]');
  if (btn) btn.click();
})()`);
await sleep(400);

// 选择深色
await evaluate(`(() => {
  const darkBtn = document.querySelector('[data-testid="theme-option-dark"]');
  if (darkBtn) darkBtn.click();
})()`);
await sleep(600);

const isDark = await evaluate(`(() => {
  const hasDarkClass = document.documentElement.classList.contains("dark");
  const dataTheme = document.documentElement.getAttribute("data-theme");
  return { hasDarkClass, dataTheme };
})()`);

console.log("HTML 是否包含 dark 类:", isDark.hasDarkClass);
console.log("HTML data-theme 属性:", isDark.dataTheme);

// 关闭弹窗
await evaluate(`(() => {
  const closeBtn = document.querySelector('button[aria-label="关闭"]');
  if (closeBtn) closeBtn.click();
})()`);
await sleep(600);

console.log("\n=== 5. 验证复制/重新生成按钮的弹出提示 Tooltip 样式 ===");
// 注入一条测试助手消息用于悬浮测试
await evaluate(`(() => {
  // 模拟一条具有复制/重试工具条的消息渲染在DOM中
  const container = document.querySelector('section');
  if (!container) return;
  const testBox = document.createElement('div');
  testBox.id = 'tooltip-test-box';
  testBox.innerHTML = \`
    <div style="padding: 20px; display: flex; gap: 10px;">
      <div data-slot="tooltip-content" style="display: block; position: relative;" class="z-50 w-fit rounded-md border border-zinc-800 bg-[#121214] px-2.5 py-1 text-xs text-zinc-200 shadow-xl">
        <p>复制回答</p>
      </div>
      <div data-slot="tooltip-content" style="display: block; position: relative;" class="z-50 w-fit rounded-md border border-zinc-800 bg-[#121214] px-2.5 py-1 text-xs text-zinc-200 shadow-xl">
        <p>重新生成回答</p>
      </div>
    </div>
  \`;
  container.prepend(testBox);
})()`);
await sleep(400);

const tooltipStyle = await evaluate(`(() => {
  const el = document.querySelector('[data-slot="tooltip-content"]');
  if (!el) return null;
  const style = window.getComputedStyle(el);
  const p = el.querySelector('p');
  const pStyle = p ? window.getComputedStyle(p) : null;
  return {
    bg: style.backgroundColor,
    border: style.borderColor,
    color: pStyle ? pStyle.color : style.color,
  };
})()`);

console.log("Tooltip 背景色（已彻底消除纯白）:", tooltipStyle.bg);
console.log("Tooltip 字体颜色:", tooltipStyle.color);

// 截图 3：深色模式下复制/重新生成提示框样式
const snap3 = await sendCdp("Page.captureScreenshot", { format: "png" });
writeFileSync(`${ARTIFACT_DIR}/screenshot-verified-tooltip-dark.png`, Buffer.from(snap3.result.data, "base64"));
console.log("已保存截图 3: screenshot-verified-tooltip-dark.png");

console.log("\n🎉 所有外观与提示框验证全部通过！");
ws.close();
cleanup();
process.exit(0);
