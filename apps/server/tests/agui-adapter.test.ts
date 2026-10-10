/**
 * DeepAgent 流 → AG-UI 事件适配器的单元测试。
 *
 * 用假流对象驱动适配器，验证：
 * - 标准事件顺序（RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED）
 * - Todo 卡片随状态更新同一张卡，不重复新增
 * - 工具调用开始/完成/失败三态
 * - 子 Agent 事件
 * - 人工审批中断
 * - 原始思维链不外发
 */

import { describe, expect, it } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { DeepAgentToAguiAdapter, aguiMessagesToLangChain } from "../src/agent/agui-adapter.js";
import type { DeepAgentRunStream } from "deepagents";

/** 构造一个可驱动的假 DeepAgentRunStream。 */
function makeFakeRun(options: {
  messages?: Array<{ text: string[]; reasoning?: string[] }>;
  toolCalls?: Array<{
    callId: string;
    name: string;
    input: unknown;
    status: "running" | "finished" | "error";
    output?: unknown;
    error?: string;
  }>;
  subagents?: Array<{ name: string; toolCalls?: Array<{ callId: string; name: string; status: "finished" | "error" }>; output?: unknown }>;
  values?: Array<Record<string, unknown>>;
  interrupts?: Array<{ interruptId: string; payload: unknown }>;
}) {
  const messages = options.messages ?? [];
  const toolCalls = options.toolCalls ?? [];
  const subagents = options.subagents ?? [];
  const values = options.values ?? [];
  const interrupts = options.interrupts ?? [];

  const run = {
    messages: {
      async *[Symbol.asyncIterator]() {
        for (const message of messages) {
          yield {
            namespace: [],
            node: "model",
            text: {
              async *[Symbol.asyncIterator]() {
                for (const chunk of message.text) yield chunk;
              },
            },
            reasoning: {
              async *[Symbol.asyncIterator]() {
                for (const chunk of message.reasoning ?? []) yield chunk;
              },
            },
          };
        }
      },
    },
    toolCalls: {
      async *[Symbol.asyncIterator]() {
        for (const call of toolCalls) {
          let resolveStatus: (value: "running" | "finished" | "error") => void = () => {};
          let resolveOutput: (value: unknown) => void = () => {};
          let resolveError: (value: string | undefined) => void = () => {};
          const statusPromise = new Promise<"running" | "finished" | "error">((r) => {
            resolveStatus = r;
          });
          const outputPromise = new Promise<unknown>((r) => {
            resolveOutput = r;
          });
          const errorPromise = new Promise<string | undefined>((r) => {
            resolveError = r;
          });
          // 立即兑现，模拟工具调用同步完成。
          queueMicrotask(() => {
            resolveStatus(call.status);
            resolveOutput(call.output);
            resolveError(call.error);
          });
          yield {
            name: call.name,
            callId: call.callId,
            input: call.input,
            status: statusPromise,
            output: outputPromise,
            error: errorPromise,
          };
        }
      },
    },
    subagents: {
      async *[Symbol.asyncIterator]() {
        for (const sub of subagents) {
          yield {
            name: sub.name,
            cause: undefined,
            output: Promise.resolve(sub.output ?? {}),
            toolCalls: {
              async *[Symbol.asyncIterator]() {
                for (const call of sub.toolCalls ?? []) {
                  let resolveStatus: (value: "finished" | "error") => void = () => {};
                  const statusPromise = new Promise<"finished" | "error">((r) => {
                    resolveStatus = r;
                  });
                  queueMicrotask(() => resolveStatus(call.status));
                  yield {
                    name: call.name,
                    callId: call.callId,
                    input: {},
                    status: statusPromise,
                    output: Promise.resolve(undefined),
                    error: Promise.resolve(undefined),
                  };
                }
              },
            },
            subagents: {
              async *[Symbol.asyncIterator]() {
                // 无嵌套子 Agent
              },
            },
          };
        }
      },
    },
    values: {
      async *[Symbol.asyncIterator]() {
        for (const value of values) yield value;
      },
    },
    output: Promise.resolve({}),
    interrupted: interrupts.length > 0,
    interrupts,
  };

  return run as unknown as DeepAgentRunStream;
}

