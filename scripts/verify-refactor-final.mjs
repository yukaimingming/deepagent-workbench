/**
 * 验证最终重构效果并截取高分辨率全景图片：
 * 1. 验证侧边栏文件夹分组、小圆圈与高亮胶囊样式（参考用户截图）
 * 2. 验证去头像、纯黑底色、输入框内嵌思考等级排版、去掉右上角设置
 * 3. 验证思考过程（Reasoning）与工具调用（Tool）的实时渲染
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
    "--remote-debugging-port=9499",
    `--user-data-dir=${process.env.TEMP}/cdp-refactor-${Date.now()}`,
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
  const list = await fetch("http://127.0.0.1:9499/json/list").then((r) => r.json());
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

  // 1. 先注入几个参考截图中的模拟工作区文件夹，使视觉效果与用户截图完全一致
  console.log("注入工作区文件夹（aiagent, Desktop, langchain 等）...");
  await ev(`(() => {
    try {
      const ws = ["d:\\\\temp\\\\aiagent", "d:\\\\temp\\\\Desktop", "d:\\\\temp\\\\langchain\\\\workspace", "d:\\\\temp\\\\medinterface"];
      localStorage.setItem("deepagent_workspaces_list_v2", JSON.stringify(ws));
      
      const s1 = { id: "s-1", title: "项目技术与原理分析", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 2, workspaceRoot: "d:\\\\temp\\\\aiagent", folderName: "aiagent" };
      const s2 = { id: "s-2", title: "Claude Code token分析", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 1, workspaceRoot: "d:\\\\temp\\\\Desktop", folderName: "Desktop" };
      const s3 = { id: "s-3", title: "基于 agents.md 的开发规范", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 4, workspaceRoot: "d:\\\\temp\\\\langchain\\\\workspace", folderName: "workspace" };
      const s4 = { id: "s-4", title: "details 接口排序优化", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 3, workspaceRoot: "d:\\\\temp\\\\medinterface", folderName: "medinterface" };
      const s5 = { id: "s-5", title: "Oracle视图查询API接口", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 2, workspaceRoot: "d:\\\\temp\\\\medinterface", folderName: "medinterface" };
      
      localStorage.setItem("deepagent_sessions_list_v2", JSON.stringify([s1, s2, s3, s4, s5]));
      location.reload();
    } catch (e) {
      console.error(e);
    }
  })()`);
  await sleep(4000);

  // 截取侧边栏分组树形展示
  await capture("screenshot-refactor-1-sidebar-tree.png");

  // 2. 点击“添加文件夹”以展示自定义输入选择本地文件夹作为工作区的能力
  console.log("展示添加文件夹面板...");
  await ev(`document.querySelector("button[title='点击切换或添加工作区文件夹']")?.click()`);
  await sleep(1000);
  await capture("screenshot-refactor-2-add-folder.png");

  // 关闭添加文件夹面板
  await ev(`document.querySelector("button[title='点击切换或添加工作区文件夹']")?.click()`);
  await sleep(500);

  // 3. 点击新建对话并在输入框中输入消息，验证思考等级嵌入输入框内部底部的排版
  console.log("在输入框中输入内容验证底部排版...");
  await ev(`document.querySelector("textarea")?.focus()`);
  await sleep(300);
  await send("Input.insertText", {
    text: "帮我用一句话解释什么是闭包，并给出一个实用的代码示例",
  });
  await sleep(500);
  await capture("screenshot-refactor-3-input-layout.png");

  // 4. 发送消息，观察流式思维链和真实回答
  console.log("回车发送消息...");
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

  // 等待流式思考与生成
  console.log("等待流式生成与思考展示...");
  await sleep(6000);
  await capture("screenshot-refactor-4-streaming.png");

  // 等待最终答复完成
  console.log("等待回答完成...");
  await sleep(22000);
  await capture("screenshot-refactor-5-completed.png");

  // 5. 点击展开思考（Reasoning）查看思维链文本
  console.log("展开思考卡片查看思维链详细内容...");
  await ev(`document.querySelector("button[data-slot='collapsible-trigger']")?.click()`);
  await sleep(1000);
  await capture("screenshot-refactor-6-reasoning-expanded.png");

  console.log("所有重构验证截屏已成功完成！");
} catch (error) {
  console.error("执行验证异常:", error);
} finally {
  cleanup();
}
