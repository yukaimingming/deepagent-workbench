/**
 * Deep Agents 运行时 → AG-UI 事件的适配层。
 *
 * 为什么不直接转发 LangGraph 事件：
 * AG-UI 是前后端协议，不是「把 LangGraph 内部事件原样转发」的通道。
 * 这里显式定义映射规则，并把无法映射到标准事件的信息（Todo 卡片、
 * 工具调用卡片、子 Agent 卡片、运行快照）放进 `CUSTOM` 事件。
 *
 * 事件流骨架（标准事件）：
 *   RUN_STARTED
 *   TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT* / TEXT_MESSAGE_END   （最终答复）
 *   CUSTOM（deepagent:activity / deepagent:run-snapshot）*
 *   RUN_FINISHED（可能带 interrupt outcome）
 *   RUN_ERROR（失败时）
 *
 * 推理内容：`run.messages` 的 `.reasoning` 增量通过 AG-UI reasoning 事件
 * 原样流式发送，不改写、不去重、不补充文本。
 */

import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type ToolCall,
} from "@ag-ui/core";
import type { DeepAgentRunStream } from "deepagents";
import { Command } from "@langchain/langgraph";
import type { ContentBlock } from "@langchain/core/messages";
import type { Decision } from "langchain";
import {
  AGUI_CUSTOM_EVENT,
  computeFileDiff,
  resolveContextWindow,
  safeStringify,
  type Activity,
  type ApprovalDetail,
  type FileDetail,
  type RunSnapshot,
  type RunTokenUsage,
  type ToolDetail,
  type TodoDetail,
} from "@deepagent/shared";
import type { FileDiffRecorder } from "./create-agent.js";

/** 适配器依赖注入的运行上下文。 */
export interface AdapterContext {
  input: RunAgentInput;
  /** 产生事件 ID 的工厂。 */
  newId: () => string;
  /** 当前时间（毫秒）。 */
  now: () => number;
  /** 文件变更记录器：提供时为文件卡片附加前后内容 Diff。 */
  diffRecorder?: FileDiffRecorder;
}

/** 适配器输出：异步迭代 AG-UI 事件。 */
export type EventSink = (event: BaseEvent) => void;

/** 运行快照的最小发送间隔（毫秒）：模型思考期间 chunk 很密，节流省带宽。 */
const _SNAPSHOT_THROTTLE_MS = 800;

/** 把文件工具名映射为前端展示的操作类型。 */
const FILE_TOOLS: Record<string, "read" | "write" | "edit" | "delete" | "list" | "grep" | "glob"> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  delete_file: "delete",
  // deepagents 1.14 内置删除工具的实际名称是 `delete`（见 create-agent.ts 说明）。
  delete: "delete",
  ls: "list",
  glob: "glob",
  grep: "grep",
};

/**
 * DeepAgent 流 → AG-UI 事件的适配器。
 *
 * 用法：先 `adapter.start()`，再并发消费 `run.messages` / `run.toolCalls` /
 * `run.subagents` / `run.interrupts`，最后 `adapter.finish()`。
 */
