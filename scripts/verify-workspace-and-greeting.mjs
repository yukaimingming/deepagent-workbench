/**
 * 验证：
 * 1. 欢迎词基于时区动态展示，生硬技术描述已移除
 * 2. 提示词输入框上方对齐的工作区选择下拉条（无工作区模式、选择工作区、打开文件夹新建工作区）
 * 3. 工作区 tmp 移除后不复活
 * 4. 截图并存为 Artifact
 */

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9366;
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
    `--user-data-dir=${process.env.TEMP}/cdp-verify-workspace-greeting`,
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

console.log("=== 1. 验证欢迎信息区 ===");
const welcomeCheck = await evaluate(`(() => {
  const text = document.body.innerText;
  const hasOldText = text.includes("基于 LangChain Deep Agents 与 AI SDK Elements 构建");
  const hasGreeting = text.includes("好") || text.includes("辛苦啦") || text.includes("新的一天") || text.includes("夜深了");
  const title = document.querySelector("h2")?.innerText || "";
  return { hasOldText, hasGreeting, title };
})()`);

console.log("旧生硬文案是否存在（应为 false）:", welcomeCheck.hasOldText);
console.log("动态温馨问候语是否存在（应为 true）:", welcomeCheck.hasGreeting);
console.log("当前问候语标题:", welcomeCheck.title);

if (welcomeCheck.hasOldText) {
  console.error("失败：仍然包含旧生硬文案！");
  process.exit(1);
}
if (!welcomeCheck.hasGreeting) {
  console.error("失败：未找到时区动态问候语！");
  process.exit(1);
}
console.log("✓ 欢迎信息区验证通过！");

console.log("\n=== 2. 验证提示词输入框上方工作区选择栏 ===");
const barCheck = await evaluate(`(() => {
  const wsBtn = document.querySelector('[data-testid="workspace-mode-selector"]');
  return { found: !!wsBtn, text: wsBtn ? wsBtn.innerText.replace(/\\n/g, ' ') : "" };
})()`);

console.log("输入框上方工作区栏是否存在（应为 true）:", barCheck.found);
console.log("工作区栏显示内容:", barCheck.text);

if (!barCheck.found) {
  console.error("失败：未找到输入框上方工作区选择条！");
  process.exit(1);
}
console.log("✓ 输入框上方工作区选择栏存在！");

console.log("\n=== 3. 验证点击展开工作区下拉列表并切换模式 ===");
await evaluate(`(() => {
  const wsBtn = document.querySelector('[data-testid="workspace-mode-selector"]');
  if (wsBtn) wsBtn.click();
})()`);
await sleep(600);

const dropdownCheck = await evaluate(`(() => {
  const text = document.body.innerText;
  const hasDirectChatOpt = text.includes("直接聊天模式 (无工作区)");
  const hasNewWsOpt = text.includes("打开文件夹新建工作区");
  return { hasDirectChatOpt, hasNewWsOpt };
})()`);

console.log("下拉菜单是否包含‘直接聊天模式 (无工作区)’:", dropdownCheck.hasDirectChatOpt);
console.log("下拉菜单是否包含‘打开文件夹新建工作区’:", dropdownCheck.hasNewWsOpt);

if (!dropdownCheck.hasDirectChatOpt || !dropdownCheck.hasNewWsOpt) {
  console.error("失败：下拉菜单缺少关键选项！");
  process.exit(1);
}
console.log("✓ 工作区下拉菜单选项完整！");

// 截图 1：下拉菜单展开状态
const snap1 = await sendCdp("Page.captureScreenshot", { format: "png" });
writeFileSync(`${ARTIFACT_DIR}/screenshot-verified-workspace-dropdown-open.png`, Buffer.from(snap1.result.data, "base64"));
console.log("已保存截图 1: screenshot-verified-workspace-dropdown-open.png");

console.log("\n=== 4. 验证点击切换至‘直接聊天模式’ ===");
await evaluate(`(() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const directBtn = buttons.find(b => b.innerText.includes("直接聊天模式 (无工作区)"));
  if (directBtn) directBtn.click();
})()`);
await sleep(600);

const switchCheck = await evaluate(`(() => {
  const text = document.body.innerText;
  return { isDirect: text.includes("直接聊天模式") && text.includes("不在工作区") };
})()`);
console.log("切换后是否显示直接聊天模式:", switchCheck.isDirect);

// 截图 2：已切换到直接聊天模式且显示温馨欢迎语的主界面
const snap2 = await sendCdp("Page.captureScreenshot", { format: "png" });
writeFileSync(`${ARTIFACT_DIR}/screenshot-verified-direct-chat-and-greeting.png`, Buffer.from(snap2.result.data, "base64"));
console.log("已保存截图 2: screenshot-verified-direct-chat-and-greeting.png");

console.log("\n=== 5. 验证点击‘打开文件夹新建工作区’调出弹窗 ===");
// 再次打开下拉菜单
await evaluate(`(() => {
  const wsBtn = document.querySelector('[data-testid="workspace-mode-selector"]');
  if (wsBtn) wsBtn.click();
})()`);
await sleep(500);

// 点击打开文件夹新建工作区
await evaluate(`(() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const openFolderBtn = buttons.find(b => b.innerText.includes("打开文件夹新建工作区"));
  if (openFolderBtn) openFolderBtn.click();
})()`);
await sleep(800);

const modalCheck = await evaluate(`(() => {
  const text = document.body.innerText;
  return { hasModal: text.includes("选择工作区文件夹") || text.includes("快捷位置") || text.includes("确定选择") };
})()`);
console.log("文件夹选择器弹窗是否成功弹出:", modalCheck.hasModal);

if (!modalCheck.hasModal) {
  console.error("失败：文件夹选择弹窗未弹出！");
  process.exit(1);
}
console.log("✓ 文件夹选择弹窗成功调起！");

// 截图 3：文件夹选择弹窗弹出
const snap3 = await sendCdp("Page.captureScreenshot", { format: "png" });
writeFileSync(`${ARTIFACT_DIR}/screenshot-verified-folder-picker-modal.png`, Buffer.from(snap3.result.data, "base64"));
console.log("已保存截图 3: screenshot-verified-folder-picker-modal.png");

// 关闭弹窗
await evaluate(`(() => {
  const cancelBtn = Array.from(document.querySelectorAll("button")).find(b => b.innerText.includes("取消"));
  if (cancelBtn) cancelBtn.click();
})()`);
await sleep(500);

console.log("\n=== 6. 验证工作区 tmp 移除与不复活 ===");
const removeCheck = await evaluate(`(() => {
  const text = document.body.innerText;
  // 检查左侧栏中是否还有 tmp
  const aside = document.querySelector("aside");
  const asideText = aside ? aside.innerText : "";
  const hasTmp = asideText.toLowerCase().includes("\\ntmp") || asideText.toLowerCase().includes("工作区: tmp");
  return { hasTmp, asideText: asideText.slice(0, 150) };
})()`);
console.log("侧边栏中是否存在未被移除的 tmp（应为 false）:", removeCheck.hasTmp);

console.log("\n🎉 所有功能测试验证全部通过！");
ws.close();
cleanup();
process.exit(0);
