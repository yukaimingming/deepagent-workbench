/** 真实对话 + 截图。 */
import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const chrome = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [
  "--headless", "--disable-gpu", "--no-sandbox",
  "--remote-debugging-port=9390",
  `--user-data-dir=${process.env.TEMP}/cdp-shot2`,
  "--window-size=1500,950", "--hide-scrollbars",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(3000);

const list = await fetch("http://127.0.0.1:9390/json/list").then((r) => r.json());
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pend = new Map();
const errs = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    errs.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    errs.push("EXCEPTION: " + (m.params.exceptionDetails?.exception?.description ?? ""));
  }
});
await new Promise((r) => ws.on("open", r));
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const ev = async (e) => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => {
  const r = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(`screenshot-${name}.png`, Buffer.from(r.result.data, "base64"));
  console.log(`已保存 screenshot-${name}.png`);
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
await sleep(9000);

console.log("root 有内容:", await ev("document.getElementById('root').children.length > 0"));
console.log("模型状态:", await ev("document.body.textContent.match(/[^ ]+ · [^ ]+/)?..[0]"));

// 真实键盘输入并发消息
await ev("document.querySelector('textarea')?.focus()");
await sleep(300);
await send("Input.insertText", { text: "帮我用一句话说明什么是闭包" });
await sleep(500);
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

await sleep(6000);
console.log("运行中状态:", await ev("document.body.textContent.match(/(运行中|已完成|出错)/)?.[0]"));
await shot("1-streaming");

await sleep(25000);
console.log("最终状态:", await ev("document.body.textContent.match(/(运行中|已完成|出错)/)?.[0]"));
console.log("用户消息在:", await ev("document.body.textContent.includes('帮我用一句话说明什么是闭包')"));
console.log("assistant 气泡数:", await ev("document.querySelectorAll('.is-assistant').length"));
console.log("有正文:", await ev("document.querySelector('.is-assistant')?.textContent?.length > 20"));
console.log("控制台错误:", errs.length);
for(const e of errs) console.log("  !", e.slice(0,300));
console.log("错误文本:", await ev("[...document.querySelectorAll('p')].map(p=>p.textContent).find(t=>t.includes('失败')||t.includes('鉴权'))?.slice(0,150)"));
await shot("2-result");

ws.close(); chrome.kill();
