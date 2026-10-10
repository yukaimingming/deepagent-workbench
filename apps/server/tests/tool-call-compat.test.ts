/**
 * OpenAI 兼容层 tool_calls 补全的单元测试。
 *
 * 背景：DeepAgent 多轮工具调用时，LangChain 会把上一轮 assistant 消息里的
 * tool_calls 回传给提供商。StepFun 等 OpenAI-compatible 服务在历史里出现
 * 缺字段的 tool_calls 时会返回 400：
 * `tool_calls.id and tool_calls.type are required`。
 *
 * 补全发生在 fetch 层（唯一确定能拦到每次请求的位置），
 * 这里用一个假 fetch 捕获被发出的请求体来验证。
 */

import { describe, expect, it, vi } from "vitest";
import { createModel, createToolCallCompatFetch } from "../src/providers/adapter.js";
import type { ProviderConfig } from "@deepagent/shared";

/** 用假 fetch 跑一遍补全，返回最终发出的 body。 */
async function runCompat(requestBody: unknown): Promise<{ body: string }> {
  const captured: RequestInit[] = [];
  const fakeFetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
    if (init) captured.push(init);
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const compatFetch = createToolCallCompatFetch();
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch as unknown as typeof fetch;
  try {
    await compatFetch("https://example.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(requestBody),
    });
  } finally {
    globalThis.fetch = original;
  }

  const sent = captured[0];
  return { body: typeof sent?.body === "string" ? sent.body : "" };
}

describe("tool_calls 补全", () => {
  it("缺 id 和 type 的 assistant tool_calls 被补齐", async () => {
    const { body } = await runCompat({
      model: "m",
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ function: { name: "ls", arguments: "{}" } }],
        },
      ],
    });
    const parsed = JSON.parse(body) as {
      messages: Array<{ tool_calls?: Array<{ id?: string; type?: string }> }>;
    };
    const call = parsed.messages[1]?.tool_calls?.[0];
    expect(typeof call?.id).toBe("string");
    expect((call?.id ?? "").length).toBeGreaterThan(0);
    expect(call?.type).toBe("function");
  });

  it("只缺 type 时补 type，保留原 id", async () => {
    const { body } = await runCompat({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_abc", function: { name: "ls", arguments: "{}" } }],
        },
      ],
    });
    const parsed = JSON.parse(body) as {
      messages: Array<{ tool_calls?: Array<{ id?: string; type?: string }> }>;
    };
    const call = parsed.messages[0]?.tool_calls?.[0];
    expect(call?.id).toBe("call_abc");
    expect(call?.type).toBe("function");
  });

  it("只缺 id 时补 id，保留原 type", async () => {
    const { body } = await runCompat({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ type: "function", function: { name: "ls", arguments: "{}" } }],
        },
      ],
    });
    const parsed = JSON.parse(body) as {
      messages: Array<{ tool_calls?: Array<{ id?: string; type?: string }> }>;
    };
    const call = parsed.messages[0]?.tool_calls?.[0];
    expect(typeof call?.id).toBe("string");
    expect(call?.type).toBe("function");
  });

  it("字段完整的 tool_calls 一个字节都不改", async () => {
    const original = {
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_x", type: "function", function: { name: "ls", arguments: "{}" } }],
        },
      ],
    };
    const { body } = await runCompat(original);
    expect(body).toBe(JSON.stringify(original));
  });

  it("多个 tool_calls 各自补上不重复的 id", async () => {
    const { body } = await runCompat({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { function: { name: "ls", arguments: "{}" } },
            { function: { name: "read_file", arguments: '{"file_path":"/a"}' } },
          ],
        },
      ],
    });
    const parsed = JSON.parse(body) as {
      messages: Array<{ tool_calls?: Array<{ id?: string }> }>;
    };
    const ids = (parsed.messages[0]?.tool_calls ?? []).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("function.name 缺失时补上（含拍平在顶层的 name）", async () => {
    const { body } = await runCompat({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_a", type: "function", name: "ls", arguments: "{}" }],
        },
      ],
    });
    const parsed = JSON.parse(body) as {
      messages: Array<{ tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }>;
    };
    const call = parsed.messages[0]?.tool_calls?.[0];
    expect(call?.function?.name).toBe("ls");
    expect(call?.function?.arguments).toBe("{}");
  });

  it("function.arguments 缺失时补空对象字符串", async () => {
    const { body } = await runCompat({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_b", type: "function", function: { name: "ls" } }],
        },
      ],
    });
    const parsed = JSON.parse(body) as {
      messages: Array<{ tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }>;
    };
    expect(parsed.messages[0]?.tool_calls?.[0]?.function?.arguments).toBe("{}");
  });

  it("完全没有 function 对象时也能构造出合法 tool_call", async () => {
    const { body } = await runCompat({
      messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call_c", type: "function" }] }],
    });
    const parsed = JSON.parse(body) as {
      messages: Array<{ tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }>;
    };
    const call = parsed.messages[0]?.tool_calls?.[0];
    expect(typeof call?.function?.name).toBe("string");
    expect(typeof call?.function?.arguments).toBe("string");
  });

  it("没有 tool_calls 的请求原样放行", async () => {
    const original = { messages: [{ role: "user", content: "hi" }] };
    const { body } = await runCompat(original);
    expect(body).toBe(JSON.stringify(original));
  });

  it("user / tool 消息里的 tool_calls 字段不被误改", async () => {
    const original = {
      messages: [
        { role: "user", content: "hi", tool_calls: [{ foo: 1 }] },
        { role: "tool", content: "result", tool_call_id: "call_1" },
      ],
    };
    const { body } = await runCompat(original);
    expect(body).toBe(JSON.stringify(original));
  });

  it("没有 body 的请求直接放行（不进入补全逻辑）", async () => {
    const fakeFetch = vi.fn(async (_input?: unknown, _init?: unknown) => new Response("{}"));
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      await createToolCallCompatFetch()("https://example.invalid/v1/models", { method: "GET" });
    } finally {
      globalThis.fetch = original;
    }
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBeUndefined();
  });

  it("body 不是合法 JSON 时原样放行，不抛错", async () => {
    const fakeFetch = vi.fn(async (_input?: unknown, _init?: unknown) => new Response("{}"));
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      await createToolCallCompatFetch()("https://example.invalid/v1/x", {
        method: "POST",
        body: "not json",
      });
    } finally {
      globalThis.fetch = original;
    }
    const init = fakeFetch.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.body).toBe("not json");
  });
});

