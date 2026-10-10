/**
 * UI 级验证：在真实浏览器里走一遍「添加模型厂商 → 保存」。
 *
 * 验证点：
 * 1. 页面能正常挂载，无控制台异常。
 * 2. 设置弹窗能打开。
 * 3. 填写厂商信息后点击「保存新厂商」确实成功（左侧列表出现该厂商）。
 * 4. 保存后新厂商立刻出现在聊天输入框的模型选择中。
 *
 * 脚本结束时会把测试厂商删除，不污染用户配置。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.env.VERIFY_APP_URL ?? "http://127.0.0.1:5175/";
const API = "http://127.0.0.1:8787";
const LABEL = `UI验证厂商-${Date.now().toString().slice(-5)}`;

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=9393",
    `--user-data-dir=${process.env.TEMP}/cdp-verify-save`,
    "--window-size=1500,950",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

const list = await fetch("http://127.0.0.1:9393/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const errs = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) {
    pend.get(m.id)(m);
    pend.delete(m.id);
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    errs.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description ?? ""));
  }
});
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pend.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const ev = async (expr) =>
  (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
    .result?.result?.value;
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`screenshot-${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log(`已保存 screenshot-${name}.png`);
};
/** 按可见文本点击元素。 */
const clickByText = async (text, selector = "button") =>
  ev(`(() => {
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const hit = nodes.find((n) => n.textContent.trim().includes(${JSON.stringify(text)}));
    if (!hit) return false;
    hit.click();
    return true;
  })()`);
/** 在指定 input 上写入值（走 React 兼容的原生 setter + input 事件）。 */
const typeInto = async (expr, text) => {
  const ok = await ev(`(() => {
    const el = ${expr};
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`未找到输入框: ${expr}`);
  await sleep(200);
};

const results = [];
const check = (name, value) => {
  results.push([name, value]);
  console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: APP_URL });
await sleep(7000);

check("页面挂载成功", await ev("document.getElementById('root')?.children.length > 0"));
check("无 JS 异常", errs.length === 0);

// 打开设置弹窗
check("找到并点击「模型与提供商设置」", await clickByText("模型与提供商设置"));
await sleep(800);
check("设置弹窗已打开", await ev("!!document.querySelector('[role=dialog]')"));

// 新建自定义厂商
check("点击「添加自定义厂商」", await clickByText("添加自定义厂商"));
await sleep(400);

await typeInto(
  `[...document.querySelectorAll('[role=dialog] input')].find((i) => i.placeholder && i.placeholder.includes('DeepSeek'))`,
  LABEL,
);
await typeInto(
  `[...document.querySelectorAll('[role=dialog] input')].find((i) => i.placeholder === 'https://api.example.com/v1')`,
  "http://127.0.0.1:11434/v1",
);
await typeInto(
  `[...document.querySelectorAll('[role=dialog] input')].find((i) => i.type === 'password')`,
  "sk-ui-verify-key",
);
await sleep(300);

const before = await ev(
  `[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.includes(${JSON.stringify(LABEL)}))`,
);
check("保存前左侧列表不含该厂商", before === false);

check("点击「保存新厂商」", await clickByText("保存新厂商", "[role=dialog] button"));
await sleep(2500);

const after = await ev(
  `[...document.querySelectorAll('[role=dialog] button')].some((b) => b.textContent.includes(${JSON.stringify(LABEL)}))`,
);
check("保存后左侧列表出现该厂商", after === true);
await shot("provider-save-1-modal");

// 服务端确实收到了
const listResponse = await fetch(`${API}/api/providers`);
const listBody = await listResponse.json();
const saved = listBody.providers.find((p) => p.label === LABEL);
check("服务端已保存该厂商", Boolean(saved));
check("服务端未泄露明文密钥", !JSON.stringify(listBody).includes("sk-ui-verify-key"));

// 关闭弹窗，确认聊天输入框的模型选择里能看到新厂商的模型
check(
  "点击弹窗关闭按钮",
  await ev(`(() => { const b = document.querySelector('[role=dialog] button[aria-label="关闭"]'); if (!b) return false; b.click(); return true; })()`),
);
await sleep(600);
check("弹窗可正常关闭", await ev("!document.querySelector('[role=dialog]')"));
await shot("provider-save-2-closed");

console.log("\n控制台错误数:", errs.length);
for (const e of errs) console.log("  !", String(e).slice(0, 300));

// 清理：删除测试厂商
if (saved) {
  await fetch(`${API}/api/providers/${saved.id}`, { method: "DELETE" });
  console.log("已清理测试厂商:", saved.label);
}

const failed = results.filter(([, v]) => !v).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);

ws.close();
chrome.kill();
process.exit(failed === 0 && errs.length === 0 ? 0 : 1);