interface Harness {
  events: BaseEvent[];
  adapter: DeepAgentToAguiAdapter;
  run: DeepAgentRunStream;
  input: { threadId: string; runId: string };
}

function createHarness(runOptions: Parameters<typeof makeFakeRun>[0]): Harness {
  const events: BaseEvent[] = [];
  let counter = 0;
  const adapter = new DeepAgentToAguiAdapter(
    {
      input: {
        threadId: "thread-1",
        runId: "run-1",
        messages: [],
        tools: [],
        context: [],
      } as never,
      newId: () => `id-${(counter += 1)}`,
      now: () => 1000 + counter,
    },
    (event) => events.push(event),
  );
  const run = makeFakeRun(runOptions);
  return { events, adapter, run, input: { threadId: "thread-1", runId: "run-1" } };
}

/** 取出 CUSTOM 事件中指定名称的值。 */
function customValues(events: BaseEvent[], name: string): unknown[] {
  return events
    .filter((event) => event.type === EventType.CUSTOM && event.name === name)
    .map((event) => (event as unknown as { value: unknown }).value);
}

describe("适配器：标准事件顺序", () => {
  it("按 RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED 发出事件", async () => {
    const harness = createHarness({ messages: [{ text: ["你好", "，世界"] }] });
    harness.adapter.start();
    await harness.adapter.consumeMessages(harness.run);
    harness.adapter.finish();

    const types = harness.events.map((event) => event.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);

    const deltas = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltas).toEqual(["你好", "，世界"]);
  });

  it("没有文本时不发 TEXT_MESSAGE_* 事件", async () => {
    const harness = createHarness({ messages: [] });
    harness.adapter.start();
    await harness.adapter.consumeMessages(harness.run);
    harness.adapter.finish();
    const types = harness.events.map((event) => event.type);
    expect(types).not.toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.RUN_FINISHED);
  });

  it("RUN_FINISHED 带 threadId 与 runId", () => {
    const harness = createHarness({});
    harness.adapter.start();
    harness.adapter.finish();
    const finished = harness.events.find((event) => event.type === EventType.RUN_FINISHED) as unknown as {
      threadId: string;
      runId: string;
    };
    expect(finished.threadId).toBe("thread-1");
    expect(finished.runId).toBe("run-1");
  });

  it("错误时发 RUN_ERROR 且不发 RUN_FINISHED", () => {
    const harness = createHarness({});
    harness.adapter.start();
    harness.adapter.fail(new Error("模型调用失败"));
    const types = harness.events.map((event) => event.type);
    expect(types).toContain(EventType.RUN_ERROR);
    expect(types).not.toContain(EventType.RUN_FINISHED);
    const errorEvent = harness.events.find((event) => event.type === EventType.RUN_ERROR) as unknown as {
      message: string;
    };
    expect(errorEvent.message).toBe("模型调用失败");
  });
});

describe("适配器：Todo 卡片幂等更新", () => {
  it("相同 todos 只发一次卡片更新", async () => {
    const todos = [
      { content: "读取文件", status: "completed" },
      { content: "写报告", status: "pending" },
    ];
    const harness = createHarness({
      values: [{ todos }, { todos }, { todos }],
    });
    await harness.adapter.consumeValues(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      kind: string;
    }>;
    const todoCards = activities.filter((item) => item.id === "todo:main");
    expect(todoCards).toHaveLength(1);
    expect(todoCards[0]?.kind).toBe("todo");
  });

  it("todos 变化时更新同一张卡片而不是新增", async () => {
    const harness = createHarness({
      values: [
        { todos: [{ content: "第一步", status: "pending" }] },
        { todos: [{ content: "第一步", status: "completed" }] },
        { todos: [{ content: "第一步", status: "completed" }, { content: "第二步", status: "pending" }] },
      ],
    });
    await harness.adapter.consumeValues(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      detail: { completed: number; total: number };
    }>;
    const todoCards = activities.filter((item) => item.id === "todo:main");
    expect(todoCards).toHaveLength(3);
    expect(todoCards[0]?.detail).toMatchObject({ completed: 0, total: 1 });
    expect(todoCards[2]?.detail).toMatchObject({ completed: 1, total: 2 });
  });

  it("全部完成时卡片状态为 completed", async () => {
    const harness = createHarness({
      values: [{ todos: [{ content: "唯一任务", status: "completed" }] }],
    });
    await harness.adapter.consumeValues(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      status: string;
    }>;
    expect(activities[0]?.status).toBe("completed");
  });

  it("没有 todos 的状态不产生卡片", async () => {
    const harness = createHarness({ values: [{ files: {} }, { messages: [] }] });
    await harness.adapter.consumeValues(harness.run);
    expect(harness.events.filter((event) => event.type === EventType.CUSTOM)).toHaveLength(0);
  });
});

