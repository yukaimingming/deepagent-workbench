/**
 * 自动化验证所有新增功能并截屏生成验收图：
 * 1. screenshot-main-workbench.png: 主工作台界面（侧边栏专属会话树、纯黑底色、底部模型下拉与思考等级）
 * 2. screenshot-folder-picker-modal.png: 文件夹选择弹窗（纯黑风格、常用路径、树形浏览、无手输负担）
 * 3. screenshot-settings-modal.png: 模型设置弹窗（纯黑风格、添加自定义厂商、一键获取所有模型导入）
 * 4. screenshot-model-dropdown.png: 输入框底部模型下拉展开选择
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
    "--remote-debugging-port=9498",
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
  const list = await fetch("http://127.0.0.1:9498/json/list").then((r) => r.json());
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

  await send("Page.enable");
  await send("Runtime.enable");

  console.log("正在加载前端页面 http://127.0.0.1:5173 ...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(4000);

  // 1. 截取主工作台
  const snap1 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("d:/temp/langchain/screenshot-main-workbench.png", Buffer.from(snap1.result.data, "base64"));
  console.log("✓ 已保存 screenshot-main-workbench.png");

  // 2. 点击“添加文件夹”按钮弹出 FolderPickerModal
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        // 查找包含 FolderPlusIcon 的按钮或标题带有添加工作区文件夹的按钮
        const btn = document.querySelector('button[title*="添加工作区文件夹"]');
        if (btn) btn.click();
      })()
    `,
  });
  await sleep(1500);

  const snap2 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("d:/temp/langchain/screenshot-folder-picker-modal.png", Buffer.from(snap2.result.data, "base64"));
  console.log("✓ 已保存 screenshot-folder-picker-modal.png");

  // 关闭文件夹选择弹窗（点击取消或遮罩）
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const cancelBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('取消'));
        if (cancelBtn) cancelBtn.click();
      })()
    `,
  });
  await sleep(1000);

  // 3. 点击输入框底部的模型下拉按钮
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const modelBtn = document.querySelector('button[title*="点击下拉切换当前模型"]');
        if (modelBtn) modelBtn.click();
      })()
    `,
  });
  await sleep(1000);

  const snap3 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("d:/temp/langchain/screenshot-model-dropdown.png", Buffer.from(snap3.result.data, "base64"));
  console.log("✓ 已保存 screenshot-model-dropdown.png");

  // 4. 打开“模型与提供商设置”弹窗
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const settingsBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('模型与提供商设置') || b.textContent.includes('管理模型与厂商'));
        if (settingsBtn) settingsBtn.click();
      })()
    `,
  });
  await sleep(2000);

  const snap4 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync("d:/temp/langchain/screenshot-settings-modal.png", Buffer.from(snap4.result.data, "base64"));
  console.log("✓ 已保存 screenshot-settings-modal.png");

  console.log("全部功能界面截图验证完成！");
} catch (err) {
  console.error("截屏过程出错:", err);
} finally {
  cleanup();
}