export class DeepAgentToAguiAdapter {
  private readonly ctx: AdapterContext;
  private readonly sink: EventSink;
  private readonly activities = new Map<string, Activity>();
  private started = false;
  private finished = false;
  private readonly seenToolCalls = new Set<string>();
  /** 从状态快照识别到、等待工具结果的调用。 */
  private readonly pendingValueToolCalls = new Map<string, {
    name: string;
    input: unknown;
    startedAt: number;
    fileOperation?: (typeof FILE_TOOLS)[string];
  }>();
  private readonly seenSubagents = new Set<string>();
  /** 最近一次 emitInterrupts 记录的中断（供 RUN_FINISHED 的 interrupt outcome 使用）。 */
  private pendingInterrupts: Array<{ id: string; reason: string }> = [];
  /** resume 运行中最后一次平滑重播的文本（用于结束时对账补发缺失的总结）。 */
  private lastResumeText = "";
  /** 当前是否为审批续跑运行。 */
  private isResumeRun = false;
  /** 累计的 Token 用量（来自各轮模型消息的 usage_metadata）。 */
  private usage: RunTokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedInputTokens: 0,
    lastInputTokens: 0,
    contextWindow: null,
  };

  constructor(ctx: AdapterContext, sink: EventSink) {
    this.ctx = ctx;
    this.sink = sink;
    // 上下文窗口优先取请求里选中的模型；模型消息里的 model_name 可再补。
    const props = (ctx.input.forwardedProps ?? {}) as { modelId?: unknown };
    if (typeof props.modelId === "string") {
      this.usage.contextWindow = resolveContextWindow(props.modelId);
    }
    // 审批恢复是一次新的 AG-UI 请求；LangGraph 可能只重放中断后的状态，
    // 因此正文以流式投影和最终状态对账两种方式补齐。
    this.isResumeRun = (ctx.input.resume?.length ?? 0) > 0;

    // 预收集本轮执行前，历史消息中已经存在的所有 tool_call ID，
    // 彻底杜绝把历史轮次的工具调用重放到当前轮次！
    if (Array.isArray(ctx.input.messages)) {
      for (const m of ctx.input.messages) {
        const calls = (m as unknown as { tool_calls?: unknown[] }).tool_calls;
        if (Array.isArray(calls)) {
          for (const c of calls) {
            const cid = (c as { id?: string })?.id;
            if (cid) this.seenToolCalls.add(String(cid));
          }
        }
      }
    }
  }

  /** 发出 RUN_STARTED 与初始运行快照。重复调用无副作用。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.emit({
      type: EventType.RUN_STARTED,
      threadId: this.ctx.input.threadId,
      runId: this.ctx.input.runId,
      timestamp: this.ctx.now(),
    });
    this.emitSnapshot({ status: "running", runId: this.ctx.input.runId, threadId: this.ctx.input.threadId, interrupts: [], error: null, progressNote: "已启动" });
  }

  /**
   * 按 LangChain 原始模型事件的到达顺序适配 AG-UI。
   * 思考增量写入详细过程，正文增量直接写入回答区；模型提供的推理文本逐块原样转发。
   */
  async consumeMessages(run: DeepAgentRunStream): Promise<void> {
    for await (const message of run.messages) {
      let reasoningId: string | null = null;
      let textId: string | null = null;
      let reasoningOpen = false;
      let textStarted = false;
      let streamedText = '';

      const endReasoning = (): void => {
        if (!reasoningId || !reasoningOpen) return;
        this.emit({
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningId,
          timestamp: this.ctx.now(),
        });
        reasoningOpen = false;
      };

      const emitReasoning = (delta: string): void => {
        if (!delta) return;
        if (!reasoningOpen) {
          reasoningId = this.ctx.newId();
          reasoningOpen = true;
          this.emit({
            type: EventType.REASONING_MESSAGE_START,
            messageId: reasoningId,
            role: 'reasoning',
            timestamp: this.ctx.now(),
          });
          this.emitSnapshot({ status: 'running', progressNote: '模型推理中' });
        }
        this.emit({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: reasoningId,
          delta,
          timestamp: this.ctx.now(),
        });
      };

      const emitText = (delta: string): void => {
        if (!delta) return;
        endReasoning();
        if (!textStarted) {
          textStarted = true;
          textId = this.ctx.newId();
          this.emit({
            type: EventType.TEXT_MESSAGE_START,
            messageId: textId,
            role: 'assistant',
            timestamp: this.ctx.now(),
          });
        }
        streamedText += delta;
        this.emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: textId,
          delta,
          timestamp: this.ctx.now(),
        });
      };

      // ChatModelStream 可重放同一条有序事件流；消费原始事件才能保留
      // reasoning 与正文的相对顺序，避免并发读取两个投影后再缓冲重排。
      for await (const event of message) {
        const raw = event as unknown as {
          event: string;
          message?: string;
          delta?: { type?: string; text?: string; reasoning?: string };
          content?: { type?: string; text?: string; reasoning?: string; thinking?: string };
        };
        if (raw.event === 'error') throw new Error(raw.message || '模型流发生错误');
        if (raw.event !== 'content-block-delta') continue;

        if (raw.delta?.type === 'reasoning-delta' && typeof raw.delta.reasoning === 'string') {
          emitReasoning(raw.delta.reasoning);
        } else if (raw.delta?.type === 'text-delta' && typeof raw.delta.text === 'string') {
          emitText(raw.delta.text);
        } else if (!raw.delta && raw.content?.type === 'reasoning' && typeof raw.content.reasoning === 'string') {
          emitReasoning(raw.content.reasoning);
        } else if (!raw.delta && raw.content?.type === 'thinking' && typeof raw.content.thinking === 'string') {
          emitReasoning(raw.content.thinking);
        } else if (!raw.delta && raw.content?.type === 'text' && typeof raw.content.text === 'string') {
          emitText(raw.content.text);
        }
      }
      endReasoning();

      let fullMessageText = '';
      try {
        const maybePromise =
          typeof (message as { output?: PromiseLike<unknown> }).output !== 'undefined'
            ? (message as { output: PromiseLike<unknown> }).output
            : message;
        const aiMsg = (await Promise.resolve(maybePromise)) as {
          content?: unknown;
          usage_metadata?: {
            input_tokens?: number;
            output_tokens?: number;
            total_tokens?: number;
            input_token_details?: { cache_read?: number; cache_creation?: number };
          } | null;
          response_metadata?: { model_name?: string } | null;
        } | null;
        this.recordUsage(aiMsg);
        if (typeof aiMsg?.content === 'string') {
          fullMessageText = aiMsg.content;
        } else if (Array.isArray(aiMsg?.content)) {
          fullMessageText = (aiMsg.content as Array<{ text?: string }>)
            .map((content) => content.text || '')
            .join('');
        }
      } catch {
        // 无法取得最终消息时保留已实时发送的原始增量，不重播正文。
      }

      if (this.isResumeRun) this.lastResumeText = streamedText || fullMessageText;
      if (!textStarted && fullMessageText.trim()) {
        // 只有底层未给正文增量时才以完整消息兜底一次。
        emitText(fullMessageText);
        if (this.isResumeRun) this.lastResumeText = fullMessageText;
      }
      if (textId) {
        this.emit({
          type: EventType.TEXT_MESSAGE_END,
          messageId: textId,
          timestamp: this.ctx.now(),
        });
      }
    }
  }
  /** 消费工具调用流：映射为工具卡片与文件卡片。 */
  async consumeToolCalls(run: DeepAgentRunStream): Promise<void> {
    for await (const call of run.toolCalls) {
      const startedAt = this.startToolActivity(call.callId, call.name, call.input);
      if (startedAt === null) continue;

      const status = await call.status;
      const output = status === "error" ? undefined : await safeAwait(call.output);
      const error = status === "error" ? await safeAwait(call.error) : undefined;
      this.finishToolActivity(
        call.callId,
        call.name,
        call.input,
        startedAt,
        output,
        status === "error" ? "error" : "finished",
        error,
      );
    }
  }

  /** 消费子 Agent 流：映射为子 Agent 卡片（含其工具调用）。 */
  async consumeSubagents(run: DeepAgentRunStream): Promise<void> {
    for await (const sub of run.subagents) {
      const name = "name" in sub ? String(sub.name) : "subagent";
      const key = `${name}:${this.seenSubagents.size}`;
      if (this.seenSubagents.has(key)) continue;
      this.seenSubagents.add(key);

      const startedAt = this.ctx.now();
      this.upsertActivity({
        id: `subagent:${key}`,
        kind: "subagent",
        status: "running",
        title: `子 Agent · ${name}`,
        subtitle: "运行中",
        detail: { name },
        startedAt,
      });

      // 子 Agent 的工具调用单独成卡，标题带上前缀避免与主 Agent 混淆。
      for await (const subCall of sub.toolCalls) {
        const started = this.ctx.now();
        this.upsertActivity({
          id: `tool:${subCall.callId}`,
          kind: "tool",
          status: "running",
          title: `${name}/${subCall.name}`,
          subtitle: "执行中",
          detail: { toolName: subCall.name, input: subCall.input },
          startedAt: started,
        });
        const status = await subCall.status;
        this.upsertActivity({
          id: `tool:${subCall.callId}`,
          kind: "tool",
          status: status === "error" ? "failed" : "completed",
          title: `${name}/${subCall.name}`,
          subtitle: status === "error" ? "失败" : "完成",
          detail: { toolName: subCall.name, input: subCall.input },
          startedAt: started,
          endedAt: this.ctx.now(),
        });
      }

      // 子 Agent 结果摘要：拿不到就留空，不让它影响整张卡片。
      let resultSummary = "";
      try {
        const output = await sub.output;
        resultSummary = safeStringify(output).text.slice(0, 500);
      } catch {
        // 子 Agent 输出不可用时保持空摘要，卡片仍标记完成。
      }
      const endedAt = this.ctx.now();
      this.upsertActivity({
        id: `subagent:${key}`,
        kind: "subagent",
        status: "completed",
        title: `子 Agent · ${name}`,
        subtitle: "完成",
        detail: { name, ...(resultSummary ? { resultSummary } : {}) },
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
      });
    }
  }

  /** 消费状态流：把 `todos` 同步为 Todo 卡片。 */
  /**
   * 消费状态快照。
   *
   * 同时做两件事：
   * 1. 从 `values.todos` 同步 Todo 卡片。
   * 2. 从 `values.messages` 里的 tool_calls 生成工具/文件卡片。
   *
   * 为什么用状态快照而不是 `run.toolCalls` 投影：实测 DeepAgent v3 流里
   * `run.toolCalls` 在工具调用真实发生的情况下一次都没产出（加日志验证过），
   * 而 `run.values` 每个节点后都会推一次完整状态，从里面读 tool_calls
   * 稳定可靠。
   */
  async consumeValues(run: DeepAgentRunStream): Promise<void> {
    let lastTodoSignature = "";

    for await (const values of run.values) {
      if (process.env.DEEPAGENT_DEBUG_VALUES === "1") {
        const keys = values && typeof values === "object" ? Object.keys(values) : [];
        const msgs = Array.isArray((values as any)?.messages) ? (values as any).messages.length : -1;
        console.error("[values] keys=", JSON.stringify(keys), "messages=", msgs);
        const arr = (values as any)?.messages;
        if (Array.isArray(arr)) {
          for (const msg of arr) {
            const tc = msg?.tool_calls ?? msg?.additional_kwargs?.tool_calls;
            console.error("[values] msg role=", msg?.role ?? msg?._getType?.(), "tc=", JSON.stringify(tc)?.slice(0,200));
          }
        }
      }
      const stateMessages = extractStateMessages(values);
      for (const message of stateMessages) {
        for (const call of extractStateToolCalls(message)) {
          const startedAt = this.startToolActivity(call.id, call.name, call.input)
            ?? (this.activities.get(`tool:${call.id}`)?.status === "running"
              ? this.activities.get(`tool:${call.id}`)!.startedAt
              : null);
          if (startedAt === null) continue;
          this.pendingValueToolCalls.set(call.id, {
            name: call.name,
            input: call.input,
            startedAt,
            ...(FILE_TOOLS[call.name] ? { fileOperation: FILE_TOOLS[call.name] } : {}),
          });
        }
      }
      for (const message of stateMessages) {
        const result = extractStateToolResult(message);
        if (!result) continue;
        const pending = this.pendingValueToolCalls.get(result.callId);
        if (!pending) continue;
        this.pendingValueToolCalls.delete(result.callId);
        this.finishToolActivity(
          result.callId,
          pending.name,
          pending.input,
          pending.startedAt,
          result.output,
          result.status,
          result.error,
        );
      }

      const todos = extractTodos(values);
      if (todos) {
        const signature = JSON.stringify(todos);
        if (signature !== lastTodoSignature) {
          lastTodoSignature = signature;
          const completed = todos.filter((item) => item.status === "completed").length;
          this.upsertActivity({
            id: "todo:main",
            kind: "todo",
            status: completed === todos.length && todos.length > 0 ? "completed" : "running",
            title: "任务计划",
            subtitle: `${completed}/${todos.length} 已完成`,
            detail: { items: todos, completed, total: todos.length },
            startedAt: this.activityStartedAt("todo:main"),
          });
        }
      }

      // 状态快照提供工具调用的及时起始/结果状态；run.toolCalls 若也产出相同调用，
      // 会被 seenToolCalls 去重，不会重复创建卡片。
    }
  }

  /** 把人工审批中断转为审批卡片。 */
  emitInterrupts(interrupts: readonly { interruptId: string; payload: unknown }[]): void {
    const runInterrupts: RunSnapshot["interrupts"] = [];
    const seenInterruptIds = new Set<string>();
    for (const interrupt of interrupts) {
      // Deep Agents 的嵌套工具流可能重复带回相同 interrupt；一个中断只对应一组决策。
      if (seenInterruptIds.has(interrupt.interruptId)) continue;
      seenInterruptIds.add(interrupt.interruptId);
      const request = interrupt.payload as {
        actionRequests?: Array<{ name: string; args: Record<string, unknown>; description?: string }>;
        reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[]; argsSchema?: Record<string, unknown> }>;
      };
      const actions = request.actionRequests ?? [];
      if (actions.length === 0) continue;
      const actionReviews = actions.map((action, index) => ({
        action,
        review: request.reviewConfigs?.[index],
      }));
      const allowed = actionReviews.reduce<ApprovalDetail["allowedDecisions"]>(
        (shared, { review }) => {
          const decisions = (review?.allowedDecisions ?? ["approve", "reject"]).filter(
            (value): value is "approve" | "edit" | "reject" =>
              value === "approve" || value === "edit" || value === "reject",
          );
          return shared.filter((decision) => decisions.includes(decision));
        },
        ["approve", "reject"],
      );
      const toolName = actions.length === 1 ? actions[0]!.name : `${actions.length} ???`;
      const args = actions.length === 1
        ? actions[0]!.args
        : actions.map((action) => ({ toolName: action.name, args: action.args, description: action.description }));
      const impact = actionReviews
        .map(({ action }, index) => `${index + 1}. ${describeImpact(action.name, action.args)}`)
        .join("\n");
      const message = actionReviews
        .map(({ action }) => action.description ?? `?????? ${action.name}?`)
        .join("?");
      const allowedDecisions: ApprovalDetail["allowedDecisions"] =
        allowed.length > 0 ? allowed : ["approve", "reject"];

      // ?? LangGraph interrupt ??????????????????????????????
      this.upsertActivity({
        id: `approval:${interrupt.interruptId}`,
        kind: "approval",
        status: "waiting_approval",
        title: `?????${toolName}`,
        subtitle: message,
        detail: { toolName, args, impact, allowedDecisions } satisfies ApprovalDetail,
        startedAt: this.activityStartedAt(`approval:${interrupt.interruptId}`),
      });
      runInterrupts.push({
        id: interrupt.interruptId,
        reason: "tool_approval",
        message,
        toolName,
        args,
        allowedDecisions,
      });
    }
    this.pendingInterrupts = runInterrupts.map(({ id, reason }) => ({ id, reason }));
    this.emitSnapshot({
      status: "waiting_approval",
      interrupts: runInterrupts,
      progressNote: "等待人工审批",
      usage: this.usage,
    });
  }

  /** 发出错误事件并结束。 */
  fail(error: unknown): void {
    if (this.finished) return;
    this.finished = true;
    const message = error instanceof Error ? error.message : String(error);
    this.upsertActivity({
      id: `error:${this.ctx.newId()}`,
      kind: "error",
      status: "failed",
      title: "运行出错",
      subtitle: message,
      startedAt: this.ctx.now(),
      endedAt: this.ctx.now(),
      error: message,
    });
    // 错误快照同样先于终止事件发出。
    this.emitSnapshot({ status: "error", error: message, progressNote: null });
    this.emit({
      type: EventType.RUN_ERROR,
      message,
      timestamp: this.ctx.now(),
    });
  }

  /** 汇总一条模型消息的 Token 用量（缓存命中单独累计）。 */
  private recordUsage(
    aiMsg: {
      usage_metadata?: {
        input_tokens?: number;
        output_tokens?: number;
        total_tokens?: number;
        input_token_details?: { cache_read?: number; cache_creation?: number };
      } | null;
      response_metadata?: { model_name?: string } | null;
    } | null,
  ): void {
    const usage = aiMsg?.usage_metadata;
    if (!usage) return;
    const input = Math.max(0, usage.input_tokens ?? 0);
    const output = Math.max(0, usage.output_tokens ?? 0);
    this.usage.inputTokens += input;
    this.usage.outputTokens += output;
    this.usage.totalTokens += Math.max(0, usage.total_tokens ?? input + output);
    this.usage.cachedInputTokens += Math.max(0, usage.input_token_details?.cache_read ?? 0);
    // 最后一次模型调用的输入量最接近当前上下文占用。
    this.usage.lastInputTokens = input;
    if (!this.usage.contextWindow) {
      this.usage.contextWindow = resolveContextWindow(aiMsg?.response_metadata?.model_name);
    }
  }

  /**
   * resume 运行收尾对账：中断恢复重放不保证最后的总结文本通过流式事件
   * 完整发出（间歇性丢失）。这里用 LangGraph 最终状态里最后一条 AI 消息
   * 与已推送内容比对，缺失时平滑补发，确保总结正文一定渲染。
   */
  async reconcileResumeSummary(finalMessages: unknown): Promise<void> {
    if (!this.isResumeRun || this.finished) return;
    if (!Array.isArray(finalMessages) || finalMessages.length === 0) return;
    for (let i = finalMessages.length - 1; i >= 0; i--) {
      const msg = finalMessages[i] as {
        role?: string;
        getType?: () => string;
        content?: unknown;
        tool_calls?: unknown[];
        additional_kwargs?: { tool_calls?: unknown[] };
      } | null;
      const type = msg?.getType?.() ?? msg?.role;
      if (type !== "ai" && type !== "assistant") continue;
      // 跳过带工具调用的 AI 消息（它们不是总结文本）。
      if (
        (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) ||
        (Array.isArray(msg?.additional_kwargs?.tool_calls) && msg.additional_kwargs.tool_calls.length > 0)
      ) {
        continue;
      }
      let text = "";
      if (typeof msg?.content === "string") {
        text = msg.content;
      } else if (Array.isArray(msg?.content)) {
        text = (msg.content as Array<{ type?: string; text?: string }>)
          .filter((c) => !c.type || c.type === "text")
          .map((c) => c.text || "")
          .join("");
      }
      const trimmed = text.trim();
      if (!trimmed) return;
      if (trimmed === this.lastResumeText.trim()) return;
      // 恢复流没有提供可补齐的原始增量时，只发送一次完整状态文本，不模拟逐字流式。
      const textId = this.ctx.newId();
      this.emit({
        type: EventType.TEXT_MESSAGE_START,
        messageId: textId,
        role: "assistant",
        timestamp: this.ctx.now(),
      });
      this.emit({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: textId,
        delta: text,
        timestamp: this.ctx.now(),
      });
      this.emit({
        type: EventType.TEXT_MESSAGE_END,
        messageId: textId,
        timestamp: this.ctx.now(),
      });
      this.lastResumeText = text;
      return;
    }
  }

  /** 发出成功结束事件。 */
  finish(): void {
    if (this.finished) return;
    const todoActivity = this.activities.get("todo:main");
    if (todoActivity?.kind === "todo" && todoActivity.status === "running") {
      const detail = todoActivity.detail as TodoDetail;
      const items = detail.items.map((item) => ({
        ...item,
        status: item.status === "in_progress" ? "pending" as const : item.status,
      }));
      const completed = items.filter((item) => item.status === "completed").length;
      this.upsertActivity({
        ...todoActivity,
        status: completed === items.length && items.length > 0 ? "completed" : "pending",
        subtitle: `${completed}/${items.length} 已完成`,
        detail: { items, completed, total: items.length },
        endedAt: this.ctx.now(),
      });
    }
    // 最终快照必须先于 RUN_FINISHED：AG-UI 规定流在终止事件后即结束，
    // 之后的事件不会被消费。
    // 不设 progressNote：状态徽章已显示「已完成」，再写一遍会重复。
    this.emitSnapshot({ status: "completed", usage: this.usage });
    this.finished = true;
    this.emit({
      type: EventType.RUN_FINISHED,
      threadId: this.ctx.input.threadId,
      runId: this.ctx.input.runId,
      outcome: { type: "success" },
      timestamp: this.ctx.now(),
    });
  }

  /** 发出中断结束事件（等待审批）。 */
  finishWithInterrupt(): void {
    if (this.finished) return;
    this.finished = true;
    this.emit({
      type: EventType.RUN_FINISHED,
      threadId: this.ctx.input.threadId,
      runId: this.ctx.input.runId,
      outcome: {
        type: "interrupt",
        // pendingInterrupts 为空属防御分支（正常路径 emitInterrupts 总是先
        // 被调用）；兜底 ID 用 runId 派生保持确定性，便于问题排查。
        interrupts:
          this.pendingInterrupts.length > 0
            ? this.pendingInterrupts
            : [{ id: `interrupt:${this.ctx.input.runId}`, reason: "tool_approval" }],
      },
      timestamp: this.ctx.now(),
    });
  }

  /** 把用户决策转成 LangGraph 的 Command（用于恢复被中断的运行）。 */
  static decisionsToCommand(decisions: Decision[]): Command {
    return new Command({ resume: { decisions } });
  }

  // ---- 内部实现 ----

  private startToolActivity(callId: string, toolName: string, input: unknown): number | null {
    if (this.seenToolCalls.has(callId)) return null;
    this.seenToolCalls.add(callId);
    const startedAt = this.ctx.now();
    const fileOperation = FILE_TOOLS[toolName];
    if (fileOperation) {
      const path = describePath(input);
      this.upsertActivity({
        id: `file:${callId}`,
        kind: "file",
        status: "running",
        title: `${fileOperation} · ${toolName}`,
        subtitle: path,
        detail: { path, operation: fileOperation },
        startedAt,
      });
    }
    this.upsertActivity({
      id: `tool:${callId}`,
      kind: "tool",
      status: "running",
      title: toolName,
      subtitle: "执行中",
      detail: { toolName, input } satisfies ToolDetail,
      startedAt,
    });
    return startedAt;
  }

  private finishToolActivity(
    callId: string,
    toolName: string,
    input: unknown,
    startedAt: number,
    output: unknown,
    status: "finished" | "error",
    error?: string,
  ): void {
    const current = this.activities.get(`tool:${callId}`);
    if (current && current.status !== "running") return;
    const endedAt = this.ctx.now();
    const outputText = safeStringify(output);
    const activityStatus = status === "error" ? "failed" : "completed";
    this.upsertActivity({
      id: `tool:${callId}`,
      kind: "tool",
      status: activityStatus,
      title: toolName,
      subtitle: status === "error" ? "失败" : "完成",
      detail: {
        toolName,
        input,
        output: outputText.text,
        truncated: outputText.truncated,
      } satisfies ToolDetail,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      ...(error ? { error } : {}),
    });

    const fileOperation = FILE_TOOLS[toolName];
    if (!fileOperation) return;
    const path = describePath(input);
    const fileDetail: FileDetail = { path, operation: fileOperation };
    if (fileOperation === "write" || fileOperation === "edit" || fileOperation === "delete") {
      const change = this.ctx.diffRecorder?.take(fileOperation, path);
      if (change) fileDetail.diff = computeFileDiff(change.before, change.after);
    }
    this.upsertActivity({
      id: `file:${callId}`,
      kind: "file",
      status: activityStatus,
      title: `${fileOperation} · ${toolName}`,
      subtitle: path,
      detail: fileDetail,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      ...(error ? { error } : {}),
    });
  }

  private upsertActivity(activity: Activity): void {
    const existing = this.activities.get(activity.id);
    // 已存在的卡片保留最早的 startedAt，避免重复事件把开始时间顶掉。
    // runId 由适配器统一注入：前端靠它把工具卡片归属到正确的回复轮次。
    const stamped: Activity = {
      ...activity,
      runId: activity.runId ?? this.ctx.input.runId,
    };
    const merged: Activity = existing
      ? { ...existing, ...stamped, startedAt: existing.startedAt }
      : stamped;
    this.activities.set(activity.id, merged);
    this.emit({
      type: EventType.CUSTOM,
      name: AGUI_CUSTOM_EVENT.ACTIVITY_DELTA,
      value: merged,
      timestamp: this.ctx.now(),
    });
  }

  private activityStartedAt(id: string): number {
    return this.activities.get(id)?.startedAt ?? this.ctx.now();
  }

  private emitSnapshot(patch: Partial<RunSnapshot>): void {
    const snapshot: RunSnapshot = {
      status: patch.status ?? "running",
      runId: patch.runId ?? this.ctx.input.runId,
      threadId: patch.threadId ?? this.ctx.input.threadId,
      progressNote: patch.progressNote ?? null,
      interrupts: patch.interrupts ?? [],
      error: patch.error ?? null,
      ...(patch.usage ? { usage: patch.usage } : {}),
    };
    this.emit({
      type: EventType.CUSTOM,
      name: AGUI_CUSTOM_EVENT.RUN_SNAPSHOT,
      value: snapshot,
      timestamp: this.ctx.now(),
    });
  }

  private emit(event: BaseEvent): void {
    // RUN_STARTED / RUN_FINISHED 按标准事件字段携带 runId 和 threadId；
    // 其他事件把运行信息放进 CUSTOM.value，避免在标准事件上附加未知字段。
    this.sink(event);
  }
}

