import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

const CDP_PORT = 9499;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-fixes-verify-${Date.now()}`,
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

  console.log("\n=== 1. 验证流式正式内容 Markdown 实时解析（不露 # 和 *） ===");
  const now = Date.now();
  await evalJs(`
    (() => {
      const hooks = window.__deepagentTestHooks;
      const runId = "test-md-" + ${now};
      const threadId = hooks.getState().threadId;
      const msgId = "msg-md-" + ${now};
      hooks.dispatch([
        { type: "RUN_STARTED", runId, threadId, timestamp: ${now} },
        { type: "TEXT_MESSAGE_START", messageId: msgId, role: "assistant", timestamp: ${now} },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: msgId,
          delta: "### 目录分析结果\\n\\n当前工作区包含以下核心模块：\\n- **前端工程**：基于 React 构建的交互界面\\n- **后端服务**：集成 Deep Agents 的运行时\\n\\n已成功完成解析。",
          timestamp: ${now}
        }
      ]);
    })()
  `);

  await sleep(600);

  // 检查在流式打字期间（此时 TEXT_MESSAGE_END 尚未发出，streaming 为 true）：
  // 页面是否已经将 ### 渲染为 h3 标签，将 **前端工程** 渲染为 strong/b 标签，而不是把 ### 作为纯文本显示！
  const mdDomCheck = await evalJs(`
    (() => {
      const h3 = document.querySelector('h3');
      const bold = document.querySelector('strong, b') || Array.from(document.querySelectorAll('*')).find(el => window.getComputedStyle(el).fontWeight >= '600' && el.innerText.includes('前端工程'));
      const li = document.querySelector('li');
      const rawHash = document.body.innerText.includes('###');
      const rawAsterisk = document.body.innerText.includes('**前端工程**');
      return {
        hasH3: Boolean(h3),
        h3Text: h3 ? h3.innerText : "",
        hasBold: Boolean(bold),
        boldText: bold ? bold.innerText : "",
        hasLi: Boolean(li),
        rawHashPresent: rawHash,
        rawAsteriskPresent: rawAsterisk,
      };
    })()
  `);

  console.log("流式 Markdown 实时解析检查结果:", mdDomCheck);
  if (!mdDomCheck.hasH3 || mdDomCheck.rawHashPresent || mdDomCheck.rawAsteriskPresent) {
    throw new Error("流式 Markdown 依然露出了原始 # 或 * 符号！");
  }

  await capture(`${ARTIFACT_DIR}/screenshot-verified-streaming-markdown-parsed.png`);

  // 发送 TEXT_MESSAGE_END 完成回答
  await evalJs(`
    window.__deepagentTestHooks.dispatch([
      { type: "TEXT_MESSAGE_END", messageId: "msg-md-${now}", timestamp: Date.now() },
      { type: "RUN_FINISHED", outcome: { type: "success" }, timestamp: Date.now() }
    ])
  `);
  await sleep(500);

  console.log("\n=== 2. 验证审批卡片待审批展示与批准后自动收缩 ===");
  // 注入一个审批活动
  const approvalId = "tool:approval-test-" + now;
  await evalJs(`
    (() => {
      const hooks = window.__deepagentTestHooks;
      hooks.dispatch([
        {
          type: "CUSTOM",
          name: "deepagent:activity",
          value: {
            id: "${approvalId}",
            kind: "approval",
            title: "execute",
            status: "waiting_approval",
            startedAt: Date.now(),
            detail: {
              toolName: "execute",
              impact: "将在宿主机执行系统命令，请确认权限与安全性。",
              args: { command: "npm test", timeout: 60 }
            }
          }
        },
        {
          type: "RUN_FINISHED",
          outcome: { type: "interrupt" }
        }
      ]);
    })()
  `);

  await sleep(600);
  await capture(`${ARTIFACT_DIR}/screenshot-verified-approval-before-decision.png`);

  const beforeDecision = await evalJs(`
    (() => {
      const approveBtn = document.querySelector('button:has-text("批准执行")') || Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('批准执行'));
      const card = document.querySelector('article');
      return {
        hasApproveBtn: Boolean(approveBtn),
        cardHeight: card ? card.clientHeight : 0
      };
    })()
  `);
  console.log("决策前待审批卡片状态:", beforeDecision);

  // 点击“批准执行”
  console.log("执行批准决策...");
  await evalJs(`
    (() => {
      const approveBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('批准执行'));
      if (approveBtn) approveBtn.click();
    })()
  `);

  await sleep(600);
  await capture(`${ARTIFACT_DIR}/screenshot-verified-approval-collapsed.png`);

  const afterDecision = await evalJs(`
    (() => {
      const collapsedBar = Array.from(document.querySelectorAll('span')).find(s => s.innerText.includes('已批准执行'));
      const toggleBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('查看参数'));
      return {
        hasCollapsedBar: Boolean(collapsedBar),
        hasToggleBtn: Boolean(toggleBtn),
      };
    })()
  `);
  console.log("批准后自动收缩状态:", afterDecision);
  if (!afterDecision.hasCollapsedBar) {
    throw new Error("批准后卡片未自动收缩为状态栏！");
  }

  console.log("\n[SUCCESS] 全部优化功能端到端验证通过！");

} catch (err) {
  console.error("测试失败:", err);
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  chrome.kill();
}
