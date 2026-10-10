/**
 * 专门验证思考闪光2秒（Shimmer）、任务列表队列（Queue / Todo）与工具调用卡片（Tool）：
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9544;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-shimmer-${Date.now()}`,
    "--window-size=1550,980",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(3000);

let ws;
function cleanup() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  try {
    chrome.kill();
  } catch {}
}

try {
  const list = await fetch(`http://127.0.0.1:${chromePort}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 Chrome 页面目标");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.on("open", resolve));

  let id = 0;
  const pend = new Map();
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pend.has(m.id)) {
      pend.get(m.id)(m);
      pend.delete(m.id);
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

  const capture = async (filename) => {
    const res = await send("Page.captureScreenshot", { format: "png" });
    const buffer = Buffer.from(res.result.data, "base64");
    fs.writeFileSync(filename, buffer);
    console.log(`[截屏成功] 已保存 ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  await sleep(4000);

  // 1. 初始化 localStorage 注入文件夹和会话模拟数据（对齐用户侧边栏图）
  await ev(`(() => {
    const ws = ["d:\\\\temp\\\\aiagent", "d:\\\\temp\\\\Desktop", "d:\\\\temp\\\\langchain\\\\workspace"];
    localStorage.setItem("deepagent_workspaces_list_v2", JSON.stringify(ws));
    const s1 = { id: "s-1", title: "Shell与待办任务综合执行", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 2, workspaceRoot: "d:\\\\temp\\\\langchain\\\\workspace", folderName: "workspace" };
    localStorage.setItem("deepagent_sessions_list_v2", JSON.stringify([s1]));
    location.reload();
  })()`);
  await sleep(3500);

  // 确保没有遮罩弹窗（如有按 Esc 关闭）
  await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(500);

  // 2. 聚焦输入框并输入指令
  console.log("输入任务指令...");
  const prompt = "请使用 write_todos 规划3项待办，并使用 execute 工具执行 dir 命令查看工作区文件";
  await ev(`document.querySelector("textarea")?.focus()`);
  await sleep(300);
  await send("Input.insertText", { text: prompt });
  await sleep(500);

  // 3. 回车发送消息
  console.log("回车发送指令...");
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

  // 4. 发送后约 1.8 秒：精准捕获思考闪光 2 秒微光动效（Shimmer duration={2} 思考中...）
  await sleep(1800);
  await capture("screenshot-thinking-shimmer-2s.png");
  console.log("✓ 已捕获思考闪光动效截图！");

  // 5. 约 8 秒后：捕获 Queue 待办任务队列组件与 Tool 工具调用卡片
  console.log("等待工具调用、Queue 任务列表与回答...");
  await sleep(8000);
  await capture("screenshot-queue-tasks-and-tools.png");
  console.log("✓ 已捕获任务队列与工具调用卡片截图！");

  // 6. 约 18 秒后：生成结束保留思考卡片与最终回答
  await sleep(14000);
  await capture("screenshot-completion-final.png");
  console.log("✓ 已捕获生成结束最终状态截图！");

  // 7. 滚动到页面顶部，展开折叠的已思考完成卡片
  console.log("滚动到顶部并展开已思考完成卡片...");
  await ev(`(() => {
    const scroller = document.querySelector("[data-slot='conversation-content']") || document.querySelector(".overflow-y-auto");
    if (scroller) scroller.scrollTop = 0;
    const triggers = Array.from(document.querySelectorAll("button[data-slot='collapsible-trigger']"));
    triggers.forEach(t => t.click());
  })()`);
  await sleep(1000);
  await capture("screenshot-reasoning-expanded.png");
  console.log("✓ 已捕获思考折叠展开详情截图！");

  console.log("全部截屏验证执行完毕！");
} catch (error) {
  console.error("执行异常:", error);
} finally {
  cleanup();
}
