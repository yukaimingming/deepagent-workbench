/**
 * 验证在不同文件夹与不同历史会话之间反复切换点击，位置始终固定
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9599;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-order2-${Date.now()}`,
    "--window-size=1550,980",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(2500);

let ws;
function cleanup() {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  try {
    chrome.kill();
  } catch {}
}

const artifactDir = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

try {
  const list = await fetch(`http://127.0.0.1:${chromePort}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 Chrome 页面");

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
      const msgId = ++id;
      pend.set(msgId, (res) => resolve(res.result));
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send("Page.enable");
  await send("DOM.enable");
  await send("Runtime.enable");

  console.log("正在加载前端页面 http://127.0.0.1:5173 ...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(3500);

  // 获取当前侧边栏主分组名列表
  const getFolderNames = `
    (() => {
      // 获取侧边栏内所有的文件夹分组标题（排除顶部导航栏）
      const titles = Array.from(document.querySelectorAll('aside .overflow-y-auto .truncate'))
        .map(el => el.innerText.trim())
        .filter(t => t.length > 0 && !t.includes('新对话') && !t.includes('你好') && !t.includes('介绍'));
      return titles;
    })()
  `;

  const beforeClick = await send("Runtime.evaluate", { expression: getFolderNames, returnByValue: true });
  console.log("点击前文件夹顺序：", beforeClick.result?.value);

  // 点击第二个文件夹下的项目
  const clickBottomItem = `
    (() => {
      const allItems = Array.from(document.querySelectorAll('aside .overflow-y-auto div[class*="group"]'));
      if (allItems.length > 1) {
        allItems[allItems.length - 1].click();
        return true;
      }
      return false;
    })()
  `;
  await send("Runtime.evaluate", { expression: clickBottomItem, returnByValue: true });
  await sleep(1000);

  const afterClick1 = await send("Runtime.evaluate", { expression: getFolderNames, returnByValue: true });
  console.log("点击下方项目后文件夹顺序：", afterClick1.result?.value);

  // 再点击上方第一个项目
  const clickTopItem = `
    (() => {
      const allItems = Array.from(document.querySelectorAll('aside .overflow-y-auto div[class*="group"]'));
      if (allItems.length > 0) {
        allItems[0].click();
        return true;
      }
      return false;
    })()
  `;
  await send("Runtime.evaluate", { expression: clickTopItem, returnByValue: true });
  await sleep(1000);

  const afterClick2 = await send("Runtime.evaluate", { expression: getFolderNames, returnByValue: true });
  console.log("点击上方项目后文件夹顺序：", afterClick2.result?.value);

  // 截取固定顺序的清晰侧边栏截图
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(artifactDir, "screenshot-fixed-order-verified.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("已保存固定顺序核验截图：", shotPath);

} catch (err) {
  console.error("执行过程出错：", err);
} finally {
  cleanup();
}
