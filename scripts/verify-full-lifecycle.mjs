import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CDP_PORT = 9422;

const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-verify-${Date.now()}`,
    "--window-size=1500,1050",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(3500);

let ws;
let id = 1;
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const cur = id++;
    const handler = (data) => {
      const res = JSON.parse(data.toString());
      if (res.id === cur) {
        ws.off("message", handler);
        if (res.error) reject(res.error);
        else resolve(res.result);
      }
    };
    ws.on("message", handler);
    ws.send(JSON.stringify({ id: cur, method, params }));
  });
}

async function capture(filename) {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(filename, Buffer.from(data, "base64"));
  console.log(`[截图已保存] -> ${filename}`);
}

async function evalJs(expr) {
  const res = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return res?.result?.value;
}

try {
  const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("未找到 Chrome 页面目标");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  await send("Page.enable");
  await send("Runtime.enable");

  console.log("导航到 http://127.0.0.1:5173...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(4000);

  // 输入 prompt
  console.log("输入测试 Prompt: D:\\temp\\aiagent 这个路径有什么内容分析完告诉我");
  await evalJs(`(() => {
    const textarea = document.querySelector('textarea');
    textarea.focus();
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    nativeSetter.call(textarea, 'D:\\\\temp\\\\aiagent 这个路径有什么内容分析完告诉我');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);

  await sleep(600);

  // 点击发送
  await evalJs(`(() => {
    const btn = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('发送') || b.querySelector('svg'));
    if (btn) btn.click();
  })()`);

  console.log("开始生命周期全流程监控...");

  let approved = false;
  let finalCaptured = false;

  for (let cycle = 1; cycle <= 16; cycle++) {
    await sleep(3000);

    const state = await evalJs(`(() => {
      const text = document.body.innerText || '';
      const isThinking = text.includes('正在思考中');
      const hasDoneThinking = text.includes('完成思考');
      const hasApproval = text.includes('待审批') || text.includes('需人工确认');
      
      // 精准检测助手答复正文（排除用户消息）
      const assistantTextEl = document.querySelector('[data-role="assistant-content"]') || document.querySelector('.prose');
      let prose = assistantTextEl ? assistantTextEl.innerText : '';
      if (!prose) {
        // 从助手气泡提取
        const msgs = Array.from(document.querySelectorAll('.flex.flex-col.w-full.text-zinc-100'));
        if (msgs.length > 0) {
          const lastMsg = msgs[msgs.length - 1];
          const proseElem = lastMsg.querySelector('p.streaming-caret') || lastMsg.querySelector('.prose');
          if (proseElem) prose = proseElem.innerText;
        }
      }

      return {
        cycle: ${cycle},
        isThinking,
        hasDoneThinking,
        hasApproval,
        proseLen: prose.length,
        prosePreview: prose.slice(0, 50),
      };
    })()`);

    console.log(`[生命周期 #${cycle}]`, state);

    if (cycle === 2) {
      await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-lifecycle-1-thinking.png");
    }

    // 若出现审批卡片且尚未批准，点击批准
    if (state?.hasApproval && !approved) {
      console.log("检测到人工安全审批，点击【批准】...");
      await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-lifecycle-2-approval.png");
      await evalJs(`(() => {
        const approveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '批准');
        if (approveBtn) approveBtn.click();
      })()`);
      approved = true;
      console.log("已点击【批准】，继续执行...");
    }

    // 若已经有正式正文流式输出
    if (state?.proseLen > 50 && !finalCaptured) {
      finalCaptured = true;
      await sleep(2500);
      await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-lifecycle-3-final-response.png");
    }
  }

  await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-lifecycle-4-end.png");
  console.log("全生命周期验证完成！");
} catch (e) {
  console.error("执行出错:", e);
} finally {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  try { chrome.kill(); } catch {}
  process.exit(0);
}