/** 从状态值中提取 todos 数组。 */
function extractTodos(values: unknown): Array<{ content: string; status: "pending" | "in_progress" | "completed" }> | null {
  if (!values || typeof values !== "object") return null;
  const todos = (values as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return null;
  const items = todos
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const record = raw as Record<string, unknown>;
      const content = typeof record.content === "string" ? record.content : "";
      const status = record.status;
      if (!content) return null;
      const normalized: "pending" | "in_progress" | "completed" =
        status === "in_progress" || status === "completed" ? status : "pending";
      return { content, status: normalized };
    })
    .filter((item): item is { content: string; status: "pending" | "in_progress" | "completed" } => item !== null);
  return items.length > 0 ? items : null;
}

function extractStateMessages(values: unknown): Array<Record<string, unknown>> {
  if (!values || typeof values !== "object") return [];
  const messages = (values as Record<string, unknown>).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is Record<string, unknown> => Boolean(message) && typeof message === "object",
  );
}

function extractStateToolCalls(message: Record<string, unknown>): Array<{
  id: string;
  name: string;
  input: unknown;
}> {
  const additional = message.additional_kwargs;
  const additionalCalls = additional && typeof additional === "object"
    ? (additional as Record<string, unknown>).tool_calls
    : undefined;
  const rawCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : Array.isArray(additionalCalls)
      ? additionalCalls
      : [];
  const calls: Array<{ id: string; name: string; input: unknown }> = [];
  for (const raw of rawCalls) {
    if (!raw || typeof raw !== "object") continue;
    const call = raw as Record<string, unknown>;
    const fn = call.function && typeof call.function === "object"
      ? call.function as Record<string, unknown>
      : undefined;
    const id = typeof call.id === "string" ? call.id : "";
    const name = typeof call.name === "string"
      ? call.name
      : typeof fn?.name === "string"
        ? fn.name
        : "";
    let input = call.args ?? call.input ?? fn?.arguments;
    if (typeof input === "string") {
      try {
        input = JSON.parse(input) as unknown;
      } catch {
        // 参数不是 JSON 时保留原始文本，工具调用活动仍可展示。
      }
    }
    if (id && name) calls.push({ id, name, input });
  }
  return calls;
}

