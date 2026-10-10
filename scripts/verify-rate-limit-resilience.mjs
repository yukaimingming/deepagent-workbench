/**
 * 验证服务端对「模型侧限流」的健壮性。
 *
 * 背景：实测 StepFun 返回 `429 concurrency reached, current: 6, limit: 5` 时，
 * LangGraph 内部异常曾以未处理 rejection 的形式逃逸，把整个本地服务进程打崩
 * （崩掉后所有正在进行的会话一起丢失）。
 *
 * 本脚本用假模型服务稳定复现 429，然后检查：
 * 1. 运行以 RUN_ERROR 收尾，而不是让连接悬挂；
 * 2. 服务进程仍然存活，/api/health 依然可用；
 * 3. 之后仍能正常接受新的运行请求。
 *
 * 全程不访问真实模型 API。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8790;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, value, extra = "") => {
  results.push([name, value]);
  console.log(`${value ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
};

/* ---------- 1. 假模型服务：一律返回 429 并发超限 ---------- */

const fakeModel = createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
    res.writeHead(404).end();
    return;
  }
  req.on("data", () => {});
  req.on("end", () => {
    // 延迟 2 秒再返回 429：让客户端有机会在运行中途断开，
    // 复现「用户点停止 / 切走页面后模型才报错」的时序。
    setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "429 concurrency reached, current: 6, limit: 5",
            type: "rate_limit_error",
            code: "rate_limit_exceeded",
          },
        }),
      );
    }, 2000);
  });
});
await new Promise((r) => fakeModel.listen(0, "127.0.0.1", r));
const fakePort = fakeModel.address().port;
console.log("假模型服务端口:", fakePort);

/* ---------- 2. 以子进程方式启动真实服务端 ---------- */

const dataDir = await mkdtemp(join(tmpdir(), "deepagent-429-data-"));
const workspaceRoot = await mkdtemp(join(tmpdir(), "deepagent-429-ws-"));

const server = spawn(
  process.execPath,
  [
    join(process.cwd(), "apps", "server", "node_modules", "tsx", "dist", "cli.mjs"),
    join(process.cwd(), "apps", "server", "src", "index.ts"),
    "--port",
    String(PORT),
    "--data-dir",
    dataDir,
    "--workspace",
    workspaceRoot,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let serverExited = false;
let serverExitInfo = "";
server.on("exit", (code, signal) => {
  serverExited = true;
  serverExitInfo = `code=${code} signal=${signal}`;
});
const serverLog = [];
server.stdout.on("data", (d) => serverLog.push(String(d)));
server.stderr.on("data", (d) => serverLog.push(String(d)));

/** 轮询等待服务端就绪。 */
async function waitForReady(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (serverExited) throw new Error(`服务端提前退出: ${serverExitInfo}`);
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      // 还没起来
    }
    await sleep(400);
  }
  throw new Error("服务端启动超时");
}

const cleanup = async () => {
  try {
    server.kill("SIGKILL");
  } catch {
    // 忽略
  }
  fakeModel.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
};

try {
  await waitForReady();
  check("服务端启动成功", true);

  // 配置指向假模型的提供商
  const createRes = await fetch(`${BASE}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "openai-compatible",
      label: "429 测试提供商",
      baseUrl: `http://127.0.0.1:${fakePort}/v1`,
      apiKey: "sk-fake-429",
      models: ["rate-limited-model"],
      defaultModel: "rate-limited-model",
      enabled: true,
    }),
  });
  const providerId = (await createRes.json()).provider.id;

  /** 发起一次运行，返回收集到的事件文本。 */
  const runOnce = async (threadId) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`${BASE}/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          threadId,
          runId: `run-${threadId}`,
          messages: [{ id: `m-${threadId}`, role: "user", content: "触发限流" }],
          tools: [],
          context: [],
          forwardedProps: { providerId },
        }),
        signal: controller.signal,
      });
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  };

  // 并发触发，模拟用户同时跑多个会话撞上并发上限
  console.log("并发触发 3 个运行（假模型一律返回 429）…");
  const texts = await Promise.all([
    runOnce("rl-thread-1"),
    runOnce("rl-thread-2"),
    runOnce("rl-thread-3"),
  ]);

  const allHaveRunError = texts.every((t) => t.includes("RUN_ERROR"));
  check("三个运行都以 RUN_ERROR 收尾（未悬挂）", allHaveRunError);

  const mentionsConcurrency = texts.some((t) => t.includes("并发超限"));
  check("错误信息是可读的中文并发超限提示", mentionsConcurrency, texts[0]?.match(/"message":"[^"]*"/)?.[0] ?? "");

  // 关键断言：进程必须还活着
  await sleep(1500);
  check("服务端进程仍然存活", !serverExited, serverExitInfo);

  const healthRes = await fetch(`${BASE}/api/health`);
  check("/api/health 仍然可用", healthRes.ok);

  const health = await healthRes.json();
  check("健康检查仍报告提供商配置", health.providerCount >= 1, `providerCount=${health.providerCount}`);

  // 崩溃后连不上；这里再发一次运行，确认服务仍能正常工作
  const afterText = await runOnce("rl-thread-after");
  check("崩溃场景之后仍能接受新运行", afterText.includes("RUN_ERROR"));

  /* ---------- 场景二：运行中途客户端断开 ---------- */

  console.log("\n场景二：运行中途客户端主动断开（模拟点停止 / 切走页面）…");
  const abortController = new AbortController();
  const abortPromise = fetch(`${BASE}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      threadId: "rl-thread-abort",
      runId: "run-abort",
      messages: [{ id: "m-abort", role: "user", content: "运行中被打断" }],
      tools: [],
      context: [],
      forwardedProps: { providerId },
    }),
    signal: abortController.signal,
  }).catch(() => undefined);

  // 等运行真正开始后再断开
  await sleep(700);
  abortController.abort();
  await abortPromise;
  // 等到假模型那边的 429 到达（延迟 2 秒）
  await sleep(3500);

  check("客户端断开后服务端进程仍存活", !serverExited, serverExitInfo);
  const healthAfterAbort = await fetch(`${BASE}/api/health`).catch(() => null);
  check("客户端断开后 /api/health 仍可用", healthAfterAbort?.ok === true);

  const finalRun = await runOnce("rl-thread-final");
  check("客户端断开后仍能接受新运行", finalRun.includes("RUN_ERROR"));

  console.log("\n--- 服务端日志尾部 ---");
  console.log(serverLog.join("").split("\n").slice(-12).join("\n"));
} finally {
  await cleanup();
}

const failed = results.filter(([, v]) => !v).length;
console.log(`\n结果: ${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
