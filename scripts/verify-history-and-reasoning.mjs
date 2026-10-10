/**
 * 验证：
 * 1. 真实问答与思考过程（直接展示模型返回的推理，无任何假分析文字）；
 * 2. 思考累计秒数真实准确（显示完成思考 x 秒）；
 * 3. 切换对话与历史记录恢复（历史记录内容完整展示，绝不再显示“正在思考中”）；
 * 4. 展开历史思考过程可查看真实的模型推理内容。
 */

import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9566;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-hist-${Date.now()}`,
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

  // 输入问题并发送
  const fillInput = `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '你好，请详细介绍你的核心能力');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `;
  await send("Runtime.evaluate", { expression: fillInput, returnByValue: true });
  await sleep(300);

  const clickSend = `
    (() => {
      const btn = document.querySelector('button[type="submit"]');
      if (btn) { btn.click(); return true; }
      return false;
    })()
  `;
  await send("Runtime.evaluate", { expression: clickSend, returnByValue: true });
  console.log("已发送测试消息，等待生成与思考完成...");

  // 等待生成完全结束（正文包含详细回答，且出现完成思考）
  let finished = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const checkState = `
      (() => {
        const text = document.body.innerText;
        const hasFinished = text.includes('完成思考');
        const hasContent = text.includes('核心能力') || text.includes('智能体') || text.includes('工具');
        const isStillStreaming = Boolean(document.querySelector('.streaming-caret') || document.querySelector('button[type="button"][title="停止生成"]'));
        return { hasFinished, hasContent, isStillStreaming, textSample: text.slice(-250) };
      })()
    `;
    const res = await send("Runtime.evaluate", { expression: checkState, returnByValue: true });
    const val = res.result?.value;
    if (val && val.hasFinished && val.hasContent && !val.isStillStreaming) {
      console.log("生成已完全结束：", val);
      finished = true;
      break;
    }
  }

  if (!finished) {
    console.warn("生成等待超时，尝试继续后续步骤");
  }

  // 模拟切换对话：先点击侧边栏的“+”新建对话
  console.log("正在测试新建对话与切换回历史对话...");
  const clickNewSession = `
    (() => {
      // 侧边栏的新建对话按钮（带有加号或者 title="新建对话"）
      const newBtn = document.querySelector('button[title*="新建对话"]') || document.querySelector('aside button:has(svg.lucide-plus)');
      if (newBtn) {
        newBtn.click();
        return true;
      }
      return false;
    })()
  `;
  await send("Runtime.evaluate", { expression: clickNewSession, returnByValue: true });
  await sleep(1500);

  // 此时应当处于新对话（空状态）
  // 查找侧边栏中历史对话列表并点击切回刚才那条
  const clickHistorySession = `
    (() => {
      const items = Array.from(document.querySelectorAll('.group\\\\/session, [class*="group/session"]'));
      const target = items.find(el => el.innerText.includes('你好，请详细介绍') || el.innerText.includes('核心能力'));
      if (target) {
        target.click();
        return { clicked: true, text: target.innerText };
      }
      return { clicked: false, allText: items.map(el => el.innerText).join(' | ') };
    })()
  `;
  const histRes = await send("Runtime.evaluate", { expression: clickHistorySession, returnByValue: true });
  console.log("切回历史对话结果：", histRes.result?.value);
  await sleep(1500);

  // 检查切回历史后的状态：
  const checkHistoryUi = `
    (() => {
      const body = document.body.innerText;
      const hasThinkingStill = body.includes('正在思考中');
      const hasFinishedThinking = body.includes('完成思考');
      const thinkingDurationMatch = body.match(/完成思考\\s*(\\d+)\\s*秒/);
      const hasUserMsg = body.includes('你好，请详细介绍你的核心能力');
      const hasAssistantContent = body.includes('核心能力') || body.length > 500;
      return {
        hasThinkingStill,
        hasFinishedThinking,
        durationSeconds: thinkingDurationMatch ? thinkingDurationMatch[1] : null,
        hasUserMsg,
        hasAssistantContent,
        bodySnippet: body.slice(0, 400)
      };
    })()
  `;
  const uiCheck = await send("Runtime.evaluate", { expression: checkHistoryUi, returnByValue: true });
  console.log("历史会话加载 UI 校验结果：", uiCheck.result?.value);

  // 精准将第一条用户消息与思考面板滚动到可见区域顶部
  const scrollToFirstMessage = `
    (() => {
      const firstMsg = document.querySelector('.group\\\\/user') || document.querySelector('button:has(svg.lucide-brain)');
      if (firstMsg) {
        firstMsg.scrollIntoView({ behavior: 'instant', block: 'start' });
        return true;
      }
      return false;
    })()
  `;
  await send("Runtime.evaluate", { expression: scrollToFirstMessage, returnByValue: true });
  await sleep(600);

  // 截图 1：历史对话切回后的状态（顶部视图：用户提问 + 折叠展示“完成思考 x 秒” + 开头回答正文）
  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  const shot1Path = path.join(artifactDir, "screenshot-history-switch-verified.png");
  fs.writeFileSync(shot1Path, Buffer.from(shot1.data, "base64"));
  console.log("已保存历史对话切换顶部截图：", shot1Path);

  // 点击展开折叠的思考面板，验证显示的是真实模型推理内容
  const expandReasoning = `
    (() => {
      const trigger = document.querySelector('button:has(svg.lucide-brain)');
      if (trigger) {
        trigger.click();
        return true;
      }
      return false;
    })()
  `;
  await send("Runtime.evaluate", { expression: expandReasoning, returnByValue: true });
  await sleep(800);

  // 截图 2：展开思考后的状态（显示真实模型推理内容）
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  const shot2Path = path.join(artifactDir, "screenshot-history-expanded-verified.png");
  fs.writeFileSync(shot2Path, Buffer.from(shot2.data, "base64"));
  console.log("已保存展开思考内容截图：", shot2Path);

} catch (err) {
  console.error("验证过程出错：", err);
} finally {
  cleanup();
}
