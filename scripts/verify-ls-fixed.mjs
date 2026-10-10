import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const chromePort = 9622;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${process.env.TEMP}/cdp-ls-verify-${Date.now()}`,
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

  // 输入 prompt
  const fillInput = `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, '请使用 execute 或 ls 工具查看当前目录文件并说明用途。');
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
  console.log("已发送指令：请使用 execute 或 ls 工具查看当前目录文件并说明用途。");

  let toolFoundDuringRun = false;
  let finalEvaluation = null;

  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const inspect = `
      (() => {
        const body = document.body.innerText;
        // 查找推理卡片数量（通过脑图图标或完成思考按钮）
        const reasoningTriggers = Array.from(document.querySelectorAll('button:has(svg.lucide-brain), [data-slot="reasoning"] button'))
          .map(el => el.innerText.trim());

        // 查找工具卡片（包含工具标题与状态）
        const toolCardElements = Array.from(document.querySelectorAll('div, button'))
          .filter(el => {
            const t = el.innerText || '';
            return t.includes('列出工作区文件 (ls)') || t.includes('执行终端 Shell 命令 (execute)');
          })
          .map(el => el.innerText.slice(0, 100));

        const caret = Boolean(document.querySelector('.streaming-caret'));
        const finished = body.includes('复制回答') || body.includes('重新尝试');
        return {
          reasoningCount: reasoningTriggers.length,
          reasoningTriggers,
          toolCardCount: toolCardElements.length,
          toolCardElements: toolCardElements.slice(0, 3),
          caret,
          finished,
          bodyTail: body.slice(-250)
        };
      })()
    `;
    const res = await send("Runtime.evaluate", { expression: inspect, returnByValue: true });
    const val = res.result?.value;
    if (val?.toolCardCount > 0) {
      toolFoundDuringRun = true;
    }
    console.log(`[tick ${i}] 推理面板数: ${val?.reasoningCount}, 工具卡片数: ${val?.toolCardCount}, 已完成: ${val?.finished}`);
    if (val?.finished && !val?.caret) {
      finalEvaluation = val;
      break;
    }
  }

  // 稍微等待渲染稳定
  await sleep(2000);

  // 最终核查
  const finalInspect = `
    (() => {
      const body = document.body.innerText;
      const reasoningTriggers = Array.from(document.querySelectorAll('button:has(svg.lucide-brain), [data-slot="reasoning"] button'))
        .map(el => el.innerText.trim());

      const toolCards = Array.from(document.querySelectorAll('*'))
        .filter(el => {
          const t = el.innerText || '';
          return (t.includes('列出工作区文件 (ls)') || t.includes('执行终端 Shell 命令 (execute)')) && (el.classList.toString().includes('border') || el.tagName === 'BUTTON');
        })
        .map(el => el.innerText.slice(0, 80));

      return {
        reasoningCount: reasoningTriggers.length,
        reasoningTriggers,
        hasToolCards: toolCards.length > 0,
        toolCardsSample: toolCards.slice(0, 3),
        bodySnippet: body.slice(-300)
      };
    })()
  `;
  const finalRes = await send("Runtime.evaluate", { expression: finalInspect, returnByValue: true });
  // 滚动到顶部截取包含单推理面板和工具卡片的完整视图
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const scrollContainers = Array.from(document.querySelectorAll('*')).filter(el => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        });
        for (const c of scrollContainers) {
          c.scrollTop = 0;
        }
        window.scrollTo(0, 0);
      })()
    `,
  });
  await sleep(1000);

  // 截取最终验证图片
  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(artifactDir, "screenshot-ls-fixed-verified.png");
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log("已保存修复后的验证截图：", shotPath);

} catch (err) {
  console.error("执行过程出错：", err);
} finally {
  cleanup();
}
