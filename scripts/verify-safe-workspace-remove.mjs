import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CDP_PORT = 9435;

// 创建一个测试用的实体物理文件夹
const testSafeDir = "D:/temp/test_safe_keep_dir";
if (!fs.existsSync(testSafeDir)) {
  fs.mkdirSync(testSafeDir, { recursive: true });
}
const testFile = path.join(testSafeDir, "important_data.txt");
fs.writeFileSync(testFile, "这是非常重要的物理文件，绝对不能被删除！", "utf8");

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

  // 1. 通过 localStorage 注入这个测试工作区并刷新页面
  console.log("注入测试工作区...");
  await evalJs(`(() => {
    const key = 'deepagent_sessions_v1';
    let data = { sessions: [], activeSessionId: '', workspaces: ['d:/temp/langchain/workspace'] };
    try { data = JSON.parse(localStorage.getItem(key)) || data; } catch(e){}
    if (!data.workspaces.includes('${testSafeDir}')) {
      data.workspaces.push('${testSafeDir}');
    }
    localStorage.setItem(key, JSON.stringify(data));
  })()`);

  await send("Page.reload");
  await sleep(3000);

  // 2. 验证侧边栏是否显示了该工作区节点
  const hasNode = await evalJs(`document.body.innerText.includes('test_safe_keep_dir')`);
  console.log("侧边栏是否已显示该测试工作区:", hasNode ? "✅ 是" : "❌ 否");

  // 3. 点击该工作区右侧的移除按钮
  console.log("点击移除工作区按钮...");
  await evalJs(`(() => {
    const spans = Array.from(document.querySelectorAll('span'));
    const targetSpan = spans.find(s => s.innerText.includes('test_safe_keep_dir'));
    if (targetSpan) {
      const row = targetSpan.closest('.group');
      if (row) {
        const removeBtn = row.querySelector('button[title*="从工作区列表中移除"]');
        if (removeBtn) removeBtn.click();
      }
    }
  })()`);
  await sleep(1000);

  // 4. 验证弹窗文本
  const modalText = await evalJs(`(() => {
    const modal = document.querySelector('.fixed.inset-0');
    return modal ? modal.innerText : '';
  })()`);
  console.log("弹窗安全提示文本:\n", modalText);

  // 5. 点击弹窗中的【确认移除】
  await evalJs(`(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const confirmBtn = btns.find(b => b.innerText.includes('确认移除'));
    if (confirmBtn) confirmBtn.click();
  })()`);
  await sleep(1500);

  // 6. 验证侧边栏已移除
  const stillInSidebar = await evalJs(`document.body.innerText.includes('test_safe_keep_dir')`);
  console.log("工作区是否已从侧边栏移除:", !stillInSidebar ? "✅ 成功从侧边栏移除" : "❌ 未移除");

  // 7. 关键校验：检查物理磁盘上的文件夹和文件是否依然完整存在！
  const dirStillExistsOnDisk = fs.existsSync(testSafeDir);
  const fileStillExistsOnDisk = fs.existsSync(testFile);
  const fileContentMatches = fileStillExistsOnDisk && fs.readFileSync(testFile, "utf8").includes("绝对不能被删除");

  console.log("物理磁盘目录是否存在:", dirStillExistsOnDisk ? "✅ 完整存在（未被删除）" : "❌ 被删除了！");
  console.log("物理磁盘文件是否存在且完好:", fileContentMatches ? "✅ 完好无损！" : "❌ 丢失！");

  // 清理测试用的安全目录
  fs.rmSync(testSafeDir, { recursive: true, force: true });
  console.log("测试完毕，清理测试目录完成。");
} catch (e) {
  console.error("验证失败:", e);
} finally {
  if (ws && ws.readyState === WebSocket.OPEN) ws.close();
  try { chrome.kill(); } catch {}
  process.exit(0);
}