describe("createModel 推理强度映射", () => {
  const baseConfig: ProviderConfig = {
    id: "p1",
    type: "stepfun",
    label: "StepFun",
    baseUrl: "https://api.stepfun.com/step_plan/v1",
    apiKey: "sk-test",
    models: ["step-3.5-flash-2603"],
    defaultModel: "step-3.5-flash-2603",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it("两档模型上 medium 回落到 low", () => {
    const r = createModel(baseConfig, "medium", "step-3.5-flash-2603");
    expect(r.effort).toBe("low");
    expect(r.fallbackApplied).toBe(true);
    expect(r.supported).toEqual(["low", "high"]);
  });

  it("OpenAI 用 reasoning.effort，Anthropic 用 outputConfig.effort", () => {
    expect(createModel({ ...baseConfig, type: "openai" }, "medium", "gpt-5").appliedField).toBe(
      "reasoning.effort",
    );
    expect(
      createModel({ ...baseConfig, type: "anthropic" }, "medium", "claude-sonnet-4-5").appliedField,
    ).toBe("outputConfig.effort");
  });

  it("标记为不支持推理强度时不下发字段", () => {
    const r = createModel(
      { ...baseConfig, reasoning: { efforts: ["low", "medium", "high"], unsupported: true } },
      "medium",
      "step-3.5-flash-2603",
    );
    expect(r.appliedField).toBeNull();
    expect(r.reasoningUnsupported).toBe(true);
  });

  it("模型实例可用（invoke 存在）", () => {
    const r = createModel(baseConfig, "high", "step-3.5-flash-2603");
    expect(typeof r.model.invoke).toBe("function");
  });
});

describe("响应侧 tool_call name 反推", () => {
  /** 让 compat fetch 返回指定的响应体，返回被发出的响应文本。 */
  async function runResponse(requestTools: unknown[], responseBody: unknown): Promise<string> {
    const fakeFetch = vi.fn(async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const res = await createToolCallCompatFetch()("https://example.invalid/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", tools: requestTools, messages: [{ role: "user", content: "hi" }] }),
      });
      return await res.text();
    } finally {
      globalThis.fetch = original;
    }
  }

  const tools = [
    { type: "function", function: { name: "ls", parameters: {} } },
    { type: "function", function: { name: "read_file", parameters: {} } },
  ];

  it("响应里 name 为空串时按 index 反推补上", async () => {
    const text = await runResponse(tools, {
      choices: [{ message: { role: "assistant", content: "", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "", arguments: "{}" } }] } }],
    });
    const parsed = JSON.parse(text) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
    };
    expect(parsed.choices[0]?.message.tool_calls[0]?.function.name).toBe("ls");
  });

  it("第二个 tool_call 取第二个工具名", async () => {
    const text = await runResponse(tools, {
      choices: [{ message: { tool_calls: [{ index: 1, id: "c2", function: { name: "", arguments: "{}" } }] } }],
    });
    const parsed = JSON.parse(text) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
    };
    expect(parsed.choices[0]?.message.tool_calls[0]?.function.name).toBe("read_file");
  });

  it("name 已有值时不动", async () => {
    const original = {
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "ls", arguments: "{}" } }] } }],
    };
    const text = await runResponse(tools, original);
    expect(text).toBe(JSON.stringify(original));
  });

  it("没有 tool_calls 的响应原样返回", async () => {
    const original = { choices: [{ message: { role: "assistant", content: "你好" } }] };
    const text = await runResponse(tools, original);
    expect(text).toBe(JSON.stringify(original));
  });

  it("请求里没有 tools 时不碰响应", async () => {
    const original = { choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "", arguments: "{}" } }] } }] };
    const text = await runResponse([], original);
    expect(text).toBe(JSON.stringify(original));
  });

  it("index 超出工具列表范围时保持原样（不猜）", async () => {
    const original = {
      choices: [{ message: { tool_calls: [{ index: 9, id: "c1", function: { name: "", arguments: "{}" } }] } }],
    };
    const text = await runResponse(tools, original);
    const parsed = JSON.parse(text) as {
      choices: Array<{ message: { tool_calls: Array<{ function: { name: string } }> } }>;
    };
    expect(parsed.choices[0]?.message.tool_calls[0]?.function.name).toBe("");
  });

  it("响应不是合法 JSON 时原样返回，不抛错", async () => {
    const fakeFetch = vi.fn(async () => new Response("not json", { status: 200 }));
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as unknown as typeof fetch;
    try {
      const res = await createToolCallCompatFetch()("https://example.invalid/v1/x", {
        method: "POST",
        body: JSON.stringify({ tools, messages: [] }),
      });
      expect(await res.text()).toBe("not json");
    } finally {
      globalThis.fetch = original;
    }
  });
});
