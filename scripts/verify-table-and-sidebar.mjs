import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ARTIFACT_DIR = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

const CDP_PORT = 9482;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${process.env.TEMP}/cdp-table-test-${Date.now()}`,
    "--window-size=1400,900",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" }
);

await sleep(2500);

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
  try {
    await send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] });
  } catch (e) {}

  console.log("导航至前端: http://127.0.0.1:5173 ...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(2500);

  // 确保侧边栏展开
  await evalJs(`
    (() => {
      try {
        localStorage.setItem('deepagent_sidebar_open', 'true');
      } catch (e) {}
      const toggleBtn = document.querySelector('button[title="展开侧边栏"]');
      if (toggleBtn) toggleBtn.click();
    })()
  `);
  await sleep(800);

  console.log("\n=== 1. 验证侧边栏左上角工作区名称按钮已移除 ===");
  const sidebarCheck = await evalJs(`
    (() => {
      const aside = document.querySelector('aside');
      if (!aside) return { hasAside: false };
      const topBar = aside.querySelector('.border-b');
      const buttons = Array.from(topBar.querySelectorAll('button'));
      const pickerBtn = buttons.find(b => b.title && b.title.includes('点击弹窗切换或浏览工作区文件夹'));
      return {
        hasAside: true,
        buttonCount: buttons.length,
        hasPickerBtn: Boolean(pickerBtn),
        topBarText: topBar.innerText.trim()
      };
    })()
  `);
  console.log("侧边栏顶部检查结果:", sidebarCheck);
  if (!sidebarCheck.hasAside || sidebarCheck.hasPickerBtn) {
    throw new Error("侧边栏未展开或左上角工作区名称弹窗按钮依然存在！");
  }

  await capture(`${ARTIFACT_DIR}/screenshot-verified-sidebar-header-cleaned.png`);

  console.log("\n=== 2. 注入包含 Markdown 表格的内容并验证直接复制（绝无弹窗） ===");
  const now = Date.now();
  await evalJs(`
    (() => {
      const hooks = window.__deepagentTestHooks;
      const runId = "test-table-" + ${now};
      const threadId = hooks.getState().threadId;
      const msgId = "msg-table-" + ${now};
      const tableText = [
        "### 系统模块清单",
        "",
        "| 模块名称 | 职责定位 | 状态 |",
        "| :--- | :--- | :--- |",
        "| apps/web | React 交互工作台 | 运行中 |",
        "| apps/server | DeepAgent 核心运行时 | 运行中 |",
        "| packages/shared | 跨端通信协议与类型 | 已就绪 |",
        "",
        "表格已成功呈现，请查看。"
      ].join(String.fromCharCode(10));

      hooks.dispatch([
        { type: "RUN_STARTED", runId, threadId, timestamp: ${now} },
        { type: "TEXT_MESSAGE_START", messageId: msgId, role: "assistant", timestamp: ${now} },
        { type: "TEXT_MESSAGE_CONTENT", messageId: msgId, delta: tableText, timestamp: ${now} },
        { type: "TEXT_MESSAGE_END", messageId: msgId, timestamp: ${now} + 100 },
        { type: "RUN_FINISHED", outcome: { type: "success" }, timestamp: ${now} + 100 }
      ]);
    })()
  `);
  await sleep(1200);

  // 检查表格 DOM
  const tableCheck = await evalJs(`
    (() => {
      const table = document.querySelector('table');
      const copyBtn = document.querySelector('button[title*="复制表格"]');
      const downloadBtn = document.querySelector('button[title*="下载表格"]');
      return {
        hasTable: Boolean(table),
        tableRows: table ? table.querySelectorAll('tr').length : 0,
        hasCopyBtn: Boolean(copyBtn),
        hasDownloadBtn: Boolean(downloadBtn)
      };
    })()
  `);
  console.log("表格渲染检查结果:", tableCheck);
  if (!tableCheck.hasTable || !tableCheck.hasCopyBtn) {
    throw new Error("Markdown 表格或直接复制按钮未正常渲染！");
  }

  // 点击复制按钮
  console.log("点击表格复制按钮...");
  await evalJs(`
    (() => {
      const copyBtn = document.querySelector('button[title*="复制表格"]');
      if (copyBtn) copyBtn.click();
    })()
  `);
  await sleep(400);

  // 检查是否弹出了任何 CSV / TSV 菜单，并检查复制按钮是否直接变成了“已复制”
  const copyResult = await evalJs(`
    (() => {
      const allButtons = Array.from(document.querySelectorAll('button'));
      const hasCsvOption = allButtons.some(b => b.innerText.trim() === 'CSV');
      const hasTsvOption = allButtons.some(b => b.innerText.trim() === 'TSV');
      const copiedText = document.body.innerText.includes('已复制');
      const copyBtn = document.querySelector('button[title*="已复制表格"]');

      return {
        hasCsvOption,
        hasTsvOption,
        hasCopiedFeedback: copiedText || Boolean(copyBtn)
      };
    })()
  `);
  console.log("点击复制后检查结果:", copyResult);

  if (copyResult.hasCsvOption || copyResult.hasTsvOption) {
    throw new Error("点击复制时依然弹出了 CSV/TSV 下拉菜单！");
  }
  if (!copyResult.hasCopiedFeedback) {
    throw new Error("点击复制后未展示已复制状态反馈！");
  }

  await capture(`${ARTIFACT_DIR}/screenshot-verified-table-direct-copy.png`);

  console.log("\n[SUCCESS] 表格直接复制（无弹窗）及侧边栏标题清理全部验证通过！");
} catch (err) {
  console.error("验证失败:", err);
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  chrome.kill();
}
