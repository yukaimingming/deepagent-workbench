/**
 * 多会话并发运行 + 配置落盘的集成测试。
 *
 * 目的：直接验证用户提出的两个行为，而不是靠推断。
 *
 * 1. 配置保存必须真正落盘（修复「添加模型厂商保存不了」）。
 * 2. 不同 threadId 的运行必须彼此独立：
 *    - 两个运行可以同时处于「进行中」；
 *    - 取消其中一个线程，不会影响另一个线程的运行。
 *
 * 实现方式：起一个假的 OpenAI 兼容服务，收到 /chat/completions 后
 * 只回一个 SSE 分片并**保持连接不结束**，这样两次运行都会稳定地停在
 * 「等待模型」的进行中状态，从而可以可靠地观察并发与取消的隔离性。
 * 全程不访问真实模型服务。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/api/server.js";

let server: Server;
let baseUrl: string;
let dataDir: string;
let workspaceRoot: string;

/** 假模型服务。 */
let fakeServer: Server;
let fakeUrl: string;
/** 保持打开的下游响应，用于在测试结束时收尾。 */
const openFakeResponses = new Set<ServerResponse>();
/** 记录每个线程在假服务上触发的请求数。 */
const modelCallsByThread = new Map<string, number>();

beforeAll(async () => {
  // 关闭外部 tracing，避免测试期间产生外网请求。
  process.env.LANGCHAIN_TRACING_V2 = "false";
  process.env.LANGSMITH_TRACING = "false";

  fakeServer = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      // 从请求体里取一个标记，便于确认请求确实来自不同的运行。
      const marker = /"content":"([^"]*)"/.exec(body)?.[1] ?? "unknown";
      modelCallsByThread.set(marker, (modelCallsByThread.get(marker) ?? 0) + 1);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const chunk = {
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "test-model",
        choices: [
          { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
        ],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      // 关键：不发 [DONE]，也不结束响应 → 运行保持在「进行中」。
      openFakeResponses.add(res);
      req.on("close", () => openFakeResponses.delete(res));
    });
  });
  await new Promise<void>((done) => fakeServer.listen(0, "127.0.0.1", () => done()));
  const fakeAddress = fakeServer.address();
  const fakePort = typeof fakeAddress === "object" && fakeAddress ? fakeAddress.port : 0;
  fakeUrl = `http://127.0.0.1:${fakePort}/v1`;

  dataDir = await mkdtemp(join(tmpdir(), "deepagent-conc-data-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "deepagent-conc-ws-"));
  const app = await createApp({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    workspaceRoot,
  });
  server = app.server;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
}, 30_000);

afterAll(async () => {
  for (const res of openFakeResponses) res.destroy();
  openFakeResponses.clear();
  await new Promise<void>((done) => server.close(() => done()));
  await new Promise<void>((done) => fakeServer.close(() => done()));
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** 创建指向假模型服务的提供商，返回其 id。 */
async function createProvider(label: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/providers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "openai-compatible",
      label,
      baseUrl: fakeUrl,
      apiKey: "sk-test-not-a-real-key",
      models: ["test-model"],
      defaultModel: "test-model",
      enabled: true,
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { provider: { id: string } };
  return body.provider.id;
}

/** 发起一次运行，并等待它发出第一个事件（RUN_STARTED）。 */
async function startRun(
  threadId: string,
  runId: string,
  providerId: string,
  content: string,
): Promise<{ reader: ReadableStreamDefaultReader<Uint8Array>; firstEvent: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      threadId,
      runId,
      messages: [{ id: `m-${threadId}`, role: "user", content }],
      tools: [],
      context: [],
      forwardedProps: { providerId },
    }),
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const firstEvent = await readFirstEvent(reader);
  return { reader, firstEvent };
}

/** 逐块读取直到解析出第一个完整 SSE 事件。 */
async function readFirstEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
      if (!dataLine) continue;
      try {
        return JSON.parse(dataLine.slice("data: ".length).trim()) as Record<string, unknown>;
      } catch {
        // 忽略非 JSON 行
      }
    }
  }
  throw new Error("等待 RUN_STARTED 超时");
}

/** 排空剩余事件流。 */
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

