/**
 * 全面验证用户提出的所有修复点：
 * 1. 验证普通问答“你好啊”绝对不输出任何工具，推理中只显示“正在思考中 x 秒”，推理完成后折叠显示“完成思考 x 秒”并流式输出正文；
 * 2. 验证左侧边栏只有一个 workspace（彻底消除两个重复的 workspace）；
 * 3. 验证新建对话不重复产生空白对话，文件夹下新建对话正常响应；
 * 4. 验证工具调用按调用完成状态逐个呈现，待办事项采用纯净官方 Queue 规范。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9522;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-fixes-${Date.now()}`,
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

  // 1. 初始化 localStorage：注入自定义文件夹列表
  await ev(`(() => {
    const ws = ["d:\\\\temp\\\\aiagent", "d:\\\\temp\\\\Desktop", "d:\\\\temp\\\\langchain\\\\workspace"];
    localStorage.setItem("deepagent_workspaces_list_v2", JSON.stringify(ws));
    localStorage.removeItem("deepagent_sessions_list_v2");
    location.reload();
  })()`);
  await sleep(4000);

  // 等待 provider 加载就绪（textarea 不为空且发送按钮可点击）
  console.log("等待提供商就绪...");
  for (let i = 0; i < 20; i++) {
    const canSend = await ev(`(() => {
      const btn = document.querySelector("button[title='发送消息']");
      return btn && !btn.disabled;
    })()`);
    if (canSend) break;
    // 聚焦输入测试文字触发状态刷新
    await ev(`(() => {
      const ta = document.querySelector("textarea");
      if (ta && !ta.value) {
        ta.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
        setter?.call(ta, "test");
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      }
    })()`);
    await sleep(500);
  }

  // 截图 1：验证侧边栏文件夹去重（绝对只有一个 workspace，各文件夹正常展示）
  console.log("捕获侧边栏与去重后的文件夹列表...");
  await capture("screenshot-fix-1-sidebar-no-duplicate.png");

  // 清空测试文本并输入普通问答“你好啊”
  console.log("输入普通问答：你好啊...");
  await ev(`(() => {
    const ta = document.querySelector("textarea");
    if (ta) {
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(ta, "你好啊");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  })()`);
  await sleep(600);

  console.log("点击发送按钮...");
  await ev(`document.querySelector("button[title='发送消息']")?.click()`);

  // 截图 2：发送后 1.5 秒，验证正在思考中 x 秒（带 Shimmer 微光动效，且下方绝对不渲染正文和工具）
  await sleep(1500);
  console.log("捕获思考中计时动效与无正文输出截图...");
  await capture("screenshot-fix-2-thinking-timing.png");

  // 截图 3：等待问答完成，验证完成思考 x 秒折叠、流式输出正文、绝对没有任何工具误显
  await sleep(7000);
  console.log("捕获问答完成截图（验证无工具调用误显、完成思考 x 秒）...");
  await capture("screenshot-fix-3-greeting-no-tools.png");

  // 3. 发送带待办清单的任务：验证纯净 Queue 组件与按需工具调用
  console.log("输入带待办清单的指令...");
  await ev(`(() => {
    const ta = document.querySelector("textarea");
    if (ta) {
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(ta, "请使用 write_todos 拆解 2 个待办任务并开始规划");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  })()`);
  await sleep(600);
  await ev(`document.querySelector("button[title='发送消息']")?.click()`);

  await sleep(10000);
  console.log("捕获纯净 Queue 待办队列与工具调用截图...");
  await capture("screenshot-fix-4-queue-and-tools.png");

  console.log("全套修复点验证截屏执行完毕！");
} catch (error) {
  console.error("执行异常:", error);
} finally {
  cleanup();
}
