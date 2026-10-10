/**
 * 浏览器端到端验证（CDP 驱动 headless Chrome）。
 *
 * 为什么需要这个脚本：
 * 之前只靠「HTTP 200 + 模块能编译」验证前端，漏掉了运行时才会暴露的
 * 问题——AI Elements 的 `PromptInputTextarea` 单独使用会抛
 * 「must be used within a PromptInputProvider」，整个 React 树崩掉，
 * 页面全白，而所有模块请求都返回 200。
 *
 * 这个脚本驱动真实浏览器，检查渲染结果和控制台错误。
 *
 * 用法：
 *   1. 先启动服务端（pnpm dev:server）和前端（pnpm dev:web）
 *   2. 通过 API 配好一个提供商（见下方步骤）或手动在 UI 里配
 *   3. node scripts/e2e-browser-check.mjs
 *
 * 环境要求：系统装有 Chrome（路径见下方 CHROME 常量）。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9350;
const APP_URL = process.env.APP_URL ?? "http://127.0.0.1:5173/";
const SERVER_URL = process.env.SERVER_URL ?? "http://127.0.0.1:8787";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 收集到的失败项，最后统一报告。 */
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}`);
  if (!ok) failures.push(`${label} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-e2e-check`,
    "--window-size=1400,900",
  ],
  { stdio: "ignore" },
);

const cleanup = () => chrome.kill();
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

await sleep(3000);

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("找不到 Chrome page 目标，放弃");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const consoleErrors = [];

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
    consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  if (msg.method === "Runtime.exceptionThrown") {
    consoleErrors.push(
      "EXCEPTION: " + (msg.params.exceptionDetails?.exception?.description ?? "unknown"),
    );
  }
});

await new Promise((r) => ws.on("open", r));

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++msgId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const evalJs = async (expression) => {
  const res = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return res.result?.result?.value;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: APP_URL });
await sleep(7000);

console.log("\n--- 渲染与静态 UI ---\n");

check("页面标题", await evalJs("document.title"), "DeepAgent 工作台");
check(
  "root 已挂载（这是白屏检测的关键）",
  (await evalJs("document.getElementById('root').children.length")) > 0,
  true,
);
check(
  "「模型设置」按钮存在",
  await evalJs("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('模型设置'))"),
  true,
);
check(
  "「新建会话」按钮存在",
  await evalJs("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('新建会话'))"),
  true,
);
check("输入框存在", await evalJs("!!document.querySelector('textarea')"), true);
check(
  "活动时间线标题存在",
  await evalJs("[...document.querySelectorAll('h2,h3')].some(h=>h.textContent.includes('运行活动'))"),
  true,
);
check(
  "推理强度三档按钮齐全（按 aria-label）",
  await evalJs(
    `['low','medium','high'].every(v=>[...document.querySelectorAll('button')].some(b=>b.getAttribute('aria-label')==='推理强度 '+v))`,
  ),
  true,
);

console.log("\n--- 模型设置弹窗 ---\n");

await evalJs(
  "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('模型设置')).click()",
);
await sleep(1500);

check("弹窗打开", await evalJs("!!document.querySelector('[role=dialog]')"), true);
check(
  "四种提供商类型",
  await evalJs("[...document.querySelectorAll('option')].length"),
  4,
);
check(
  "StepFun Base URL 已预填",
  await evalJs(
    `[...document.querySelectorAll('input')].some(i=>i.value==='https://api.stepfun.com/step_plan/v1')`,
  ),
  true,
);

await evalJs("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
await sleep(800);
check("Esc 关闭弹窗", await evalJs("!document.querySelector('[role=dialog]')"), true);

console.log("\n--- 输入交互 ---\n");

await evalJs("document.querySelector('textarea')?.focus()");
await sleep(300);
await send("Input.insertText", { text: "e2e-probe" });
await sleep(500);
check("键盘输入生效", await evalJs("document.querySelector('textarea')?.value"), "e2e-probe");

console.log("\n--- 提供商配置与推理强度 ---\n");

// 通过 API 配一个两档模型提供商，然后刷新页面。
// 备份现有配置，测试结束后原样恢复。
// 之前这个脚本会直接删掉所有提供商，把用户真实的 API Key 配置清掉了——
// 那是破坏性行为，绝不能这么干。
const existing = await fetch(`${SERVER_URL}/api/providers`).then((r) => r.json());
const backup = existing.providers ?? [];
const created = await fetch(`${SERVER_URL}/api/providers`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "stepfun",
    label: "E2E 测试",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    apiKey: "sk-e2e-not-a-real-key",
    models: ["step-3.5-flash-2603"],
    defaultModel: "step-3.5-flash-2603",
    reasoning: { efforts: ["low", "high"] },
  }),
});
check("API 创建提供商", created.status, 201);
const createdProvider = await created.json();
const testProviderId = createdProvider.provider?.id;

// 临时停用其他提供商，让前端必然选中刚创建的测试提供商
// （否则前端会优先选用户真实配置，后面的「假密钥应报错」断言就不成立）。
for (const provider of backup) {
  await fetch(`${SERVER_URL}/api/providers/${provider.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: provider.type,
      label: provider.label,
      baseUrl: provider.baseUrl,
      models: provider.models,
      defaultModel: provider.defaultModel,
      enabled: false,
      ...(provider.reasoning ? { reasoning: provider.reasoning } : {}),
    }),
  });
}