describe("适配器：工具调用卡片", () => {
  it("工具完成时状态为 completed 并带耗时", async () => {
    const harness = createHarness({
      toolCalls: [{ callId: "c1", name: "read_file", input: { file_path: "/a.txt" }, status: "finished", output: "内容" }],
    });
    await harness.adapter.consumeToolCalls(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      status: string;
      durationMs?: number;
      detail: { toolName: string; output: string };
    }>;
    const toolCards = activities.filter((item) => item.id === "tool:c1");
    expect(toolCards).toHaveLength(2); // running + completed
    expect(toolCards[0]?.status).toBe("running");
    expect(toolCards[1]?.status).toBe("completed");
    expect(toolCards[1]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(toolCards[1]?.detail.output).toContain("内容");
  });

  it("工具失败时状态为 failed 并带错误信息", async () => {
    const harness = createHarness({
      toolCalls: [{ callId: "c2", name: "write_file", input: {}, status: "error", error: "权限不足" }],
    });
    await harness.adapter.consumeToolCalls(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      status: string;
      error?: string;
    }>;
    const last = activities.filter((item) => item.id === "tool:c2").at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.error).toBe("权限不足");
  });

  it("同一 callId 的重复事件不产生重复卡片", async () => {
    const harness = createHarness({
      toolCalls: [{ callId: "c3", name: "ls", input: {}, status: "finished", output: "[]" }],
    });
    await harness.adapter.consumeToolCalls(harness.run);
    await harness.adapter.consumeToolCalls(harness.run); // 重放
    const activities = customValues(harness.events, "deepagent:activity") as Array<{ id: string }>;
    expect(activities.filter((item) => item.id === "tool:c3")).toHaveLength(2);
  });

  it("文件工具额外生成文件活动卡片", async () => {
    const harness = createHarness({
      toolCalls: [{ callId: "c4", name: "write_file", input: { file_path: "/notes.md" }, status: "finished", output: "ok" }],
    });
    await harness.adapter.consumeToolCalls(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      kind: string;
      detail: { operation: string; path: string };
    }>;
    const fileCards = activities.filter((item) => item.id === "file:c4");
    expect(fileCards).toHaveLength(2);
    expect(fileCards[0]?.kind).toBe("file");
    expect(fileCards[0]?.detail.operation).toBe("write");
    expect(fileCards[0]?.detail.path).toBe("/notes.md");
  });

  it("大输出被截断", async () => {
    const harness = createHarness({
      toolCalls: [{ callId: "c5", name: "task", input: {}, status: "finished", output: "x".repeat(9000) }],
    });
    await harness.adapter.consumeToolCalls(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      detail: { truncated?: boolean; output: string };
    }>;
    const toolCards = activities.filter((item) => item.id === "tool:c5");
    expect(toolCards.at(-1)?.detail.truncated).toBe(true);
    expect(toolCards.at(-1)?.detail.output.length).toBeLessThan(9000);
  });
});

describe("适配器：子 Agent 卡片", () => {
  it("子 Agent 完成时生成一张卡片并带结果摘要", async () => {
    const harness = createHarness({
      subagents: [{ name: "researcher", output: { text: "研究完成" } }],
    });
    await harness.adapter.consumeSubagents(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      kind: string;
      status: string;
      detail: { name: string; resultSummary?: string };
    }>;
    const subCards = activities.filter((item) => item.kind === "subagent");
    expect(subCards).toHaveLength(2); // running + completed
    expect(subCards[0]?.detail.name).toBe("researcher");
    expect(subCards[1]?.status).toBe("completed");
    expect(subCards[1]?.detail.resultSummary).toContain("研究完成");
  });

  it("子 Agent 的工具调用以前缀命名避免混淆", async () => {
    const harness = createHarness({
      subagents: [{ name: "file-worker", toolCalls: [{ callId: "s1", name: "read_file", status: "finished" }] }],
    });
    await harness.adapter.consumeSubagents(harness.run);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      title: string;
    }>;
    const subTool = activities.find((item) => item.id === "tool:s1");
    expect(subTool?.title).toBe("file-worker/read_file");
  });
});

