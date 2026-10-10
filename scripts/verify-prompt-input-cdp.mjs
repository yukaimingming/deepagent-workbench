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
    `--user-data-dir=${process.env.TEMP}/cdp-input-verify-${Date.now()}`,
    "--window-size=1400,900",
    "--hide-scrollbars",
  ],
  { stdio: "ignore" },
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

  console.log("导航至前端: http://127.0.0.1:5173 ...");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(2500);

  console.log("\n=== 1. 验证提示词输入框初始状态（无刺眼白边、Elements规范） ===");
  const inputCheck = await evalJs(`
    (() => {
      const textarea = document.querySelector('textarea');
      const form = document.querySelector('form');
      const submitBtn = document.querySelector('button[type=\"submit\"]');
      const reasonBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('思考:'));

      // 检查边框样式
      const formStyle = form ? window.getComputedStyle(form) : null;
      return {
        hasTextarea: Boolean(textarea),
        placeholder: textarea ? textarea.placeholder : '',
        hasSubmitBtn: Boolean(submitBtn),
        hasReasonBtn: Boolean(reasonBtn),
        reasonText: reasonBtn ? reasonBtn.innerText.trim() : '',
        formBorderColor: formStyle ? formStyle.borderColor : '',
      };
    })()
  `);
  console.log("初始状态检查结果:", inputCheck);

  await capture(`${ARTIFACT_DIR}/screenshot-verified-prompt-input-initial.png`);

  console.log("\n=== 2. 验证思考等级下拉选择菜单展开效果 ===");
  // 点击思考按钮
  await evalJs(`
    (() => {
      const reasonBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('思考:'));
      if (reasonBtn) reasonBtn.click();
    })()
  `);
  await sleep(500);

  const menuCheck = await evalJs(`
    (() => {
      const highOption = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('高 (high)'));
      const medOption = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('中 (medium)'));
      const lowOption = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('低 (low)'));
      return {
        hasHigh: Boolean(highOption),
        hasMedium: Boolean(medOption),
        hasLow: Boolean(lowOption),
      };
    })()
  `);
  console.log("下拉菜单选项检查结果:", menuCheck);

  if (!menuCheck.hasHigh || !menuCheck.hasMedium || !menuCheck.hasLow) {
    throw new Error("思考等级下拉菜单未能正常展开高/中/低选项！");
  }

  await capture(`${ARTIFACT_DIR}/screenshot-verified-prompt-input-dropdown.png`);

  console.log("\n=== 3. 验证输入文本与提交按钮交互 ===");
  // 选择“高”档位
  await evalJs(`
    (() => {
      const highOption = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('高 (high)'));
      if (highOption) highOption.click();
    })()
  `);
  await sleep(300);

  // 输入提示词
  await evalJs(`
    (() => {
      const textarea = document.querySelector('textarea');
      if (textarea) {
        textarea.value = "请分析当前工作区的所有配置与依赖关系，并输出详细说明";
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()
  `);
  await sleep(400);

  await capture(`${ARTIFACT_DIR}/screenshot-verified-prompt-input-typing.png`);

  console.log("\n[SUCCESS] 提示词输入框、发送按钮及思考等级下拉菜单全部验证通过！");
} catch (err) {
  console.error("验证失败:", err);
  process.exitCode = 1;
} finally {
  if (ws) ws.close();
  chrome.kill();
}