function extractStateToolResult(message: Record<string, unknown>): {
  callId: string;
  output: unknown;
  status: "finished" | "error";
  error?: string;
} | null {
  const callId = typeof message.tool_call_id === "string"
    ? message.tool_call_id
    : typeof message.toolCallId === "string"
      ? message.toolCallId
      : "";
  if (!callId) return null;
  const status: "finished" | "error" = message.status === "error" || message.is_error === true
    ? "error"
    : "finished";
  const error = typeof message.error === "string" ? message.error : undefined;
  return {
    callId,
    output: message.content ?? message.output ?? message.artifact,
    status,
    ...(error ? { error } : {}),
  };
}

/** 截断文本到指定长度。 */
function _truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/** 从工具输入中提取路径类字段。 */
function describePath(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  for (const key of ["file_path", "path", "dir_path", "directory", "pattern"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** 说明一个高风险操作的影响范围（用于审批卡片）。 */
function describeImpact(toolName: string, args: Record<string, unknown>): string {
  const path = describePath(args);
  if (toolName === "execute") {
    const command = typeof args.command === "string" ? args.command : "";
    return `将在工作区内执行命令：${command.slice(0, 200)}`;
  }
  if (toolName === "delete_file") return `将删除工作区内的文件：${path}`;
  if (toolName === "write_file") return `将在工作区内创建或覆盖文件：${path}`;
  if (toolName === "edit_file") return `将修改工作区内的文件：${path}`;
  return path ? `目标：${path}` : "";
}

/** 安全 await：失败时返回 undefined，不让一个工具的报错中断整条流。 */
async function safeAwait<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch {
    return undefined;
  }
}

/** 把 AG-UI 消息数组转换为 LangChain 消息数组（供 Agent 输入）。 */
type OpenAiImageContentBlock = { type: "image_url"; image_url: { url: string } };

export function aguiMessagesToLangChain(
  messages: Message[],
  openAiCompatibleImages = false,
): Array<{ role: "user" | "assistant" | "system"; content: string | Array<ContentBlock | OpenAiImageContentBlock> }> {
  const out: Array<{ role: "user" | "assistant" | "system"; content: string | Array<ContentBlock | OpenAiImageContentBlock> }> = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    const content = typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.flatMap((part): Array<ContentBlock | OpenAiImageContentBlock> => {
          if (part.type === "text") return [{ type: "text", text: part.text }];
          if (part.type !== "image" && part.type !== "document") return [];
          const metadata = part.metadata && typeof part.metadata === "object"
            ? part.metadata as Record<string, unknown>
            : {};
          const filename = typeof metadata.filename === "string" ? metadata.filename : undefined;
          const mimeType = part.source.type === "data"
            ? part.source.mimeType
            : part.source.mimeType;
          if (part.type === "image") {
            if (openAiCompatibleImages) {
              if (part.source.type === "data") {
                return [{ type: "image_url", image_url: { url: `data:${part.source.mimeType};base64,${part.source.value}` } }];
              }
              if (part.source.type === "url") {
                return [{ type: "image_url", image_url: { url: part.source.value } }];
              }
            }
            if (part.source.type === "data") {
              return [{ type: "image", data: part.source.value, mimeType: part.source.mimeType, metadata: filename ? { filename } : undefined }];
            }
            if (part.source.type === "url") {
              return [{ type: "image", url: part.source.value, mimeType, metadata: filename ? { filename } : undefined }];
            }
            return [{ type: "image", fileId: part.source.value, mimeType, metadata: filename ? { filename } : undefined }];
          }
          const isText = mimeType?.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml";
          if (part.source.type === "data" && isText) {
            const text = Buffer.from(part.source.value, "base64").toString("utf8");
            return [{ type: "text", text: filename ? `Attachment ${filename}:\n${text}` : text }];
          }
          if (part.source.type === "data") {
            return [{ type: "file", data: part.source.value, mimeType: part.source.mimeType, metadata: filename ? { filename } : undefined }];
          }
          if (part.source.type === "url") {
            return [{ type: "file", url: part.source.value, mimeType, metadata: filename ? { filename } : undefined }];
          }
          return [{ type: "file", fileId: part.source.value, mimeType, metadata: filename ? { filename } : undefined }];
        })
        : "";
    if (message.role === "user" || message.role === "assistant" || message.role === "system") {
      out.push({ role: message.role, content });
    }
  }
  return out;
}

/** 从 AG-UI ToolCall 提取参数字符串（供审批编辑场景）。 */
export function toolCallSummary(call: ToolCall): string {
  const args = safeStringify(call.function.arguments);
  return args.text;
}
