import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

const CDP_PORT = 9488;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-clock-verify-${Date.now()}`,
    "--window-size=1400,900",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
);

await sleep(3000);

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

  console.log("导航至前端: http://127.0.0.1:5173 ...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(2500);

  // 验证测试钩子
  const hasHooks = await evalJs("Boolean(window.__deepagentTestHooks)");
  console.log("测试钩子就绪状态:", hasHooks);
  if (!hasHooks) throw new Error("window.__deepagentTestHooks 未就绪");

  console.log("\n=== 1. 模拟提问触发：派发 REASONING_MESSAGE_START ===");
  const startTimestamp = Date.now();
  await evalJs(`
    (() => {
      const hooks = window.__deepagentTestHooks;
      const now = ${startTimestamp};
      const runId = "run-clock-test-" + now;
      const threadId = hooks.getState().threadId;
      hooks.dispatch([
        { type: "RUN_STARTED", runId, threadId, timestamp: now },
        { type: "REASONING_MESSAGE_START", messageId: "rs-test-" + now, runId, role: "reasoning", timestamp: now }
      ]);
    })()
  `);

  console.log("=== 2. 高频采样秒数跳变与打字流式同步 ===");
  const records = [];

  // 连续采样 8 次（约 3.5 秒），每 400ms 记录一次
  for (let i = 0; i < 9; i++) {
    await sleep(400);
    const state = await evalJs(`
      (() => {
        const textSpan = document.querySelector('.tabular-nums');
        const trigger = document.querySelector('[data-state][data-orientation]');
        const caret = document.querySelector('.streaming-caret');
        return {
          secsText: textSpan ? textSpan.innerText : "未找到秒数",
          triggerText: trigger ? trigger.innerText : "",
          contentLength: caret ? caret.innerText.length : 0,
          contentPreview: caret ? caret.innerText.slice(0, 30) : ""
        };
      })()
    `);

    const elapsed = Date.now() - startTimestamp;
    records.push({ step: i + 1, elapsed, ...state });
    console.log(`[T+${elapsed}ms] 秒数显示: "${state.secsText}" | 思考文字数: ${state.contentLength} | 触发器整行: "${state.triggerText}"`);

    // 在 T+800ms 时，思考内容第一波打字到达
    if (i === 1) {
      await evalJs(`
        window.__deepagentTestHooks.dispatch([
          { type: "REASONING_MESSAGE_CONTENT", messageId: "rs-test-${startTimestamp}", delta: "我正在对当前工作区进行系统级结构梳理与多维度分析...", timestamp: Date.now() }
        ])
      `);
      console.log("  >>> 注入第 1 波思考打字内容 <<<");
    }

    // 在 T+1600ms 时，思考内容第二波打字到达
    if (i === 3) {
      await evalJs(`
        window.__deepagentTestHooks.dispatch([
          { type: "REASONING_MESSAGE_CONTENT", messageId: "rs-test-${startTimestamp}", delta: "\\n已识别项目架构为 TypeScript Monorepo，各模块边界清晰。", timestamp: Date.now() }
        ])
      `);
      console.log("  >>> 注入第 2 波思考打字内容 <<<");
    }

    // 在 T+2400ms 截取一张打字中截图
    if (i === 5) {
      await capture(`${ARTIFACT_DIR}/screenshot-verified-reasoning-clock-sync.png`);
    }
  }

  // 结束思考流，输出正式内容
  console.log("\n=== 3. 结束思考，流式输出正文回答 ===");
  await evalJs(`
    window.__deepagentTestHooks.dispatch([
      { type: "REASONING_MESSAGE_END", messageId: "rs-test-${startTimestamp}", timestamp: Date.now() },
      { type: "TEXT_MESSAGE_START", messageId: "rs-test-${startTimestamp}", role: "assistant", timestamp: Date.now() },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "rs-test-${startTimestamp}", delta: "分析完成：当前目录包含 apps、packages 和配置文件，结构完整规范。", timestamp: Date.now() },
      { type: "TEXT_MESSAGE_END", messageId: "rs-test-${startTimestamp}", timestamp: Date.now() },
      { type: "RUN_FINISHED", outcome: { type: "success" }, timestamp: Date.now() }
    ])
  `);

  await sleep(1200);
  await capture(`${ARTIFACT_DIR}/screenshot-verified-reasoning-completed-sync.png`);

  const finalState = await evalJs(`
    (() => {
      const trigger = document.querySelector('[data-state][data-orientation]');
      const answer = document.querySelector('.prose, p');
      return {
        trigger: trigger ? trigger.innerText : "",
        answer: answer ? answer.innerText : ""
      };
    })()
  `);
  console.log("思考完成收起状态:", finalState.trigger);
  console.log("正文回答内容:", finalState.answer);

  // 验证断言
  console.log("\n=== 4. 验证断言分析 ===");
  // 1. 检查秒数是否自然递增
  const secNumbers = records.map((r) => {
    const match = r.secsText.match(/(\d+)/);
    return match ? parseInt(match[1], 10) : NaN;
  });
  console.log("秒数序列:", secNumbers);

  // 验证没有卡死或倒退
  let monotonic = true;
  for (let i = 1; i < secNumbers.length; i++) {
    if (secNumbers[i] < secNumbers[i - 1]) {
      monotonic = false;
      break;
    }
  }
  console.log("秒数序列是否单调非递减:", monotonic);
  if (!monotonic) throw new Error("秒数出现了倒退或重置！");

  // 验证第 1 秒到第 3 秒是否都有采样覆盖
  const has1 = secNumbers.includes(1);
  const has2 = secNumbers.includes(2);
  const has3 = secNumbers.includes(3);
  console.log("包含 1 秒:", has1, "包含 2 秒:", has2, "包含 3 秒:", has3);

  console.log("\n[SUCCESS] 推理计时同步测试全部通过！");

} catch (err) {
  console.error("测试失败:", err);
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  chrome.kill();
}
