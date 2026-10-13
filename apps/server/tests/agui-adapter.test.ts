/**
 * DeepAgent 流 → AG-UI 事件适配器的单元测试。
 *
 * 用假流对象驱动适配器，验证：
 * - 标准事件顺序（RUN_STARTED → TEXT_MESSAGE_* → RUN_FINISHED）
 * - Todo 卡片随状态更新同一张卡，不重复新增
 * - 工具调用开始/完成/失败三态
 * - 子 Agent 事件
 * - 人工审批中断
 * - 模型 reasoning 增量原样流式发出
 */

import { describe, expect, it } from "vitest";
import { EventType, type BaseEvent } from "@ag-ui/core";
import { DeepAgentToAguiAdapter, aguiMessagesToLangChain } from "../src/agent/agui-adapter.js";
import type { DeepAgentRunStream } from "deepagents";

/** 构造一个可驱动的假 DeepAgentRunStream。 */
function makeFakeRun(options: {
  messages?: Array<{
    text?: string[];
    outputText?: string;
    reasoning?: string[];
    reasoningGate?: Promise<void>;
    textGate?: Promise<void>;
  }>;
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
            async *[Symbol.asyncIterator]() {
              await message.reasoningGate;
              for (const reasoning of message.reasoning ?? []) {
                yield {
                  event: "content-block-delta",
                  index: 0,
                  delta: { type: "reasoning-delta", reasoning },
                };
              }
              for (const [index, text] of (message.text ?? []).entries()) {
                if (index === 1) await message.textGate;
                yield {
                  event: "content-block-delta",
                  index: 1,
                  delta: { type: "text-delta", text },
                };
              }
            },
            ...(message.outputText !== undefined
              ? { output: Promise.resolve({ content: message.outputText }) }
              : {}),
            reasoning: {
              async *[Symbol.asyncIterator]() {
                await message.reasoningGate;
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

function createHarness(
  runOptions: Parameters<typeof makeFakeRun>[0],
  resume?: Array<{ interruptId: string; status: "resolved"; payload?: unknown }>,
): Harness {
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
        ...(resume ? { resume } : {}),
      } as never,
      newId: () => `id-${(counter += 1)}`,
      now: () => 1000 + counter,
    },
    (event) => {
      events.push(event);
    },
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

    // 模型原始文本事件逐段透传，完整内容与原增量一致。
    const deltas = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("你好，世界");
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

  it("模型正文投影按到达顺序逐块发送，而不是等完整输出后一次发送", async () => {
    const harness = createHarness({
      messages: [{ text: ["正文第一段", "正文第二段"] }],
    });
    harness.adapter.start();
    await harness.adapter.consumeMessages(harness.run);

    const deltas = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltas).toEqual(["正文第一段", "正文第二段"]);
  });

  it("模型尚未结束生成时，正文首个原始增量已经发出", async () => {
    let releaseSecondDelta = (): void => {};
    const secondDeltaGate = new Promise<void>((resolve) => {
      releaseSecondDelta = resolve;
    });
    const harness = createHarness({
      messages: [{ text: ["先到的正文", "后到的正文"], textGate: secondDeltaGate }],
    });
    harness.adapter.start();
    const consuming = harness.adapter.consumeMessages(harness.run);

    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const deltasBeforeModelFinishes = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltasBeforeModelFinishes).toEqual(["先到的正文"]);

    releaseSecondDelta();
    await consuming;
    const deltasAfterModelFinishes = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltasAfterModelFinishes).toEqual(["先到的正文", "后到的正文"]);
  });

  it("推理流尚未结束时也立即发出正文增量", async () => {
    let finishReasoning = (): void => {};
    const reasoningGate = new Promise<void>((resolve) => {
      finishReasoning = resolve;
    });
    const harness = createHarness({
      messages: [{ text: ["正文第一段", "正文第二段"], reasoning: ["继续推理"], reasoningGate }],
    });
    harness.adapter.start();
    const consuming = harness.adapter.consumeMessages(harness.run);

    // 文本投影可在 reasoning 仍被 gate 阻塞时完成；给并发消费任务一个调度周期。
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const deltasBeforeReasoningEnds = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltasBeforeReasoningEnds).toEqual([]);

    finishReasoning();
    await consuming;
    const types = harness.events.map((event) => event.type);
    expect(types.indexOf(EventType.REASONING_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.TEXT_MESSAGE_START),
    );
    const deltasAfterReasoningEnds = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltasAfterReasoningEnds).toEqual(["正文第一段", "正文第二段"]);
  });

  it("审批恢复时仍把恢复后的模型正文发成 AG-UI 文本事件", async () => {
    const harness = createHarness(
      { messages: [{ text: ["审批后", "的总结正文"] }] },
      [{ interruptId: "interrupt-1", status: "resolved", payload: { type: "approve" } }],
    );
    harness.adapter.start();
    await harness.adapter.consumeMessages(harness.run);

    const deltas = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("审批后的总结正文");
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

  it("正常结束时将未完成的进行中待办收回为 pending", async () => {
    const harness = createHarness({
      values: [{ todos: [
        { content: "当前步骤", status: "in_progress" },
        { content: "后续步骤", status: "pending" },
      ] }],
    });
    await harness.adapter.consumeValues(harness.run);
    harness.adapter.finish();
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      status: string;
      detail: { items: Array<{ status: string }>; completed: number; total: number };
    }>;
    const todo = activities.filter((item) => item.id === "todo:main").at(-1);
    expect(todo?.status).toBe("pending");
    expect(todo?.detail.items.map((item) => item.status)).toEqual(["pending", "pending"]);
    expect(todo?.detail).toMatchObject({ completed: 0, total: 2 });
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
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      kind: string;
      detail: { toolName: string; args: Array<{ toolName: string }> };
    }>;
    const approvals = activities.filter((item) => item.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.id).toBe("approval:int-2");
    expect(approvals[0]?.detail.toolName).toBe("2 ???");
    expect(approvals[0]?.detail.args.map((item) => item.toolName)).toEqual([
      "write_file",
      "delete_file",
    ]);

    const snapshots = customValues(harness.events, "deepagent:run-snapshot") as Array<{
      interrupts: Array<{ id: string }>;
    }>;
    expect(snapshots.at(-1)?.interrupts).toHaveLength(1);
    expect(snapshots.at(-1)?.interrupts[0]?.id).toBe("int-2");
  });

  it("Inspect attachmentsInspect attachmentsInspect attachmentsInspect attachments", () => {
    const harness = createHarness({});
    harness.adapter.emitInterrupts([
      {
        interruptId: "int-a",
        payload: {
          actionRequests: [
            { name: "execute", args: { command: "ls" } },
            { name: "execute", args: { command: "find ." } },
          ],
        },
      },
      {
        interruptId: "int-b",
        payload: {
          actionRequests: [
            { name: "write_file", args: { file_path: "/a.txt" } },
            { name: "edit_file", args: { file_path: "/b.txt" } },
          ],
        },
      },
    ]);

    const snapshots = customValues(harness.events, "deepagent:run-snapshot") as Array<{
      interrupts: Array<{ id: string }>;
    }>;
    expect(snapshots.at(-1)?.interrupts.map((item) => item.id)).toEqual(["int-a", "int-b"]);
  });

  it("相同 interruptId 重复出现时只生成一项决策", () => {
    const harness = createHarness({});
    const duplicate = {
      interruptId: "duplicate-int",
      payload: {
        actionRequests: [{ name: "execute", args: { command: "pwd" } }],
      },
    };
    harness.adapter.emitInterrupts([duplicate, duplicate]);

    const snapshots = customValues(harness.events, "deepagent:run-snapshot") as Array<{
      interrupts: Array<{ id: string }>;
    }>;
    const activities = customValues(harness.events, "deepagent:activity") as Array<{
      id: string;
      kind: string;
    }>;
    expect(snapshots.at(-1)?.interrupts.map(({ id }) => id)).toEqual(["duplicate-int"]);
    expect(activities.filter(({ kind }) => kind === "approval").map(({ id }) => id)).toEqual([
      "approval:duplicate-int",
    ]);
  });
});

