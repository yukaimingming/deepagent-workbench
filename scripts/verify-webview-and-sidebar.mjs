import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9657;
const tempProfile = `${process.env.TEMP}/cdp-verify-${Date.now()}`;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${tempProfile}`,
    "--window-size=1600,1050",
  ],
  { stdio: "ignore" },
);

try {
  await sleep(2500);
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
  const page = list.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.on("open", r));

  let id = 0;
  const send = (method, params = {}) =>
    new Promise((res) => {
      const msgId = ++id;
      const handler = (raw) => {
        const m = JSON.parse(raw);
        if (m.id === msgId) {
          ws.off("message", handler);
          res(m.result);
        }
      };
      ws.on("message", handler);
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });

  await send("Page.enable");
  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(3500);

  const artifactDir = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

  // 1. 验证新建对话状态：无内容，右侧扩展收缩栏自动隐藏
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const hooks = window.__deepagentTestHooks;
        if (hooks) {
          hooks.handleNewSession();
        }
      })()
    `,
  });
  await sleep(1000);

  const check1 = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const sidebar = document.querySelector('[data-testid="review-sidebar"]');
        const state = window.__deepagentTestHooks ? window.__deepagentTestHooks.getState() : null;
        return {
          hasReviewSidebar: Boolean(sidebar),
          messagesCount: state ? state.messages.length : 0,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log("场景 1 (新建会话无内容时是否隐藏右侧扩展栏):", check1.result.value);

  // 截图 1：新建对话，右侧收缩栏隐藏
  const shot1 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "screenshot-01-new-session-hidden.png"), Buffer.from(shot1.data, "base64"));
  console.log("已保存 screenshot-01-new-session-hidden.png");

  // 2. 点击 Header 右上角的 PanelRightIcon 按钮，展开右侧扩展栏
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const btn = document.querySelector('button[aria-label="右侧扩展栏"]');
        if (btn) btn.click();
      })()
    `,
  });
  await sleep(1000);

  const check2 = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const sidebar = document.querySelector('[data-testid="review-sidebar"]');
        const text = sidebar ? sidebar.innerText : '';
        return {
          hasReviewSidebar: Boolean(sidebar),
          hasBrowserAction: text.includes('Browser'),
          hasReviewAction: text.includes('Review'),
          hasTerminalAction: text.includes('Terminal'),
          hasOpenFileAction: text.includes('Open File'),
        };
      })()
    `,
    returnByValue: true,
  });
  console.log("场景 2 (展开右侧扩展栏包含Browser列表卡片):", check2.result.value);

  // 截图 2：右侧扩展栏展开，显示含有 Browser 快捷卡片的主列表
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "screenshot-02-right-sidebar-expanded-list.png"), Buffer.from(shot2.data, "base64"));
  console.log("已保存 screenshot-02-right-sidebar-expanded-list.png");

  // 3. 点击 Browser 卡片，进入 Webview 浏览器预览（WebPreview）
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const buttons = Array.from(document.querySelectorAll('[data-testid="review-sidebar"] button'));
        const browserBtn = buttons.find(b => b.innerText.includes('Browser'));
        if (browserBtn) {
          browserBtn.click();
          return true;
        }
        return false;
      })()
    `,
  });
  await sleep(1500);

  const check3 = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const iframe = document.querySelector('[data-testid="review-sidebar"] iframe');
        const input = document.querySelector('[data-testid="review-sidebar"] input[placeholder*="网址"]');
        return {
          hasIframe: Boolean(iframe),
          iframeSrc: iframe ? iframe.src : null,
          urlInputValue: input ? input.value : null,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log("场景 3 (打开Webview浏览器):", check3.result.value);

  // 截图 3：右侧 Webview 浏览器视图
  const shot3 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "screenshot-03-webview-browser-preview.png"), Buffer.from(shot3.data, "base64"));
  console.log("已保存 screenshot-03-webview-browser-preview.png");

  // 4. 点击左侧历史会话列表中真实的网络搜索会话（深圳天气）
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const items = Array.from(document.querySelectorAll('.sidebar-session-item, .truncate'));
        const target = items.find(el => el.textContent.includes('深圳天气'));
        if (target) {
          target.click();
          return true;
        }
        return false;
      })()
    `,
  });
  await sleep(2500);

  // 1. 点击展开外层 ProcessActivityGroup 折叠面板
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const toggleBtn = btns.find(b => b.innerText.includes('已完成分析') || b.innerText.includes('正在分析'));
        if (toggleBtn) toggleBtn.click();
      })()
    `,
  });
  await sleep(600);

  // 2. 展开内部具体工具 details
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const detailsList = document.querySelectorAll('details');
        detailsList.forEach(d => { d.open = true; });
      })()
    `,
  });
  await sleep(600);

  // 3. 点击第一个来源引用按钮（带有 Globe 地球图标）
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const sourceButtons = Array.from(document.querySelectorAll('button[title*="点击在右侧浏览器中预览"]'));
        if (sourceButtons.length > 0) {
          sourceButtons[0].click();
          return true;
        }
        return false;
      })()
    `,
  });
  await sleep(2000);

  const check4 = await send("Runtime.evaluate", {
    expression: `
      (() => {
        const iframe = document.querySelector('[data-testid="review-sidebar"] iframe');
        const input = document.querySelector('[data-testid="review-sidebar"] input[placeholder*="网址"]');
        const activeTab = document.querySelector('[data-testid="review-sidebar"] div[class*="border-blue-500"]');
        return {
          hasIframe: Boolean(iframe),
          iframeSrc: iframe ? iframe.src : null,
          urlInputValue: input ? input.value : null,
          tabTitle: activeTab ? activeTab.innerText.trim() : null,
        };
      })()
    `,
    returnByValue: true,
  });
  console.log("场景 4 (点击来源引用直接在右侧Webview中预览):", check4.result.value);

  // 截图 4：深色主题下，左侧聊天+详细过程来源引用，右侧 Webview 展开联动预览
  const shot4 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "screenshot-04-dark-source-jump-webview.png"), Buffer.from(shot4.data, "base64"));
  console.log("已保存 screenshot-04-dark-source-jump-webview.png");

  // 5. 切换到浅色主题并截图对比
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
        document.documentElement.setAttribute('data-theme', 'light');
      })()
    `,
  });
  await sleep(800);

  const shot5 = await send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(artifactDir, "screenshot-05-light-source-jump-webview.png"), Buffer.from(shot5.data, "base64"));
  console.log("已保存 screenshot-05-light-source-jump-webview.png");

  ws.close();
} catch (e) {
  console.error("验证过程异常:", e);
} finally {
  chrome.kill();
  process.exit(0);
}
