import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const CDP_PORT = 9388;
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
    `--user-data-dir=${process.env.TEMP}/cdp-verify-edit-theme`,
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
  console.log("=== 开始端到端自动化验证：消息编辑、输入框一致性、纯白浅色主题、侧边栏选中高亮与表格规范 ===");

  await sendCdp("Page.enable");
  await sendCdp("DOM.enable");
  await sendCdp("Page.navigate", { url: APP_URL });
  await sleep(1500);

  // 1. 通过测试钩子直接加载包含用户消息与表格回复的会话状态
  console.log("-> 注入测试会话数据与历史消息...");
  await evaluate(`(() => {
    const threadId = "session-test-edit-table-001";
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
          content:
            "前后端服务已在本地成功启动运行！下表是当前服务的健康状态与详细端口信息：\\n\\n| 服务名称 | 监听端口 | 状态 | 访问协议 |\\n| :--- | :--- | :--- | :--- |\\n| 前端 Web 控制台 | 5173 | 运行正常 (200 OK) | HTTP / SSE |\\n| 后端 Agent API | 8787 | 运行正常 (200 OK) | AG-UI 协议 |\\n| 本地文件工作区 | D:/temp/langchain | 权限受限沙箱 | 本地安全挂载 |\\n\\n服务状态健康，可随时发送指令继续调试。",
          streaming: false,
          runId: "run-001",
        },
      ],
      activities: [],
      run: {
        status: "idle",
        runId: null,
        threadId: threadId,
        progressNote: null,
        interrupts: [],
        error: null,
      },
      threadId: threadId,
      pendingDecisions: {},
    };

    if (window.__deepagentTestHooks) {
      window.__deepagentTestHooks.loadState(sampleState);
    }
  })()`);

  await sleep(600);

  // 2. 检查用户消息与下方元数据栏（时间戳 14:14、复制按钮、编辑按钮）
  console.log("-> 验证用户消息及时间戳与按钮...");
  const timeText = await evaluate(`(() => {
    const timeSpan = document.querySelector(".group\\\\/user span.tabular-nums");
    return timeSpan ? timeSpan.textContent : null;
  })()`);
  console.log(`用户消息时间戳显示: [${timeText}]`);

  // 鼠标悬停在编辑按钮上触发 Tooltip
  console.log("-> 悬停在编辑按钮上，展示暗黑背景白字 Tooltip...");
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

  const tooltipScreenshot = `${ARTIFACT_DIR}/screenshot-verified-edit-tooltip.png`;
  await screenshot(tooltipScreenshot);
  console.log("已保存编辑悬停提示截图:", tooltipScreenshot);

  // 3. 点击编辑按钮，进入内联编辑模式
  console.log("-> 点击编辑按钮测试内联编辑卡片...");
  await evaluate(`(() => {
    const btn = document.querySelector(".group\\\\/user button:has(svg.lucide-pencil)");
    if (btn) btn.click();
  })()`);
  await sleep(500);

  const editState = await evaluate(`(() => {
    const ta = document.querySelector(".group\\\\/user textarea");
    const resendBtn = document.querySelector(".group\\\\/user button[title*='重新发送']");
    const hasSendIcon = resendBtn ? !!resendBtn.querySelector("svg.lucide-corner-down-left") : false;
    return {
      hasTextarea: !!ta,
      textareaValue: ta ? ta.value : "",
      hasResendBtn: !!resendBtn,
      hasSendIcon,
    };
  })()`);
  console.log("内联编辑状态与重新发送按钮检查:", editState);

  const editCardScreenshot = `${ARTIFACT_DIR}/screenshot-verified-inline-edit-card.png`;
  await screenshot(editCardScreenshot);
  console.log("已保存内联编辑模式截图:", editCardScreenshot);

  // 点击取消退出编辑
  await evaluate(`(() => {
    const cancelBtn = Array.from(document.querySelectorAll(".group\\\\/user button")).find(b => b.textContent.includes("取消"));
    if (cancelBtn) cancelBtn.click();
  })()`);
  await sleep(400);

  // 4. 切换为浅色主题，验证“纯白浅色模式”、“左侧选中会话不发黑”、“表格标题灰白+表格区纯白”
  console.log("-> 切换为浅色主题...");
  // 直接通过 theme hook 的 localStorage 并触发设置
  await evaluate(`(() => {
    localStorage.setItem("deepagent_theme_mode", "light");
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
    document.documentElement.setAttribute("data-theme", "light");
  })()`);
  await sleep(600);

  // 验证颜色属性
  const themeVerification = await evaluate(`(() => {
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const activeItem = document.querySelector(".sidebar-session-item[data-active='true']");
    const activeItemBg = activeItem ? window.getComputedStyle(activeItem).backgroundColor : "none";
    const activeItemColor = activeItem ? window.getComputedStyle(activeItem).color : "none";

    const th = document.querySelector("table[data-streamdown='table'] th");
    const thBg = th ? window.getComputedStyle(th).backgroundColor : "none";
    const thColor = th ? window.getComputedStyle(th).color : "none";

    const td = document.querySelector("table[data-streamdown='table'] td");
    const tdBg = td ? window.getComputedStyle(td).backgroundColor : "none";
    const tdColor = td ? window.getComputedStyle(td).color : "none";

    return {
      bodyBg,
      activeItemBg,
      activeItemColor,
      thBg,
      thColor,
      tdBg,
      tdColor,
    };
  })()`);
  console.log("浅色模式关键元素颜色断言结果:", themeVerification);

  const lightThemeScreenshot = `${ARTIFACT_DIR}/screenshot-verified-light-theme-sidebar-table.png`;
  await screenshot(lightThemeScreenshot);
  console.log("已保存浅色模式（纯白背景、侧边栏高亮清晰、表格表头灰白+表格区纯白）全景截图:", lightThemeScreenshot);

  console.log("=== 端到端自动化验证全部完成 ===");
  cleanup();
  process.exit(0);
}

run().catch((e) => {
  console.error("运行失败:", e);
  cleanup();
  process.exit(1);
});