async function cancel(threadId: string): Promise<{ ok: boolean; cancelled: boolean }> {
  const response = await fetch(`${baseUrl}/agent/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { ok: boolean; cancelled: boolean };
}

describe("提供商配置落盘", () => {
  it("新增提供商后配置立即写入磁盘，且密钥不下发前端", async () => {
    const id = await createProvider("并发测试提供商");

    // 1) 磁盘上确实存在该配置（修复「保存不了」的核心断言）。
    const raw = await readFile(join(dataDir, "providers.json"), "utf8");
    const parsed = JSON.parse(raw) as { providers: Array<Record<string, unknown>> };
    const stored = parsed.providers.find((provider) => provider.id === id);
    expect(stored).toBeTruthy();
    expect(stored?.apiKey).toBe("sk-test-not-a-real-key");
    expect(stored?.defaultModel).toBe("test-model");

    // 2) 列表接口返回掩码，不泄露明文密钥。
    const listResponse = await fetch(`${baseUrl}/api/providers`);
    const listText = await listResponse.text();
    expect(listText).not.toContain("sk-test-not-a-real-key");
    const list = JSON.parse(listText) as {
      providers: Array<{ id: string; hasApiKey: boolean; apiKeyMask: string }>;
    };
    const publicProvider = list.providers.find((provider) => provider.id === id);
    expect(publicProvider?.hasApiKey).toBe(true);
    expect(publicProvider?.apiKeyMask).not.toBe("sk-test-not-a-real-key");
  });

  it("更新提供商后新值同样落盘", async () => {
    const id = await createProvider("待更新提供商");
    const updateResponse = await fetch(`${baseUrl}/api/providers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "openai-compatible",
        label: "已更新提供商",
        baseUrl: fakeUrl,
        models: ["test-model", "test-model-2"],
        defaultModel: "test-model-2",
        enabled: false,
      }),
    });
    expect(updateResponse.status).toBe(200);

    const raw = await readFile(join(dataDir, "providers.json"), "utf8");
    const parsed = JSON.parse(raw) as { providers: Array<Record<string, unknown>> };
    const stored = parsed.providers.find((provider) => provider.id === id);
    expect(stored?.label).toBe("已更新提供商");
    expect(stored?.defaultModel).toBe("test-model-2");
    expect(stored?.enabled).toBe(false);
    // 未传 apiKey 时应保留原密钥。
    expect(stored?.apiKey).toBe("sk-test-not-a-real-key");
  });
});

describe("多会话并发运行", () => {
  it("两个线程可以同时处于运行中，取消其中一个不影响另一个", async () => {
    const providerId = await createProvider("并发运行提供商");

    const threadA = "thread-concurrent-a";
    const threadB = "thread-concurrent-b";

    const a = await startRun(threadA, "run-a", providerId, "任务A：请执行一个长任务");
    const b = await startRun(threadB, "run-b", providerId, "任务B：请执行另一个长任务");

    // 两个运行都已启动，且各自回显自己的 threadId（互不串线）。
    expect(a.firstEvent.type).toBe("RUN_STARTED");
    expect(a.firstEvent.threadId).toBe(threadA);
    expect(b.firstEvent.type).toBe("RUN_STARTED");
    expect(b.firstEvent.threadId).toBe(threadB);

    // 取消 B：A 的运行句柄必须依然存在。
    const cancelB = await cancel(threadB);
    expect(cancelB.cancelled).toBe(true);

    const cancelA = await cancel(threadA);
    expect(cancelA.cancelled).toBe(true);

    // 收尾两个流，避免测试进程挂住。
    const [textA, textB] = await Promise.all([drain(a.reader), drain(b.reader)]);
    // 被取消的运行最终会以 RUN_ERROR（中止）或 RUN_FINISHED 收尾，
    // 两种都说明流被正确关闭而不是悬挂。
    expect(textA.length).toBeGreaterThan(0);
    expect(textB.length).toBeGreaterThan(0);

    // 取消已结束的线程应返回 cancelled=false，而不是报错。
    const cancelAgain = await cancel(threadA);
    expect(cancelAgain.ok).toBe(true);
    expect(cancelAgain.cancelled).toBe(false);
  }, 60_000);

  it("取消一个线程后，另一个线程仍可正常取消（运行句柄未被误删）", async () => {
    const providerId = await createProvider("取消隔离提供商");
    const threadC = "thread-isolation-c";
    const threadD = "thread-isolation-d";

    const c = await startRun(threadC, "run-c", providerId, "任务C");
    const d = await startRun(threadD, "run-d", providerId, "任务D");

    expect((await cancel(threadC)).cancelled).toBe(true);
    // D 必须仍然在线，说明 C 的取消/清理没有误删 D 的句柄。
    expect((await cancel(threadD)).cancelled).toBe(true);

    await Promise.all([drain(c.reader), drain(d.reader)]);
  }, 60_000);
});
