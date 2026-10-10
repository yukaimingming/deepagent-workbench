/**
 * 自动化端到端测试与截屏验证脚本。
 *
 * 使用 Chrome DevTools Protocol (CDP)：
 * 1. 验证新 UI 整体布局（包含展开侧边栏、新建对话按钮、工作区展示、AI Elements 欢迎卡片）
 * 2. 验证侧边栏收缩/展开切换
 * 3. 验证自定义工作区路径与文件树
 * 4. 验证真实对话交互（流式思考中、工具调用、正文流式渲染与历史会话自动更新）
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--remote-debugging-port=9398",
    `--user-data-dir=${process.env.TEMP}/cdp-verify-${Date.now()}`,
    "--window-size=1500,950",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(3000);

let ws;
let chromeProcessKilled = false;

function cleanup() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  if (!chromeProcessKilled) {
    chromeProcessKilled = true;
    try {
      chrome.kill();
    } catch {}
  }
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

try {
  const list = await fetch("http://127.0.0.1:9398/json/list").then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 Chrome 页面目标");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  let id = 0;
  const pend = new Map();
  const consoleErrors = [];

  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" "));
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const i = ++id;
      pend.set(i, resolve);
      ws.send(JSON.stringify({ id: i, method, params }));
    });

  const ev = async (expr) =>
    (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))
      .result?.result?.value;

  const capture = async (name) => {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    fs.writeFileSync(`screenshot-${name}.png`, buffer);
    console.log(`[截屏成功] 已保存 screenshot-${name}.png (${(buffer.length / 1024).toFixed(1)} KB)`);
  };

  await send("Runtime.enable");
  await send("Page.enable");

  console.log("[1/5] 打开前端页面 http://127.0.0.1:5173/ ...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  await sleep(4000);

  // 1. 概览截图（侧边栏展开，新加对话按钮在侧边栏，AI Elements 欢迎界面）
  console.log("[2/5] 验证侧边栏展开布局与新 UI 概览...");
  await capture("1-expanded-overview");

  // 2. 测试侧边栏收缩模式
  console.log("[3/5] 测试侧边栏收缩功能...");
  await ev(`document.querySelector("button[title='收起侧边栏']")?.click()`);
  await sleep(1000);
  await capture("2-sidebar-collapsed");

  // 重新展开侧边栏
  await ev(`document.querySelector("button[title='展开侧边栏']")?.click()`);
  await sleep(1000);

  // 3. 测试切换到工作区面板，展开自定义路径输入
  console.log("[4/5] 测试工作区面板与自定义选择文件夹...");
  await ev(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("工作区"))?.click()`);
  await sleep(1000);
  await ev(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("自定义路径"))?.click()`);
  await sleep(800);
  await capture("3-workspace-custom");

  // 切换回对话列表，准备发送对话
  await ev(`[...document.querySelectorAll("button")].find(b => b.textContent.includes("历史会话"))?.click()`);
  await sleep(500);

  // 4. 输入任务并发送，测试真实对话与流式思考中
  console.log("[5/5] 输入任务并发送消息验证思考中与流式交互...");
  await ev(`document.querySelector("textarea")?.focus()`);
  await sleep(300);
  await send("Input.insertText", { text: "帮我用一句话说明什么是闭包并给个简单示例" });
  await sleep(500);

  // 回车发送
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

  // 等待流式产生
  await sleep(5000);
  await capture("4-streaming");

  // 等待回答完成
  console.log("等待助手回答完成...");
  await sleep(20000);
  await capture("5-final-result");

  console.log("\n====== 验证结果 ======");
  console.log("控制台错误数:", consoleErrors.length);
  for (const err of consoleErrors.slice(0, 5)) {
    console.log("  -", err.slice(0, 200));
  }
} catch (error) {
  console.error("执行截屏脚本失败:", error);
} finally {
  cleanup();
}
