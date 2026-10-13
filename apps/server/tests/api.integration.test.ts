/**
 * 服务端 HTTP 接口的集成测试。
 *
 * 用真实 HTTP 服务 + mock fetch 驱动，不调用任何真实模型 API。
 * 重点验证：配置增删改查、密钥掩码、模型列表错误分类、
 * 未配置提供商时的 AG-UI 错误回传。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../src/api/server.js";
import { WorkbenchStore } from "../src/config/workbench-store.js";

/** 测试用的 API Key，绝不外泄到任何响应。 */
const SECRET_KEY = "sk-test-secret-key-1234567890abcd";

let server: Server;
let baseUrl: string;
let dataDir: string;
let workspaceRoot: string;
let closeApp: (() => Promise<void>) | undefined;
/** 测试注入的假 fetch。 */
let injectedFetch: typeof fetch;
/** 当前测试设置的真实处理器。 */
type FetchArgs = Parameters<typeof fetch>;
let fetchHandler: ((...args: FetchArgs) => Promise<Response>) | null = null;

/** 记录一次请求并返回固定响应。 */
function stubFetch(response: () => Response): void {
  fetchHandler = async () => response();
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "deepagent-data-"));
  workspaceRoot = await mkdtemp(join(tmpdir(), "deepagent-ws-"));
  // 所有模型列表请求都走注入的假 fetch，绝不发真实网络请求。
  injectedFetch = (async (...args: FetchArgs) => {
    const handler = fetchHandler ?? (async () => new Response("no handler", { status: 500 }));
    return handler(...args);
  }) as typeof fetch;

  const app = await createApp({
    host: "127.0.0.1",
    port: 0, // 让系统分配空闲端口
    dataDir,
    workspaceRoot,
    fetchImpl: injectedFetch,
  });
  closeApp = app.close;
  server = app.server;
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", () => resolveListen());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await closeApp?.();
  // Windows 上 rm 对刚关闭的目录可能偶发 ENOTEMPTY，重试几次即可。
  await rmWithRetry(dataDir);
  await rmWithRetry(workspaceRoot);
});

describe("工作台本地持久化", () => {
  it("跨前端 origin 读取会话索引和含图片的会话状态", async () => {
    const index = {
      version: 1,
      customWorkspaces: ["D:/work/project"],
      sessions: [{
        id: "thread-persist-1",
        title: "图片对话",
        createdAt: 100,
        updatedAt: 200,
        messageCount: 1,
        workspaceRoot: "D:/work/project",
        folderName: "project",
      }],
      activeSessionId: "thread-persist-1",
      currentWorkspace: "D:/work/project",
    };
    expect((await api("PUT", "/api/workbench", index)).status).toBe(200);
    expect((await api("GET", "/api/workbench")).body.workbench).toEqual(index);
    const indexMarkdown = await readFile(join(dataDir, "workbench", "index.md"), "utf8");
    expect(indexMarkdown).toContain("# 工作台索引");
    expect(indexMarkdown).toContain("```json");

    const state = { threadId: "thread-persist-1", messages: [{
      role: "user",
      content: "这张图是什么？",
      attachments: [{ filename: "sample.png", url: "data:image/png;base64,aW1hZ2U=" }],
    }] };
    expect((await api("PUT", "/api/workbench/sessions/thread-persist-1", state)).status).toBe(200);
    expect((await api("GET", "/api/workbench/sessions/thread-persist-1")).body.state).toEqual(state);
    const sessionMarkdown = await readFile(join(dataDir, "workbench", "sessions", "thread-persist-1.md"), "utf8");
    expect(sessionMarkdown).toContain("# 会话状态");
    expect(sessionMarkdown).toContain("sample.png");
    const afterRestart = new WorkbenchStore(dataDir);
    expect(await afterRestart.loadIndex()).toEqual(index);
    expect(await afterRestart.loadSessionState("thread-persist-1")).toEqual(state);
  });

  it("拒绝路径穿越形式的会话标识", async () => {
    const response = await fetch(`${baseUrl}/api/workbench/sessions/%2e%2e`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect([400, 404]).toContain(response.status);
  });
});

/** 删除临时目录，失败时重试。 */
async function rmWithRetry(target: string, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      if (i === attempts - 1) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed, raw };
}

