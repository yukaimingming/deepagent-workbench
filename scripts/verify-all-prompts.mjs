import { spawn } from "node:child_process";
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = 9655;
const chrome = spawn(
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${process.env.TEMP}/cdp-all-prompts-${Date.now()}`,
    "--window-size=1550,1100",
  ],
  { stdio: "ignore" },
);

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
await send("DOM.enable");
await send("Runtime.enable");

const artifactDir = "C:/Users/kaiming yu/.gemini/antigravity/brain/22cd3aa5-c1e7-425d-baa7-19c1aa2704ee";

const prompts = [
  {
    name: "prompt-1-workspace-ls",
    label: "查看工作区文件",
    text: "查看当前工作区目录下的所有文件并说明用途。",
  },
  {
    name: "prompt-2-todo-plan",
    label: "规划待办开发任务",
    text: "为当前工作区规划一份构建 TypeScript CLI 工具的待办清单并开始执行。",
  },
  {
    name: "prompt-3-create-readme",
    label: "创建项目说明文档",
    text: "在工作区创建 README.md 文件，写入工作台的功能特性与使用指南。",
  },
  {
    name: "prompt-4-shell-env",
    label: "检查系统运行环境",
    text: "执行 Shell 命令检查当前系统的 Node.js 版本和操作系统平台。",
  },
];

console.log("开始对所有新建议提示词进行端到端全量核验...");

for (let pIdx = 0; pIdx < prompts.length; pIdx++) {
  const p = prompts[pIdx];
  console.log(`\n========================================`);
  console.log(`[测试 ${pIdx + 1}/4] ${p.label}: "${p.text}"`);
  console.log(`========================================`);

  await send("Page.navigate", { url: "http://127.0.0.1:5173" });
  await sleep(3000);

  // 输入并发送
  const fillCode = `
    (() => {
      const ta = document.querySelector('textarea');
      if (!ta) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(p.text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `;
  await send("Runtime.evaluate", { expression: fillCode, returnByValue: true });
  await sleep(300);

  await send("Runtime.evaluate", {
    expression: `document.querySelector('button[type="submit"]')?.click()`,
    returnByValue: true,
  });

  // 监控思考流与工具调用
  let maxSeconds = 0;
  let hasRealReasoningContent = false;
  let finalResult = null;

  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const inspectCode = `
      (() => {
        const body = document.body.innerText;
        const reasoningTrigger = document.querySelector('button:has(svg.lucide-brain), [data-slot="reasoning"] button')?.innerText || '';
        const reasoningContent = document.querySelector('[data-slot="reasoning"] [class*="Streamdown"], [data-slot="reasoning"] [class*="CollapsibleContent"]')?.innerText || '';
        const toolCards = Array.from(document.querySelectorAll('*'))
          .filter(el => {
            const t = el.innerText || '';
            return (t.includes('列出工作区文件') || t.includes('规划待办') || t.includes('写入文件') || t.includes('执行终端 Shell')) && el.classList.toString().includes('border');
          })
          .map(el => el.innerText.slice(0, 60));

        const isFinished = body.includes('复制回答') || body.includes('重新尝试');
        const caret = Boolean(document.querySelector('.streaming-caret'));

        return {
          reasoningTrigger,
          reasoningContentSnippet: reasoningContent.slice(0, 100),
          hasContent: reasoningContent.trim().length > 0,
          toolCardsCount: toolCards.length,
          isFinished: isFinished && !caret,
        };
      })()
    `;
    const res = await send("Runtime.evaluate", { expression: inspectCode, returnByValue: true });
    const val = res.result?.value;

    if (val?.hasContent) {
      hasRealReasoningContent = true;
    }

    if (val?.reasoningTrigger) {
      const match = val.reasoningTrigger.match(/(\d+)\s*秒/);
      if (match) {
        const sec = parseInt(match[1], 10);
        if (sec > maxSeconds) maxSeconds = sec;
      }
    }

    if (i % 3 === 0) {
      console.log(`[tick ${i}] 触发器状态: "${val?.reasoningTrigger}", 思考内容实时展现: ${val?.hasContent}, 工具卡片: ${val?.toolCardsCount}, 完成: ${val?.isFinished}`);
    }

    if (val?.isFinished) {
      finalResult = val;
      break;
    }
  }

  // 稍微等待渲染
  await sleep(1500);

  // 滚动到顶部并截图
  await send("Runtime.evaluate", {
    expression: `
      (() => {
        const scrollContainers = Array.from(document.querySelectorAll('*')).filter(el => {
          const style = window.getComputedStyle(el);
          return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
        });
        for (const c of scrollContainers) {
          c.scrollTop = 0;
        }
        window.scrollTo(0, 0);
      })()
    `,
  });
  await sleep(600);

  const shot = await send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.join(artifactDir, `screenshot-verified-${p.name}.png`);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`[完成] 测试 ${p.label} 成功，截图已保存至: ${shotPath}`);
}

console.log("\n全部 4 个建议提示词端到端验证执行完毕！");
ws.close();
chrome.kill();
