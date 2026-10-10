/**
 * 浏览器端到端验证：一个会话正在执行时新建对话，不会打断它。
 *
 * 验证点（对应用户需求第 3 条）：
 * 1. 会话 A 运行中时新建对话，A 必须继续执行（侧边栏显示「执行中」）。
 * 2. 新会话 B 可以立即发起自己的任务，两个运行互不干扰。
 * 3. 切回会话 A 能看到它自己的完整结果，内容不与 B 串味。
 *
 * 全程使用本地假模型服务（OpenAI 兼容 SSE），不访问真实模型 API。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import WebSocket from "ws";
import fs from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const APP_URL = process.env.VERIFY_APP_URL ?? "http://127.0.0.1:5175/";
const API = "http://127.0.0.1:8787";
const FAKE_MODEL = "fake-stream-model";
const PROVIDER_LABEL = `并发验证厂商-${Date.now().toString().slice(-5)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 1. 本地假模型服务：按会话内容流式回不同文本 ---------- */

const CHUNK_DELAY_MS = 500;
const CHUNK_COUNT = 18;

const fakeModel = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += String(c)));
  req.on("end", async () => {
    const isA = body.includes("会话A的测试问题");
    const isB = body.includes("会话B的测试问题");
    const tag = isA ? "A" : isB ? "B" : "X";
    const text = `这是会话${tag}的回复内容。`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const base = {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: FAKE_MODEL,
    };
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] })}\n\n`,
    );
    // 逐字慢速输出，给「运行中新建对话」留出充足的操作窗口。
    for (let i = 0; i < CHUNK_COUNT; i += 1) {
      if (res.destroyed) return;
      await sleep(CHUNK_DELAY_MS);
      const ch = text[i % text.length];
      res.write(
        `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: ch }, finish_reason: null }] })}\n\n`,
      );
    }
    res.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => fakeModel.listen(0, "127.0.0.1", r));
const fakePort = fakeModel.address().port;
console.log("假模型服务端口:", fakePort);

/* ---------- 2. 注册临时提供商 ---------- */

const createRes = await fetch(`${API}/api/providers`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    type: "openai-compatible",
    label: PROVIDER_LABEL,
    baseUrl: `http://127.0.0.1:${fakePort}/v1`,
    apiKey: "sk-fake-local",
    models: [FAKE_MODEL],
    defaultModel: FAKE_MODEL,
    enabled: true,
  }),
});
if (createRes.status !== 201) throw new Error(`创建临时提供商失败: ${createRes.status}`);
const tempProviderId = (await createRes.json()).provider.id;
console.log("临时提供商:", tempProviderId);

/* ---------- 3. 启动浏览器 ---------- */

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=9394",
    `--user-data-dir=${process.env.TEMP}/cdp-verify-concurrent`,
    "--window-size=1500,950",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);
await sleep(3000);

const targets = await fetch("http://127.0.0.1:9394/json/list").then((r) => r.json());
const page = targets.find((t) => t.type === "page");
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