describe("健康检查", () => {
  it("返回服务状态与工作区信息", async () => {
    const { status, body } = await api("GET", "/api/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.workspaceRoot).toBe(workspaceRoot);
    expect(body.shellEnabled).toBe(false);
    expect(body.approvalRequired).toBe(true);
  });
});

describe("提供商配置 CRUD", () => {
  it("初始为空", async () => {
    const { status, body } = await api("GET", "/api/providers");
    expect(status).toBe(200);
    expect(body.providers).toEqual([]);
  });

  it("创建后列表返回掩码摘要，绝不明文密钥", async () => {
    const { status, body } = await api("POST", "/api/providers", {
      type: "stepfun",
      label: "StepFun 测试",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      apiKey: SECRET_KEY,
      models: ["step-3.5-flash-2603"],
      defaultModel: "step-3.5-flash-2603",
    });
    expect(status).toBe(201);
    const provider = body.provider as Record<string, unknown>;
    expect(provider.label).toBe("StepFun 测试");
    expect(provider.hasApiKey).toBe(true);
    expect(provider.apiKeyMask).not.toContain(SECRET_KEY);
    // 整个响应体都不能出现明文密钥。
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
  });

  it("拒绝非法配置并返回中文错误", async () => {
    const { status, body } = await api("POST", "/api/providers", {
      type: "stepfun",
      label: "",
      baseUrl: "ftp://invalid",
      apiKey: "",
    });
    expect(status).toBe(400);
    const issues = body.issues as Array<{ path: string; message: string }>;
    expect(issues.length).toBeGreaterThanOrEqual(3);
    expect(issues.some((issue) => issue.path === "baseUrl")).toBe(true);
  });

  it("配置被持久化到磁盘", async () => {
    const { body } = await api("GET", "/api/providers");
    const providers = body.providers as Array<Record<string, unknown>>;
    expect(providers).toHaveLength(1);
    expect(providers[0]?.label).toBe("StepFun 测试");
  });

  it("更新时省略 apiKey 仍保留原密钥", async () => {
    const list = await api("GET", "/api/providers");
    const first = (list.body.providers as Array<{ id: string }>)[0];
    expect(first).toBeDefined();

    const { status, body } = await api("PUT", `/api/providers/${first?.id ?? ""}`, {
      type: "stepfun",
      label: "改名后的提供商",
      baseUrl: "https://api.stepfun.com/step_plan/v1",
      models: ["step-3.5-flash-2603", "step-2-16k"],
      defaultModel: "step-2-16k",
      enabled: true,
    });
    expect(status).toBe(200);
    const provider = body.provider as Record<string, unknown>;
    expect(provider.label).toBe("改名后的提供商");
    // 密钥未重新提供，但 hasApiKey 仍应为 true（store 保留了原值）。
    expect(provider.hasApiKey).toBe(true);
  });

  it("删除后列表为空", async () => {
    const list = await api("GET", "/api/providers");
    const first = (list.body.providers as Array<{ id: string }>)[0];
    const { status, body } = await api("DELETE", `/api/providers/${first?.id ?? ""}`);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);

    const after = await api("GET", "/api/providers");
    expect(after.body.providers).toEqual([]);
  });

  it("操作不存在的提供商返回 404", async () => {
    const { status } = await api("PUT", "/api/providers/nope", {
      type: "openai",
      label: "x",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "k",
    });
    expect(status).toBe(404);
  });
});

