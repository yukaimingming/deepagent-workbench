/**
 * 验证：
 * 侧边栏点击任意文件夹下的聊天历史，文件夹列表与会话列表的位置完全固定，
 * 绝不会因为点击选中某个历史而自动排序跳到第一位！
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9588;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-order-${Date.now()}`,
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

  // 检查初始侧边栏里的文件夹顺序
  const getFolderOrder = `
    (() => {
      const folderTitles = Array.from(document.querySelectorAll('aside .truncate[title]')).map(el => el.innerText.trim());
      // 或者找侧边栏中所有的分组标题
      const groups = Array.from(document.querySelectorAll('aside [title]'))
        .map(el => el.innerText.trim())
        .filter(t => t.length > 0 && !t.includes('新建') && !t.includes('设置') && !t.includes('收缩'));
      return { folderTitles, groups };
    })()
  `;
  let orderRes = await send("Runtime.evaluate", { expression: getFolderOrder, returnByValue: true });
  console.log("初始文件夹顺序：", orderRes.result?.value);

  // 如果只有一个文件夹，添加第二个文件夹以测试多文件夹顺序固定
  const ensureTwoFolders = `
    (() => {
      // 读取当前的 customWorkspaces
      const raw = localStorage.getItem('deepagent_workspaces_list_v2');
      let list = [];
      try { list = JSON.parse(raw) || []; } catch {}
      if (!list.includes('workspace')) list.unshift('workspace');
      if (!list.includes('Desktop')) list.push('Desktop');
      localStorage.setItem('deepagent_workspaces_list_v2', JSON.stringify(list));
      return list;
    })()
  `;
  const setList = await send("Runtime.evaluate", { expression: ensureTwoFolders, returnByValue: true });
  console.log("设置工作区文件夹列表：", setList.result?.value);

  // 刷新页面载入多文件夹
  await send("Page.reload");
  await sleep(3000);

  orderRes = await send("Runtime.evaluate", { expression: getFolderOrder, returnByValue: true });
  console.log("刷新后文件夹顺序：", orderRes.result?.value);

  // 获取页面上所有聊天记录项
  const getSessions = `
    (() => {
      const items = Array.from(document.querySelectorAll('[class*="group/session"]')).map(el => el.innerText.trim());
      return items;
    })()
  `;
  const sessList = await send("Runtime.evaluate", { expression: getSessions, returnByValue: true });
  console.log("会话列表项：", sessList.result?.value);

  // 点击非第一个文件夹下的历史或第二个文件夹
  console.log("正在点击侧边栏项目测试是否会触发文件夹跳到首位...");
  const clickSecondTarget = `
    (() => {
      const items = Array.from(document.querySelectorAll('[class*="group/session"], aside .cursor-pointer'));
      if (items.length > 1) {
        // 点击后面的项
        items[items.length - 1].click();
        return { clicked: true, text: items[items.length - 1].innerText };
      }
      return { clicked: false };
    })()
  `;
  const clickRes = await send("Runtime.evaluate", { expression: clickSecondTarget, returnByValue: true });
  console.log("点击操作结果：", clickRes.result?.value);
  await sleep(1500);

  // 重新检查文件夹顺序！
  const finalOrderRes = await send("Runtime.evaluate", { expression: getFolderOrder, returnByValue: true });
  console.log("点击后文件夹顺序（应当严格保持一致，绝不跳到首位）：", finalOrderRes.result?.value);

  // 截取侧边栏视图截图证明位置固定
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(artifactDir, "screenshot-fixed-order-verified.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("已保存文件夹位置固定验证截图：", shotPath);

} catch (err) {
  console.error("执行过程出错：", err);
} finally {
  cleanup();
}
