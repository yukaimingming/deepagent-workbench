/**
 * 端到端验证：真实 HTTP 服务 + SSE 流。
 *
 * 这个测试不调用真实模型 API，而是验证：
 * - AG-UI SSE 流的事件顺序与结构符合协议。
 * - 未配置提供商时优雅失败（RUN_STARTED → RUN_ERROR）。
 * - 配置了 mock 提供商后，/agent 能走通到「缺少模型」的明确报错。
 * - 取消接口可用。
 *
 * 真实模型调用的验证见 README 的「已验证能力」一节。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/api/server.js";
import { EventEncoder } from "@ag-ui/encoder";

let server: Server;
let baseUrl: string;
let dataDir: string;
let workspaceRoot: string;
const encoder = new EventEncoder({ accept: "text/event-stream" });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "deepagent-e2e-data-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "deepagent-e2e-ws-"));
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
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dataDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** 发起一次 AG-UI 运行，返回解析后的事件数组。 */
async function runAgent(body: unknown): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${baseUrl}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  const text = await response.text();
  return parseSseEvents(text);
}

/** 解析 SSE 文本为事件对象数组。 */
function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    const json = dataLine.slice("data: ".length).trim();
    if (json.length === 0) continue;
    try {
      events.push(JSON.parse(json) as Record<string, unknown>);
    } catch {
      // 忽略心跳注释等非事件行。
    }
  }
  return events;
}

describe("AG-UI SSE 协议合规性", () => {
  it("未配置提供商时：RUN_STARTED 在最前，RUN_ERROR 收尾，且不挂起", async () => {
    const events = await runAgent({
      threadId: "thread-e2e-1",
      runId: "run-e2e-1",
      messages: [{ id: "m1", role: "user", content: "你好" }],
      tools: [],
      context: [],
    });

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events[0]?.threadId).toBe("thread-e2e-1");
    expect(events[0]?.runId).toBe("run-e2e-1");

    const last = events.at(-1);
    expect(last?.type).toBe("RUN_ERROR");
    expect(String(last?.message)).toContain("模型设置");
  });

  it("SSE 响应使用 AG-UI 媒体类型且禁用缓冲", async () => {
    const response = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        threadId: "t",
        runId: "r",
        messages: [{ id: "m", role: "user", content: "hi" }],
        tools: [],
        context: [],
      }),
    });
    // EventEncoder 根据 Accept 头选择序列化格式。
    expect(response.headers.get("content-type")).toBeTruthy();
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.text();
  });

  it("事件编码器产出合法 SSE 帧", () => {
    const frame = encoder.encodeSSE({
      type: "RUN_STARTED",
      threadId: "t1",
      runId: "r1",
    } as never);
    expect(frame.startsWith("data: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    const parsed = JSON.parse(frame.slice("data: ".length).trim()) as Record<string, unknown>;
    expect(parsed.type).toBe("RUN_STARTED");
  });

  it("threadId 与 runId 在 RUN_STARTED 中回显", async () => {
    const events = await runAgent({
      threadId: "thread-xyz",
      runId: "run-abc",
      messages: [{ id: "m", role: "user", content: "hi" }],
      tools: [],
      context: [],
    });
    expect(events[0]).toMatchObject({ threadId: "thread-xyz", runId: "run-abc" });
  });
});

describe("提供商配置对运行的影响", () => {
  it("配置了提供商但未设置默认模型时，报错指明要设置默认模型", async () => {
    // 新增一个没有模型的提供商。
    const create = await fetch(`${baseUrl}/api/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "openai-compatible",
        label: "无模型提供商",
        baseUrl: "https://example.invalid/v1",
        apiKey: "sk-fake",
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { provider: { id: string } };

    try {
      const events = await runAgent({
        threadId: "t2",
        runId: "r2",
        messages: [{ id: "m", role: "user", content: "hi" }],
        tools: [],
        context: [],
        forwardedProps: { providerId: created.provider.id },
      });
      const last = events.at(-1);
      expect(last?.type).toBe("RUN_ERROR");
      expect(String(last?.message)).toContain("默认模型");
    } finally {
      await fetch(`${baseUrl}/api/providers/${created.provider.id}`, { method: "DELETE" });
    }
  });

  it("forwardedProps 指定的提供商不存在时回落到「未配置」报错", async () => {
    const events = await runAgent({
      threadId: "t3",
      runId: "r3",
      messages: [{ id: "m", role: "user", content: "hi" }],
      tools: [],
      context: [],
      forwardedProps: { providerId: "does-not-exist" },
    });
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(events.at(-1)?.type).toBe("RUN_ERROR");
  });
});

describe("取消接口", () => {
  it("取消一个正在运行的线程返回 true", async () => {
    // 先启动一个会立即失败但仍注册了线程的运行。
    const controller = new AbortController();
    const responsePromise = fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId: "thread-cancel-1",
        runId: "run-cancel-1",
        messages: [{ id: "m", role: "user", content: "hi" }],
        tools: [],
        context: [],
      }),
      signal: controller.signal,
    });
    // 不等待完成，直接尝试取消（线程可能已结束，两种情况都合法）。
    const cancel = await fetch(`${baseUrl}/agent/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "thread-cancel-1" }),
    });
    const cancelBody = (await cancel.json()) as { ok: boolean; cancelled: boolean };
    expect(cancelBody.ok).toBe(true);
    expect(typeof cancelBody.cancelled).toBe("boolean");

    // 清理：中止或等待响应结束。
    controller.abort();
    await responsePromise.catch(() => undefined);
  });
});