describe("模型列表获取的错误分类", () => {
  async function createProvider(baseUrl: string, apiKey = SECRET_KEY): Promise<string> {
    const { body } = await api("POST", "/api/providers", {
      type: "openai-compatible",
      label: "mock",
      baseUrl,
      apiKey,
    });
    return (body.provider as { id: string }).id;
  }

  it("鉴权失败被归类为 auth，且不判定为密钥格式问题以外的原因", async () => {
    const id = await createProvider("https://auth-fail.example.com/v1");
    stubFetch(() => new Response("unauthorized", { status: 401 }));
    const { body } = await api("POST", `/api/providers/${id}/models`);
    expect(body.ok).toBe(false);
    expect(body.errorKind).toBe("auth");
    expect(String(body.message)).toContain("鉴权");
  });

  it("404 被归类为接口不支持，并提示手动添加", async () => {
    const id = await createProvider("https://no-models.example.com/v1");
    stubFetch(() => new Response("not found", { status: 404 }));
    const { body } = await api("POST", `/api/providers/${id}/models`);
    expect(body.errorKind).toBe("unsupported");
    expect(String(body.hint)).toContain("手动");
  });

  it("网络错误被归类为 network", async () => {
    const id = await createProvider("https://unreachable.invalid/v1");
    fetchHandler = async () => {
      throw new Error("fetch failed");
    };
    const { body } = await api("POST", `/api/providers/${id}/models`);
    expect(body.errorKind).toBe("network");
  });

  it("空列表不被误判为密钥无效", async () => {
    const id = await createProvider("https://empty.example.com/v1");
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { body } = await api("POST", `/api/providers/${id}/models`);
    expect(body.ok).toBe(false);
    expect(body.errorKind).toBe("empty");
    // 「空列表不等于密钥无效」的说明放在 hint 里，避免和 message 混为一谈。
    expect(String(body.hint)).toContain("不代表密钥无效");
  });

  it("成功时合并进配置", async () => {
    const id = await createProvider("https://ok.example.com/v1");
    stubFetch(
      () =>
        new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const { body } = await api("POST", `/api/providers/${id}/models`);
    expect(body.ok).toBe(true);
    expect(body.models).toEqual(["model-a", "model-b"]);

    const list = await api("GET", "/api/providers");
    const provider = (list.body.providers as Array<{ id: string; models: string[] }>).find(
      (item) => item.id === id,
    );
    expect(provider?.models).toEqual(["model-a", "model-b"]);
  });
});

describe("AG-UI 运行端点", () => {
  it("未配置提供商时返回 RUN_ERROR 而不是挂起", async () => {
    const response = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({
        threadId: "thread-x",
        runId: "run-x",
        messages: [{ id: "m1", role: "user", content: "你好" }],
        tools: [],
        context: [],
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("event-stream");
    const text = await response.text();
    expect(text).toContain("RUN_STARTED");
    expect(text).toContain("RUN_ERROR");
    expect(text).toContain("模型设置");
  });

  it("请求体不合法时返回 400 与中文错误", async () => {
    const response = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ threadId: "t" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("RunAgentInput");
  });

  it("取消不存在的线程返回 cancelled=false", async () => {
    const { body } = await api("POST", "/agent/cancel", { threadId: "not-running" });
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(false);
  });
});

describe("来源校验", () => {
  it("拒绝非本地来源的跨站请求", async () => {
    const response = await fetch(`${baseUrl}/api/providers`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(response.status).toBe(403);
  });
});

describe("密钥不外泄", () => {
  it("所有接口响应都不含明文密钥", async () => {
    const create = await api("POST", "/api/providers", {
      type: "anthropic",
      label: "Anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: SECRET_KEY,
      models: ["claude-sonnet-4-5"],
    });
    const id = (create.body.provider as { id: string }).id;
    const list = await api("GET", "/api/providers");
    expect(list.raw).not.toContain(SECRET_KEY);

    stubFetch(
      () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const models = await api("POST", `/api/providers/${id}/models`);
    expect(models.raw).not.toContain(SECRET_KEY);

    await api("DELETE", `/api/providers/${id}`);
  });
});