describe("适配器：模型 reasoning 内容保真", () => {
  it("reasoning 按模型原始增量逐块原样发出", async () => {
    const rawChunks = [
      "  Let me inspect the files.",
      " Let me inspect the files.",
      "\n原样保留标点和换行。  ",
    ];
    const harness = createHarness({
      messages: [{
        text: ["最终答复"],
        reasoning: rawChunks,
      }],
    });
    harness.adapter.start();
    await harness.adapter.consumeMessages(harness.run);
    harness.adapter.finish();
    const deltas = harness.events
      .filter((event) => event.type === EventType.REASONING_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltas).toEqual(rawChunks);
    expect(deltas.join("")).toBe(rawChunks.join(""));
  });

  it("有 reasoning 时运行快照标记模型推理状态", async () => {
    const harness = createHarness({
      messages: [{ text: ["答复"], reasoning: ["I should verify the result"] }],
    });
    await harness.adapter.consumeMessages(harness.run);
    const snapshots = customValues(harness.events, "deepagent:run-snapshot") as Array<{
      progressNote: string | null;
    }>;
    const notes = snapshots.map((item) => item.progressNote).filter(Boolean);
    expect(notes).toContain("模型推理中");
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

  it("AG-UI multimodal message conversion", () => {
    const result = aguiMessagesToLangChain([{
      id: "1",
      role: "user",
      content: [
        { type: "text", text: "Inspect attachments" },
        { type: "image", source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" }, metadata: { filename: "chart.png" } },
        { type: "document", source: { type: "data", value: "eyJvayI6dHJ1ZX0=", mimeType: "application/json" }, metadata: { filename: "data.json" } },
        { type: "document", source: { type: "data", value: "JVBERi0x", mimeType: "application/pdf" }, metadata: { filename: "report.pdf" } },
      ],
    }] as never);

    expect(result).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Inspect attachments" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png", metadata: { filename: "chart.png" } },
        { type: "text", text: "Attachment data.json:\n{\"ok\":true}" },
        { type: "file", data: "JVBERi0x", mimeType: "application/pdf", metadata: { filename: "report.pdf" } },
      ],
    }]);
  });

  it("OpenAI 兼容模型使用其原生图片输入格式", () => {
    const result = aguiMessagesToLangChain([{
      id: "1",
      role: "user",
      content: [
        { type: "text", text: "Read this image" },
        { type: "image", source: { type: "data", value: "aW1hZ2U=", mimeType: "image/png" } },
      ],
    }] as never, true);

    expect(result).toEqual([{
      role: "user",
      content: [
        { type: "text", text: "Read this image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,aW1hZ2U=" } },
      ],
    }]);
  });
});

describe("适配器兜底正文不模拟流式", () => {
  it("模型未提供正文流时以单个完整增量发送兜底正文", async () => {
    const fullText = "完整兜底正文不伪装成分词增量";
    const harness = createHarness({ messages: [{ outputText: fullText }] });
    harness.adapter.start();
    await harness.adapter.consumeMessages(harness.run);

    const deltas = harness.events
      .filter((event) => event.type === EventType.TEXT_MESSAGE_CONTENT)
      .map((event) => (event as unknown as { delta: string }).delta);
    expect(deltas).toEqual([fullText]);
  });
});
