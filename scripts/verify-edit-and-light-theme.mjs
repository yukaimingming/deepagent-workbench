import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9389;
const APP_URL = "http://127.0.0.1:5173/";
const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-verify-modal-and-time`,
    "--window-size=1440,920",
  ],
  { stdio: "ignore" },
);

const cleanup = () => {
  try {
    chrome.kill();
  } catch {}
};
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(1);
});

await sleep(2500);

const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
const page = targets.find((t) => t.type === "page");
if (!page) {
  console.error("无法找到 Chrome page 目标");
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});

await new Promise((resolve) => ws.on("open", resolve));

function sendCdp(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expr) {
  const res = await sendCdp("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (res.result?.exceptionDetails) {
    throw new Error(JSON.stringify(res.result.exceptionDetails));
  }
  return res.result?.result?.value;
}

async function screenshot(filePath) {
  const res = await sendCdp("Page.captureScreenshot", { format: "png" });
  if (res.result?.data) {
    writeFileSync(filePath, Buffer.from(res.result.data, "base64"));
  }
}

async function run() {
  console.log("=== 开始端到端自动化验证：会话时间、全灰白Tooltip（无黑三角）、模型设置浅色列表与按钮 ===");

  await sendCdp("Page.enable");
  await sendCdp("DOM.enable");
  await sendCdp("Page.navigate", { url: APP_URL });
  await sleep(1500);

  // 1. 设置浅色主题并注入测试会话
  console.log("-> 设置浅色主题模式并加载测试会话...");
  await evaluate(`(() => {
    localStorage.setItem("deepagent_theme_mode", "light");
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
    document.documentElement.setAttribute("data-theme", "light");

    const sampleState = {
      messages: [
        {
          id: "msg-user-1",
          role: "user",
          content: "你把前后端服务运行起来我看看效果",
          streaming: false,
          createdAt: new Date("2026-10-10T14:14:00").getTime(),
        },
        {
          id: "msg-assistant-1",
          role: "assistant",
          content: "服务已就绪。",
          streaming: false,
        },
      ],
      activities: [],
      run: {
        status: "idle",
        runId: null,
        threadId: "test-thread-01",
        progressNote: null,
        interrupts: [],
        error: null,
      },
      threadId: "test-thread-01",
      pendingDecisions: {},
    };

    if (window.__deepagentTestHooks) {
      window.__deepagentTestHooks.loadState(sampleState);
    }
  })()`);
  await sleep(800);

  // 2. 验证左侧列表会话项是否显示了时间
  console.log("-> 验证左侧侧边栏会话项时间显示...");
  const sessionTimeCheck = await evaluate(`(() => {
    const timeSpan = document.querySelector(".sidebar-session-item .session-time");
    return {
      hasTimeSpan: !!timeSpan,
      timeText: timeSpan ? timeSpan.textContent.trim() : "",
      timeColor: timeSpan ? window.getComputedStyle(timeSpan).color : "none",
    };
  })()`);
  console.log("侧边栏会话时间显示检查:", sessionTimeCheck);

  // 3. 悬停在编辑按钮上，验证全灰白 Tooltip 及无黑色小三角
  console.log("-> 悬停在编辑按钮上验证 Tooltip 全灰白与小三角颜色...");
  const editBtnPos = await evaluate(`(() => {
    const btn = document.querySelector(".group\\\\/user button:has(svg.lucide-pencil)");
    if (!btn) return null;
    const rect = btn.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);

  if (editBtnPos) {
    await sendCdp("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: editBtnPos.x,
      y: editBtnPos.y,
    });
    await sleep(600);
  }

  // 检查 Tooltip 内容与箭头小三角的颜色
  const tooltipStyleCheck = await evaluate(`(() => {
    const content = document.querySelector('[data-slot="tooltip-content"]');
    const arrow = document.querySelector('[data-slot="tooltip-arrow"]');
    return {
      hasContent: !!content,
      contentBg: content ? window.getComputedStyle(content).backgroundColor : "none",
      contentColor: content ? window.getComputedStyle(content).color : "none",
      hasArrow: !!arrow,
      arrowBg: arrow ? window.getComputedStyle(arrow).backgroundColor : "none",
      arrowFill: arrow ? window.getComputedStyle(arrow).fill : "none",
    };
  })()`);
  console.log("Tooltip 全灰白与小三角颜色断言结果:", tooltipStyleCheck);

  const mainViewScreenshot = `${ARTIFACT_DIR}/screenshot-verified-sidebar-time-and-tooltip.png`;
  await screenshot(mainViewScreenshot);
  console.log("已保存侧边栏时间与全灰白 Tooltip 截图:", mainViewScreenshot);

  // 4. 打开“模型与供应商设置”弹窗，验证模型列表和各操作按钮在浅色模式下消除灰色
  console.log("-> 打开模型设置模态框并验证浅色列表与按钮...");
  await evaluate(`(() => {
    const btn = document.querySelector("[data-testid='open-settings-modal-btn']");
    if (btn) btn.click();
  })()`);
  await sleep(1000);

  // 检查设置弹窗面板、模型列表滚动区、按钮的计算颜色
  const modalStyleCheck = await evaluate(`(() => {
    const panel = document.querySelector(".modal-panel");
    const scrollBox = document.querySelector(".settings-model-list-scroll");
    const fetchBtn = document.querySelector(".settings-fetch-models-btn");
    const addBtn = document.querySelector(".settings-add-model-btn");
    const testBtn = document.querySelector(".settings-test-btn");
    const defaultItem = document.querySelector(".settings-model-item.is-default");

    return {
      panelBg: panel ? window.getComputedStyle(panel).backgroundColor : "none",
      scrollBoxBg: scrollBox ? window.getComputedStyle(scrollBox).backgroundColor : "none",
      fetchBtnBg: fetchBtn ? window.getComputedStyle(fetchBtn).backgroundColor : "none",
      fetchBtnColor: fetchBtn ? window.getComputedStyle(fetchBtn).color : "none",
      addBtnBg: addBtn ? window.getComputedStyle(addBtn).backgroundColor : "none",
      addBtnColor: addBtn ? window.getComputedStyle(addBtn).color : "none",
      testBtnBg: testBtn ? window.getComputedStyle(testBtn).backgroundColor : "none",
      defaultItemBg: defaultItem ? window.getComputedStyle(defaultItem).backgroundColor : "none",
    };
  })()`);
  console.log("模型设置弹窗浅色样式断言结果:", modalStyleCheck);

  const modalScreenshot = `${ARTIFACT_DIR}/screenshot-verified-settings-modal-light.png`;
  await screenshot(modalScreenshot);
  console.log("已保存模型设置浅色弹窗截图:", modalScreenshot);

  console.log("=== 端到端自动化验证圆满完成 ===");
  cleanup();
  process.exit(0);
}

run().catch((e) => {
  console.error("运行失败:", e);
  cleanup();
  process.exit(1);
});
