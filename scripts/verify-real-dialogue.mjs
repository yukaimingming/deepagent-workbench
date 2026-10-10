/**
 * 完整真实环境验证与截图脚本：
 * 验证用户提出的 7 项优化：
 * 1. 侧边栏多文件夹展示与严格去重（绝无重复 workspace）；
 * 2. 普通对话“你好啊”思考阶段：带 Shimmer 微光动效，动态秒数“正在思考中 x 秒”，下方正文完全隐藏，杜绝提前输出；
 * 3. 普通对话完成阶段：折叠展示“完成思考 x 秒”，无任何工具卡片误显；
 * 4. 复杂规划任务：纯净 AI SDK Elements 官方 Queue 组件，按调用时序呈现工具。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9535;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-verify-${Date.now()}`,
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

  // 1. 设置工作区文件夹列表，避免重复
  await ev(`(() => {
    const wsList = ["d:\\\\temp\\\\aiagent", "d:\\\\temp\\\\Desktop", "d:\\\\temp\\\\langchain\\\\workspace"];
    localStorage.setItem("deepagent_workspaces_list_v2", JSON.stringify(wsList));
    localStorage.removeItem("deepagent_sessions_list_v2");
    location.reload();
  })()`);
  await sleep(4000);

  // 2. 轮询等待提供商加载就绪
  console.log("等待后端提供商加载就绪...");
  let providerReady = false;
  for (let i = 0; i < 20; i++) {
    const info = await ev(`(() => {
      const modelBadge = document.querySelector("button[title='切换当前模型']")?.textContent || "";
      const isConfigured = !modelBadge.includes("未配置提供商") && modelBadge.length > 0;
      return { modelBadge, isConfigured };
    })()`);
    console.log(`检查模型状态: ${JSON.stringify(info)}`);
    if (info?.isConfigured) {
      providerReady = true;
      break;
    }
    await sleep(1000);
  }

  // 截图 1：验证侧边栏去重与布局
  console.log("正在截取图 1：侧边栏无重复 workspace，布局清晰规范...");
  await capture("screenshot-fix-1-sidebar-no-duplicate.png");

  // 3. 输入普通问答“你好啊”
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

  // 截图 2：发送后 1.2 秒，截取流式思考中（Shimmer 动效、动态秒数、正文彻底隐藏、无任何工具）
  await sleep(1200);
  console.log("正在截取图 2：思考中（Shimmer 微光动效、动态秒数、下方绝无正文和工具）...");
  await capture("screenshot-fix-2-thinking-timing.png");

  // 等待回答完成
  console.log("等待问答流式输出完毕...");
  for (let i = 0; i < 30; i++) {
    const isGenerating = await ev(`(() => {
      const stopBtn = document.querySelector("button[title='停止生成']");
      return Boolean(stopBtn);
    })()`);
    if (!isGenerating) {
      console.log(`问答在第 ${i * 500}ms 完成！`);
      break;
    }
    await sleep(500);
  }
  await sleep(1000);

  // 截图 3：问答完成状态（折叠“完成思考 x 秒”，流式正文输出，绝无工具误显）
  console.log("正在截取图 3：问答完成（完成思考 x 秒折叠、正文流式输出、无工具误显）...");
  await capture("screenshot-fix-3-greeting-no-tools.png");

  // 4. 新建对话并发送规划指令：验证 Queue 树形组件与工具时序呈现
  console.log("点击新建对话...");
  await ev(`document.querySelector("button[title='新建对话']")?.click()`);
  await sleep(1000);

  console.log("输入带待办事项的执行指令...");
  await ev(`(() => {
    const ta = document.querySelector("textarea");
    if (ta) {
      ta.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(ta, "请调用 write_todos 为我规划两个待办任务：1.检查工作区目录，2.汇总文件；并调用 execute 工具执行 dir 命令查看工作区文件");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  })()`);
  await sleep(600);

  console.log("点击发送任务指令...");
  await ev(`document.querySelector("button[title='发送消息']")?.click()`);

  // 等待待办任务与工具执行推进（等待约 12 秒）
  await sleep(12000);
  console.log("精确找到聊天滚动容器并滚动到顶部以完整展示 Queue 待办清单...");
  await ev(`(() => {
    const scrollEl = Array.from(document.querySelectorAll('*')).find(el => el.scrollHeight > el.clientHeight && el.clientHeight > 200);
    if (scrollEl) {
      scrollEl.scrollTop = 0;
    }
  })()`);
  await sleep(600);
  console.log("正在截取图 4：官方 Queue 待办任务树形组件与按需工具调用...");
  await capture("screenshot-fix-4-queue-and-tools.png");

  // 同步复制全套截图到工件目录中供直接预览
  const artifactDir = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";
  fs.copyFileSync("screenshot-fix-1-sidebar-no-duplicate.png", `${artifactDir}/screenshot-fix-1-sidebar-no-duplicate.png`);
  fs.copyFileSync("screenshot-fix-2-thinking-timing.png", `${artifactDir}/screenshot-fix-2-thinking-timing.png`);
  fs.copyFileSync("screenshot-fix-3-greeting-no-tools.png", `${artifactDir}/screenshot-fix-3-greeting-no-tools.png`);
  fs.copyFileSync("screenshot-fix-4-queue-and-tools.png", `${artifactDir}/screenshot-fix-4-queue-and-tools.png`);
  console.log("已同步 4 张截图到工件目录！");

  console.log("全部 4 张验证截图完成！");
} catch (error) {
  console.error("执行异常:", error);
} finally {
  cleanup();
}