describe("适配器：人工审批", () => {
  it("中断转为审批卡片与 waiting_approval 快照", () => {
    const harness = createHarness({});
    harness.adapter.emitInterrupts([
      {
        interruptId: "int-1",
        payload: {
          actionRequests: [{ name: "write_file", args: { file_path: "/secret.txt" } }],
          reviewConfigs: [{ actionName: "write_file", allowedDecisions: ["approve", "reject"] }],
        },
      },
    ]);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      kind: string;
      status: string;
      detail: { toolName: string; allowedDecisions: string[]; impact?: string };
    }>;
    const approval = activities.find((item) => item.kind === "approval");
    expect(approval?.status).toBe("waiting_approval");
    expect(approval?.detail.toolName).toBe("write_file");
    expect(approval?.detail.allowedDecisions).toEqual(["approve", "reject"]);
    expect(approval?.detail.impact).toContain("/secret.txt");

    const snapshots = customValues(harness.events, "deepagent:run-snapshot") as Array<{
      status: string;
      interrupts: unknown[];
    }>;
    expect(snapshots.at(-1)?.status).toBe("waiting_approval");
    expect(snapshots.at(-1)?.interrupts).toHaveLength(1);
  });

  it("多个待审批动作各自生成卡片", () => {
    const harness = createHarness({});
    harness.adapter.emitInterrupts([
      {
        interruptId: "int-2",
        payload: {
          actionRequests: [
            { name: "write_file", args: { file_path: "/a.txt" } },
            { name: "delete_file", args: { file_path: "/b.txt" } },
          ],
          reviewConfigs: [
            { actionName: "write_file", allowedDecisions: ["approve", "reject"] },
            { actionName: "delete_file", allowedDecisions: ["approve", "reject"] },
          ],
        },
      },
    ]);
    const activities = customValues(harness.events, "deepagent:activity") as Array<{ kind: string }>;
    expect(activities.filter((item) => item.kind === "approval")).toHaveLength(2);
  });
});

describe("适配器：思维链不外发", () => {
  it("reasoning 原文不出现在任何事件里", async () => {
    const harness = createHarness({
      messages: [{ text: ["最终答复"], reasoning: ["这是隐藏的思维链内容 SECRET"] }],
    });
    harness.adapter.start();
    await harness.adapter.consumeMessages(harness.run);
    harness.adapter.finish();
    const serialized = JSON.stringify(harness.events);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("隐藏的思维链");
  });

  it("有 reasoning 时进度摘要只说正在整理思路", async () => {
    const harness = createHarness({
      messages: [{ text: ["答复"], reasoning: ["一些内部推理"] }],
    });
    await harness.adapter.consumeMessages(harness.run);
    const snapshots = customValues(harness.events, "deepagent:run-snapshot") as Array<{
      progressNote: string | null;
    }>;
    const notes = snapshots.map((item) => item.progressNote).filter(Boolean);
    expect(notes).toContain("正在整理思路");
  });
});

describe("AG-UI 消息转换", () => {
  it("保留 user / assistant / system，跳过 tool 消息", () => {
    const result = aguiMessagesToLangChain([
      { id: "1", role: "user", content: "问题" },
      { id: "2", role: "assistant", content: "回答" },
      { id: "3", role: "tool", content: "工具结果", toolCallId: "t1" },
      { id: "4", role: "system", content: "系统" },
    ] as never);
    expect(result).toEqual([
      { role: "user", content: "问题" },
      { role: "assistant", content: "回答" },
      { role: "system", content: "系统" },
    ]);
  });

  it("content 非字符串时降级为空串", () => {
    const result = aguiMessagesToLangChain([{ id: "1", role: "user", content: undefined }] as never);
    expect(result).toEqual([{ role: "user", content: "" }]);
  });
});