await send("Page.navigate", { url: APP_URL });
await sleep(7000);

check(
  "输入框在有配置后启用",
  await evalJs("document.querySelector('textarea')?.disabled"),
  false,
);
check(
  "模型状态显示所选模型",
  await evalJs(
    `(()=>{const el=[...document.querySelectorAll('span')].find(s=>s.textContent.includes('step-3.5-flash-2603'));return !!el})()`,
  ),
  true,
);
check(
  "两档模型上 medium 被禁用",
  await evalJs(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='推理强度 medium');return b?b.disabled:'(未找到)'})()`,
  ),
  true,
);
check(
  "两档模型上 low 可用",
  await evalJs(
    `(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='推理强度 low');return b?b.disabled:'(未找到)'})()`,
  ),
  false,
);

console.log("\n--- 发送消息与 SSE 错误渲染 ---\n");

// 走真实键盘输入路径：PromptInput 的输入状态由其 Provider 内部管理，
// 用 JS setter 改 DOM value 不会同步进 React state，必须用 CDP 输入事件。
// 发送时通过 forwardedProps 固定用两档模型，断言不依赖用户当前选的模型。
await evalJs(`window.__deepagentForceModel = "step-3.5-flash-2603"`);
await evalJs("document.querySelector('textarea')?.focus()");
await sleep(300);
await send("Input.insertText", { text: "e2e 测试消息" });
await sleep(400);
check(
  "键盘输入进入 textarea",
  await evalJs("document.querySelector('textarea')?.value"),
  "e2e 测试消息",
);
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
await sleep(1500);

check(
  "用户消息立即上屏",
  await evalJs("document.body.textContent.includes('e2e 测试消息')"),
  true,
);

await sleep(16000);

check(
  "错误状态呈现",
  await evalJs("document.body.textContent.match(/(运行中|已完成|出错|等待审批|已取消)/)?.[0]"),
  "出错",
);
check(
  "错误卡片渲染到时间线",
  await evalJs("document.body.textContent.includes('运行出错')"),
  true,
);
check(
  "活动区出现卡片",
  (await evalJs("document.querySelectorAll('article').length")) > 0,
  true,
);
check(
  "运行结束后输入框恢复可用",
  await evalJs("!document.querySelector('textarea')?.disabled"),
  true,
);
check(
  "提交后输入框已清空",
  await evalJs("document.querySelector('textarea')?.value"),
  "",
);
check(
  "运行结束后停止按钮消失",
  await evalJs("![...document.querySelectorAll('button')].some(b=>b.textContent==='停止')"),
  true,
);

console.log("\n--- 控制台 ---\n");

check("无控制台错误", consoleErrors.length, 0);
if (consoleErrors.length > 0) {
  for (const error of consoleErrors) console.log("  ! " + error);
}

// 恢复原有配置：把服务端拉回「与备份完全一致」的状态。
// 做法是先删掉备份里不存在的（含本次测试创建的），再逐条写回备份内容。
const current = await fetch(`${SERVER_URL}/api/providers`).then((r) => r.json());
const backupIds = new Set(backup.map((p) => p.id));
for (const provider of current.providers ?? []) {
  if (backupIds.has(provider.id)) continue;
  await fetch(`${SERVER_URL}/api/providers/${provider.id}`, { method: "DELETE" });
}
for (const provider of backup) {
  await fetch(`${SERVER_URL}/api/providers/${provider.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: provider.type,
      label: provider.label,
      baseUrl: provider.baseUrl,
      models: provider.models,
      defaultModel: provider.defaultModel,
      enabled: provider.enabled,
      ...(provider.reasoning ? { reasoning: provider.reasoning } : {}),
    }),
  });
}

ws.close();
chrome.kill();

console.log(
  failures.length === 0
    ? "\n=== 全部通过 ===\n"
    : `\n=== ${failures.length} 项未通过 ===\n${failures.map((f) => "  - " + f).join("\n")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
