/**
 * 真实历史对话切换耗时定格验证：
 * 验证切换左侧边栏真实历史会话时，右侧时间线耗时完全定格，记录多少就是多少，绝不受其它影响。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";
const chromePort = 9562;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-history-fixed-real-${Date.now()}`,
    "--window-size=1500,950",
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

  const capture = async (filename, clip = null) => {
    const params = { format: "png" };
    if (clip) params.clip = clip;
    const res = await send("Page.captureScreenshot", params);
    const buffer = Buffer.from(res.result.data, "base64");
    const fullPath = path.join(ARTIFACT_DIR, filename);
    fs.writeFileSync(fullPath, buffer);
    console.log(`[截屏成功] 已保存 ${fullPath} (${(buffer.length / 1024).toFixed(1)} KB)`);
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5173/" });
  await sleep(3500);

  // 1. 验证默认选中的会话 1（ca524ade，真实历史耗时 13726ms，即 0分13秒）
  console.log("【步骤 1】验证当前真实历史会话 1（真实记录耗时 13.7秒）的渲染显示...");
  const textSession1 = await ev(`
    document.querySelector(".process-group button")?.innerText || ""
  `);
  console.log(`会话 1 右侧时间线文本: "${textSession1}"`);

  if (!textSession1.includes("已完成分析，用时 0分13秒")) {
    throw new Error(`会话 1 耗时显示异常！预期为 '已完成分析，用时 0分13秒'，实际为: '${textSession1}'`);
  }
  console.log("✓ 会话 1 耗时精准显示为 '已完成分析，用时 0分13秒'，未受当前时间流逝影响！");

  await ev(`document.querySelector(".process-group")?.scrollIntoView({ block: "center" })`);
  await sleep(600);
  await capture("screenshot-history-session1-real-13s.png");

  // 2. 模拟点击左侧边栏的第三个会话（37ccba3e，真实历史耗时 9762ms，即 0分9秒）
  console.log("【步骤 2】点击左侧边栏切换至历史会话 3（37ccba3e，真实记录耗时 9.7秒）...");
  const click3Success = await ev(`
    (() => {
      const el = document.querySelector("[data-session-id='37ccba3e-e204-44b7-8004-1392180edb3d']");
      if (el) {
        el.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("点击会话 3 结果:", click3Success);
  await sleep(2500);

  const textSession3 = await ev(`
    document.querySelector(".process-group button")?.innerText || ""
  `);
  console.log(`会话 3 右侧时间线文本: "${textSession3}"`);

  if (!textSession3.includes("已完成分析，用时 0分9秒")) {
    throw new Error(`会话 3 耗时显示异常！预期为 '已完成分析，用时 0分9秒'，实际为: '${textSession3}'`);
  }
  console.log("✓ 会话 3 耗时精准显示为 '已完成分析，用时 0分9秒'，记录多少就是多少！");

  await ev(`document.querySelector(".process-group")?.scrollIntoView({ block: "center" })`);
  await sleep(600);
  await capture("screenshot-history-session3-real-9s.png");

  // 3. 模拟点击左侧边栏切回会话 1
  console.log("【步骤 3】点击左侧边栏重新切换回会话 1（ca524ade，真实记录耗时 13.7秒）...");
  const click1Success = await ev(`
    (() => {
      const el = document.querySelector("[data-session-id='ca524ade-d781-4ffb-884a-197482de1db1']");
      if (el) {
        el.click();
        return true;
      }
      return false;
    })()
  `);
  console.log("切回会话 1 结果:", click1Success);
  await sleep(2500);

  const textSession1SwitchBack = await ev(`
    document.querySelector(".process-group button")?.innerText || ""
  `);
  console.log(`切回会话 1 后的右侧时间线文本: "${textSession1SwitchBack}"`);

  if (!textSession1SwitchBack.includes("已完成分析，用时 0分13秒")) {
    throw new Error(`切回会话 1 后耗时显示异常！预期为 '已完成分析，用时 0分13秒'，实际为: '${textSession1SwitchBack}'`);
  }
  console.log("✓ 切回会话 1 耗时依然完全定格在 '已完成分析，用时 0分13秒'，绝不受任何切换影响！");

  await ev(`document.querySelector(".process-group")?.scrollIntoView({ block: "center" })`);
  await sleep(600);
  await capture("screenshot-history-session1-switchback-13s.png");

  console.log("\n==========================================");
  console.log("🎉 真实历史对话切换耗时定格测试全部 100% 通过！");
  console.log("记录多少就是多少，不受其它影响！");
  console.log("==========================================");
} catch (e) {
  console.error("验证失败:", e);
  process.exitCode = 1;
} finally {
  cleanup();
}
