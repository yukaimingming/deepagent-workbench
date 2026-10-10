import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CDP_PORT = 9415;

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
  if (!page) throw new Error("未找到 Chrome 页面");

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  console.log("准备点击【批准】按钮...");
  const clicked = await evalJs(`(() => {
    const approveBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '批准');
    if (approveBtn) {
      approveBtn.click();
      return true;
    }
    return false;
  })()`);

  console.log("点击【批准】按钮结果:", clicked);

  // 随后监控恢复执行后的流式输出状态
  for (let i = 1; i <= 8; i++) {
    await sleep(3500);
    const snap = await evalJs(`(() => {
      const text = document.body.innerText || '';
      const isThinking = text.includes('正在思考中') || Boolean(document.querySelector('[data-state="open"]'));
      const hasDoneThinking = text.includes('完成思考');
      const proseEl = document.querySelector('.prose');
      const prose = proseEl ? proseEl.innerText : '';
      return { isThinking, hasDoneThinking, proseLen: prose.length, prosePreview: prose.slice(0, 80) };
    })()`);
    console.log(`[恢复采样 #${i}]`, snap);

    if (i === 3) {
      await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-seq-4-approved-streaming.png");
    }
  }

  await sleep(3000);
  await capture("C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee/screenshot-seq-5-approved-final.png");
} catch (e) {
  console.error("执行出错:", e);
} finally {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  process.exit(0);
}
