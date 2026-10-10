import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9644;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env.TEMP}/cdp-shot-2-${Date.now()}`,
    "--window-size=1550,1200",
  ],
  { stdio: "ignore" },
);

await sleep(2000);
const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.on("open", r));

let id = 0;
const send = (method, params = {}) =>
  new Promise((res) => {
    const msgId = ++id;
    const handler = (raw) => {
      const m = JSON.parse(raw);
      if (m.id === msgId) {
        ws.off("message", handler);
        res(m.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

await send("Page.enable");
await send("Page.navigate", { url: "http://127.0.0.1:5173" });
await sleep(3500);

// 查找并点击该历史记录
await send("Runtime.evaluate", {
  expression: `
    (() => {
      const items = Array.from(document.querySelectorAll('.truncate'));
      const target = items.find(el => el.textContent.includes('请使用 execute 或 ls'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    })()
  `,
});
await sleep(2000);

// 向上滚动查看顶部的思考面板和工具卡片
await send("Runtime.evaluate", {
  expression: `
    (() => {
      const scrollContainers = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return style.overflowY === 'auto' || style.overflowY === 'scroll';
      });
      for (const c of scrollContainers) {
        c.scrollTop = 0;
      }
      window.scrollTo(0, 0);
    })()
  `,
});
await sleep(1000);

const shot = await send("Page.captureScreenshot", { format: "png" });
const shotPath =
  "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-ls-fullview-verified.png";
fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
console.log("保存截图成功:", shotPath);

ws.close();
chrome.kill();