const results = [];
const check = (name, value, extra = "") => {
  results.push([name, value]);
  console.log(`${value ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

await send("Runtime.enable");
await send("Page.enable");
// 强制使用假模型，避免依赖用户当前选中的模型。
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `window.__deepagentForceModel = ${JSON.stringify(FAKE_MODEL)};`,
});
await send("Page.navigate", { url: APP_URL });
await sleep(7000);

check("页面挂载成功", await ev("document.getElementById('root')?.children.length > 0"));

/* ---------- 4. 选中临时提供商 ---------- */

await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('模型与提供商设置'));
  b?.click();
})()`);
await sleep(800);
const selected = await ev(`(() => {
  const b = [...document.querySelectorAll('[role=dialog] button')].find((n) => n.textContent.includes(${JSON.stringify(PROVIDER_LABEL)}));
  if (!b) return false; b.click(); return true;
})()`);
check("在设置中选中临时提供商", selected);
await sleep(600);
await ev(`document.querySelector('[role=dialog] button[aria-label="关闭"]')?.click()`);
await sleep(600);

/** 在输入框里写入并提交（聚焦 → 原生 setter → 点击提交按钮）。 */
const sendMessage = async (text) => {
  const filled = await ev(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return false;
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(text)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (!filled) throw new Error("未找到输入框");
  await sleep(400);
  const submitted = await ev(`(() => {
    const btn = document.querySelector('form button[type="submit"]');
    if (!btn || btn.disabled) return false;
    btn.click();
    return true;
  })()`);
  if (!submitted) {
    // 兜底：直接回车
    for (const type of ["rawKeyDown", "keyUp"]) {
      await send("Input.dispatchKeyEvent", {
        type,
        key: "Enter",
        code: "Enter",
        windowsVirtualKeyCode: 13,
        nativeVirtualKeyCode: 13,
      });
    }
  }
  await sleep(300);
};

/** 侧边栏里正在执行的会话标题列表。 */
const runningTitles = () =>
  ev(`(() => {
    return [...document.querySelectorAll('aside .group\\\\/session')]
      .filter((n) => n.textContent.includes('执行中'))
      .map((n) => n.querySelector('span.truncate')?.textContent ?? '');
  })()`);

/* ---------- 5. 会话 A 发起长任务 ---------- */

await sendMessage("会话A的测试问题");
await sleep(2500);
check("会话 A 已进入运行中", (await runningTitles()).length >= 1, JSON.stringify(await runningTitles()));
await shot("concurrent-1-A-running");

/* ---------- 6. 运行中新建对话 ---------- */

await ev(`document.querySelector('button[title="新建对话"]')?.click()`);
await sleep(800);

const stateAfterNew = await ev(`(() => ({
  runningCount: [...document.querySelectorAll('aside .group\\\\/session')].filter((n) => n.textContent.includes('执行中')).length,
  activeEmpty: document.body.textContent.includes('新对话'),
  headerRunning: /运行中|执行中|在后台运行/.test(document.querySelector('header')?.textContent ?? ''),
}))()`);
check("新建对话后，会话 A 仍在后台执行", stateAfterNew.runningCount >= 1, JSON.stringify(stateAfterNew));
check("新会话是空会话（未被 A 的内容污染）", stateAfterNew.activeEmpty === true);
await shot("concurrent-2-new-session-while-running");

/* ---------- 7. 新会话 B 立即发起自己的任务 ---------- */

await sendMessage("会话B的测试问题");
await sleep(2000);
const bothRunning = await runningTitles();
check("两个会话可以同时执行", bothRunning.length >= 2, JSON.stringify(bothRunning));
await shot("concurrent-3-both-running");

/* ---------- 8. 等待两个运行结束 ---------- */

await sleep(20000);
const stillRunning = await runningTitles();
check("两个运行都已结束", stillRunning.length === 0, JSON.stringify(stillRunning));

/** 当前会话的助手回复文本。 */
const currentAnswer = () =>
  ev(`(() => {
    const nodes = [...document.querySelectorAll('.is-assistant, [data-role="assistant"]')];
    const last = nodes.at(-1) ?? document.querySelector('section') ;
    return (last?.textContent ?? '').slice(0, 200);
  })()`);

const answerB = await currentAnswer();
check("会话 B 看到自己的回复", answerB.includes("这是会话B的回复内容"), answerB.slice(0, 60));
await shot("concurrent-4-B-done");

/* ---------- 9. 切回会话 A，内容必须是 A 自己的 ---------- */

await ev(`(() => {
  const b = [...document.querySelectorAll('aside .group\\\\/session')]
    .find((n) => n.textContent.includes('会话A的测试问题'));
  b?.click();
})()`);
await sleep(1200);
const answerA = await currentAnswer();
check("切回会话 A 后能看到 A 自己的完整回复", answerA.includes("这是会话A的回复内容"), answerA.slice(0, 60));
check("会话 A 的内容没有被 B 串味", !answerA.includes("这是会话B"), answerA.slice(0, 60));
await shot("concurrent-5-A-restored");

console.log("\n控制台错误数:", errs.length);
for (const e of errs) console.log("  !", String(e).slice(0, 300));

/* ---------- 清理 ---------- */

await fetch(`${API}/api/providers/${tempProviderId}`, { method: "DELETE" });
console.log("已清理临时提供商");

const failed = results.filter(([, v]) => !v).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);

ws.close();
chrome.kill();
fakeModel.close();
process.exit(failed === 0 && errs.length === 0 ? 0 : 1);
