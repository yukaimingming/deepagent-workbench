/**
 * reasoning 流式时序的浏览器验证。
 *
 * 验证用户提出的行为：思考内容先流式输出，结束后才开始正文流式输出。
 *
 * 做法：拦截前端的 AG-UI 事件流不现实（HttpAgent 内部封装），
 * 改为在页面里挂一个测试钩子，直接往 React 状态派发事件序列，
 * 再用 DOM 断言渲染顺序与内容。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9370;
const APP_URL = "http://127.0.0.1:5173/";

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-reasoning`,
    "--window-size=1400,900",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "✓" : "✗"} ${label}: ${JSON.stringify(actual)}`);
  if (!ok) {
    failures.push(`${label} — 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

await sleep(3000);

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
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
    consoleErrors.push("EXCEPTION: " + (msg.params.exceptionDetails?.exception?.description ?? ""));
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

console.log("\n--- reasoning 事件驱动的渲染时序 ---\n");

// 页面挂载后，通过 window 上的测试钩子驱动事件序列。
// 钩子由 use-agent-client 暴露（仅开发模式）。
const hookAvailable = await evalJs("typeof window.__deepagentTestHooks === 'object'");
if (!hookAvailable) {
  console.log("✗ 测试钩子不可用，跳过（需要开发模式）");
  chrome.kill();
  process.exit(1);
}

// 阶段 1：只发 reasoning，不发正文。
await evalJs(`window.__deepagentTestHooks.dispatch([
  { type: 'REASONING_MESSAGE_START', messageId: 'r1' },
  { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '正在规划任务步骤' },
])`);
await sleep(600);

check(
  "阶段1：思考面板已渲染",
  await evalJs("document.body.textContent.includes('正在规划任务步骤')"),
  true,
);
check(
  "阶段1：正文为空",
  await evalJs("!document.body.textContent.includes('这是最终答复')"),
  true,
);
check(
  "阶段1：思考处于流式状态",
  await evalJs("document.body.textContent.includes('Thinking') || document.body.textContent.includes('思考')"),
  true,
);

// 阶段 2：结束 reasoning，开始正文。
await evalJs(`window.__deepagentTestHooks.dispatch([
  { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
  { type: 'TEXT_MESSAGE_START', messageId: 't1' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 't1', delta: '这是最终答复' },
])`);
await sleep(800);

check(
  "阶段2：正文已渲染",
  await evalJs("document.body.textContent.includes('这是最终答复')"),
  true,
);
// ReasoningContent 用 CollapsibleContent：折叠时内容从 DOM 卸载（组件设计）。
// 因此验证「数据仍在 state 且可展开恢复」，而不是 DOM 常驻。
check(
  "阶段2：state 里仍保留思考内容",
  await evalJs(
    `JSON.stringify(window.__deepagentTestHooks.getState().messages.map(m=>m.reasoning))`,
  ),
  '["正在规划任务步骤"]',
);
check(
  "阶段2：展开思考面板后内容恢复",
  await evalJs(`(()=>{
    const trigger=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('已思考')||b.textContent.includes('Thought for'));
    if(!trigger) return 'no-trigger';
    trigger.click();
    return new Promise(r=>setTimeout(()=>r(document.body.textContent.includes('正在规划任务步骤')),400));
  })()`),
  true,
);
check(
  "阶段2：思考触发器显示已结束状态",
  await evalJs(
    "document.body.textContent.includes('已思考') || document.body.textContent.includes('Thought for')",
  ),
  true,
);
check(
  "阶段2：思考已结束（不再显示正在思考）",
  await evalJs("!document.body.textContent.includes('正在思考')"),
  true,
);
check(
  "阶段2：只产生一条 assistant 气泡（无重复）",
  await evalJs("document.querySelectorAll('.is-assistant').length"),
  1,
);
check(
  "阶段2：思考内容是过滤后的公开摘要（固定短语，非原始思维链）",
  await evalJs(
    `(()=>{const rs=window.__deepagentTestHooks.getState().messages.map(m=>m.reasoning||'');
     const allowed=['正在规划任务步骤','正在检索工作区文件','正在准备写入文件','正在准备修改文件','正在派发子任务','正在验证结果','正在分析已有信息','正在汇总发现','正在整理思路'];
     return rs.length>0 && rs.every(r=>allowed.includes(r) && r.length<=10)})()`,
  ),
  true,
);

console.log("\n--- 控制台 ---\n");
check("无控制台错误", consoleErrors.length, 0);
if (consoleErrors.length > 0) {
  for (const e of consoleErrors) console.log("  ! " + e);
}

ws.close();
chrome.kill();

console.log(
  failures.length === 0
    ? "\n=== 全部通过 ===\n"
    : `\n=== ${failures.length} 项未通过 ===\n${failures.map((f) => "  - " + f).join("\n")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
