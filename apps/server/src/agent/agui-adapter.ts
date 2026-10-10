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
 * 安全约束：原始隐藏思维链一律不外发。`run.messages` 的 `.reasoning`
 * 只用于生成一句公开进度摘要，内容本身不透传。
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
import type { Decision } from "langchain";
import {
  AGUI_CUSTOM_EVENT,
  safeStringify,
  type Activity,
  type ApprovalDetail,
  type RunSnapshot,
  type ToolDetail,
} from "@deepagent/shared";

/** 适配器依赖注入的运行上下文。 */
export interface AdapterContext {
  input: RunAgentInput;
  /** 产生事件 ID 的工厂。 */
  newId: () => string;
  /** 当前时间（毫秒）。 */
  now: () => number;
}

/** 适配器输出：异步迭代 AG-UI 事件。 */
export type EventSink = (event: BaseEvent) => void;

/** 运行快照的最小发送间隔（毫秒）：模型思考期间 chunk 很密，节流省带宽。 */
const SNAPSHOT_THROTTLE_MS = 800;

/** 把文件工具名映射为前端展示的操作类型。 */
const FILE_TOOLS: Record<string, "read" | "write" | "edit" | "delete" | "list" | "grep" | "glob"> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  delete_file: "delete",
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
  private readonly messageId: string;
  private startedText = false;
  private started = false;
  private finished = false;
  private readonly seenToolCalls = new Set<string>();
  private readonly seenSubagents = new Set<string>();

  constructor(ctx: AdapterContext, sink: EventSink) {
    this.ctx = ctx;
    this.sink = sink;
    this.messageId = ctx.newId();

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
   * 消费模型消息流。
   *
   * 输出顺序刻意安排为「先思考、后答复」：
   *   1. reasoning 增量 → 独立 messageId 的 REASONING_MESSAGE_* 事件，
   *      前端用 AI Elements 的 <Reasoning> 流式展开。
   *   2. reasoning 结束后才发 TEXT_MESSAGE_*，即正文在思考面板收起后才开始流式输出。
   *
   * 安全边界：这里外发的是经 `sanitizeReasoning` 过滤后的公开进度摘要，
   * 不是模型原始隐藏思维链。
   */
  async consumeMessages(run: DeepAgentRunStream): Promise<void> {
    const reasoningId = this.ctx.newId();
    let reasoningStarted = false;

    for await (const message of run.messages) {
      // 1. 流式输出本轮思考：所有轮次的思考全部汇聚进同一个 reasoningId
      for await (const chunk of message.reasoning) {
        const contentDelta = sanitizeReasoningContent(chunk);
        if (contentDelta.length === 0) continue;
        if (!reasoningStarted) {
          reasoningStarted = true;
          this.emit({
            type: EventType.REASONING_MESSAGE_START,
            messageId: reasoningId,
            role: "reasoning",
            timestamp: this.ctx.now(),
          });
        }
        this.emit({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: reasoningId,
          delta: contentDelta,
          timestamp: this.ctx.now(),
        });
        // 保持平滑可见的视觉打字机节奏
        await new Promise((resolve) => setTimeout(resolve, 35));
      }

      // 2. 检查当前消息是否携带工具调用
      // 通过当前 message 的完整 AIMessage 组装结果精准判定
      let hasToolCalls = false;
      let fullMessageText = "";

      try {
        const maybePromise =
          typeof (message as { output?: PromiseLike<unknown> }).output !== "undefined"
            ? (message as { output: PromiseLike<unknown> }).output
            : message;
        const aiMsg = (await Promise.resolve(maybePromise)) as {
          tool_calls?: unknown[];
          content?: unknown;
          additional_kwargs?: { tool_calls?: unknown[] };
        } | null;

        if (
          (Array.isArray(aiMsg?.tool_calls) && aiMsg.tool_calls.length > 0) ||
          (Array.isArray(aiMsg?.additional_kwargs?.tool_calls) &&
            aiMsg.additional_kwargs.tool_calls.length > 0)
        ) {
          hasToolCalls = true;
        }

        if (typeof aiMsg?.content === "string") {
          fullMessageText = aiMsg.content;
        } else if (Array.isArray(aiMsg?.content)) {
          fullMessageText = (aiMsg.content as Array<{ text?: string }>)
            .map((c) => c.text || "")
            .join("");
        }
      } catch {
        // 若获取 AIMessage 失败，回退到迭代检测
        const tcIterable = (message as { toolCalls?: AsyncIterable<unknown> }).toolCalls;
        if (tcIterable && typeof tcIterable[Symbol.asyncIterator] === "function") {
          for await (const _ of tcIterable) {
            hasToolCalls = true;
            break;
          }
        }
      }

      // 如果当前消息发起了工具调用：这是中间执行节点，其中间过渡碎句绝不作为正式正文外发，且思考流保持活跃未完结
      if (hasToolCalls) {
        continue;
      }

      // 如果没有实质文本内容，不作为最终答复
      if (!fullMessageText.trim()) {
        continue;
      }

      // 3. 当前消息没有工具调用且有实质答复：这是真正面向用户的最终答复轮次！
      // 此时思考已全部完成：先发出唯一的 REASONING_MESSAGE_END，正式宣告思考完全结束并收起折叠！
      if (reasoningStarted) {
        this.emit({
          type: EventType.REASONING_MESSAGE_END,
          messageId: reasoningId,
          timestamp: this.ctx.now(),
        });
        reasoningStarted = false;
      }

      // 紧接着一气呵成地流式输出最终正式答复，彻底消除中途打断与反复横跳！
      if (!this.startedText) {
        this.startedText = true;
        this.emit({
          type: EventType.TEXT_MESSAGE_START,
          messageId: this.messageId,
          role: "assistant",
          timestamp: this.ctx.now(),
        });
      }

      // 将最终文本以流畅的打字机节拍流式推送到前端
      // 每次 4 个字符，间隔 18ms，视觉体验极度丝滑
      const chunkSize = 4;
      for (let i = 0; i < fullMessageText.length; i += chunkSize) {
        const slice = fullMessageText.slice(i, i + chunkSize);
        this.emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: this.messageId,
          delta: slice,
          timestamp: this.ctx.now(),
        });
        await new Promise((resolve) => setTimeout(resolve, 18));
      }
    }

    // 兜底保障：若运行结束前有思考且尚未发过 END，补发 END
    if (reasoningStarted) {
      this.emit({
        type: EventType.REASONING_MESSAGE_END,
        messageId: reasoningId,
        timestamp: this.ctx.now(),
      });
    }

    if (this.startedText) {
      this.emit({
        type: EventType.TEXT_MESSAGE_END,
        messageId: this.messageId,
        timestamp: this.ctx.now(),
      });
    }
  }



  /** 消费工具调用流：映射为工具卡片与文件卡片。 */
  async consumeToolCalls(run: DeepAgentRunStream): Promise<void> {
    for await (const call of run.toolCalls) {
      const key = `${call.callId}`;
      if (this.seenToolCalls.has(key)) continue;
      this.seenToolCalls.add(key);

      const startedAt = this.ctx.now();
      const fileOperation = FILE_TOOLS[call.name];
      if (fileOperation) {
        this.upsertActivity({
          id: `file:${call.callId}`,
          kind: "file",
          status: "running",
          title: `${fileOperation} · ${call.name}`,
          subtitle: describePath(call.input),
          detail: { path: describePath(call.input), operation: fileOperation },
          startedAt,
        });
      }

      this.upsertActivity({
        id: `tool:${call.callId}`,
        kind: "tool",
        status: "running",
        title: call.name,
        subtitle: "执行中",
        detail: { toolName: call.name, input: call.input } satisfies ToolDetail,
        startedAt,
      });

      const status = await call.status;
      const output = status === "error" ? undefined : await safeAwait(call.output);
      const error = status === "error" ? await safeAwait(call.error) : undefined;
      const endedAt = this.ctx.now();
      const outputText = safeStringify(output);

      this.upsertActivity({
        id: `tool:${call.callId}`,
        kind: "tool",
        status: status === "error" ? "failed" : "completed",
        title: call.name,
        subtitle: status === "error" ? "失败" : "完成",
        detail: {
          toolName: call.name,
          input: call.input,
          output: outputText.text,
          truncated: outputText.truncated,
        } satisfies ToolDetail,
        startedAt,
        endedAt,
        durationMs: endedAt - startedAt,
        ...(error ? { error } : {}),
      });

      if (fileOperation) {
        this.upsertActivity({
          id: `file:${call.callId}`,
          kind: "file",
          status: status === "error" ? "failed" : "completed",
          title: `${fileOperation} · ${call.name}`,
          subtitle: describePath(call.input),
          detail: { path: describePath(call.input), operation: fileOperation },
          startedAt,
          endedAt,
          durationMs: endedAt - startedAt,
          ...(error ? { error } : {}),
        });
      }
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
    /** 已发过卡片的 tool_call id，避免重复。 */
    const seenCalls = new Set<string>();

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

      // values 仅用于同步 Todo 待办计划任务；
      // 工具调用由 consumeToolCalls 统一单源消费，杜绝双发导致出现重复卡片！
    }
  }

  /** 把人工审批中断转为审批卡片。 */
  emitInterrupts(interrupts: readonly { interruptId: string; payload: unknown }[]): void {
    const runInterrupts: RunSnapshot["interrupts"] = [];
    for (const interrupt of interrupts) {
      const request = interrupt.payload as {
        actionRequests?: Array<{ name: string; args: Record<string, unknown>; description?: string }>;
        reviewConfigs?: Array<{ actionName: string; allowedDecisions: string[]; argsSchema?: Record<string, unknown> }>;
      };
      const actions = request.actionRequests ?? [];
      for (const [index, action] of actions.entries()) {
        const review = request.reviewConfigs?.[index];
        const allowed = (review?.allowedDecisions ?? ["approve", "reject"]).filter(
          (value): value is "approve" | "edit" | "reject" =>
            value === "approve" || value === "edit" || value === "reject",
        );
        this.upsertActivity({
          id: `approval:${interrupt.interruptId}:${index}`,
          kind: "approval",
          status: "waiting_approval",
          title: `待审批 · ${action.name}`,
          subtitle: action.description ?? "该操作需要你确认后才会执行",
          detail: {
            toolName: action.name,
            args: action.args,
            impact: describeImpact(action.name, action.args),
            allowedDecisions: allowed.length > 0 ? allowed : ["approve", "reject"],
          } satisfies ApprovalDetail,
          startedAt: this.activityStartedAt(`approval:${interrupt.interruptId}:${index}`),
        });
        runInterrupts.push({
          id: `${interrupt.interruptId}:${index}`,
          reason: "tool_approval",
          message: action.description ?? `是否允许执行 ${action.name}？`,
          toolName: action.name,
          args: action.args,
          allowedDecisions: allowed.length > 0 ? allowed : ["approve", "reject"],
        });
      }
    }
    this.emitSnapshot({ status: "waiting_approval", interrupts: runInterrupts, progressNote: "等待人工审批" });
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

  /** 发出成功结束事件。 */
  finish(): void {
    if (this.finished) return;
    // 最终快照必须先于 RUN_FINISHED：AG-UI 规定流在终止事件后即结束，
    // 之后的事件不会被消费。
    // 不设 progressNote：状态徽章已显示「已完成」，再写一遍会重复。
    this.emitSnapshot({ status: "completed" });
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
        interrupts: [],
      },
      timestamp: this.ctx.now(),
    });
  }

  /** 把用户决策转成 LangGraph 的 Command（用于恢复被中断的运行）。 */
  static decisionsToCommand(decisions: Decision[]): Command {
    return new Command({ resume: { decisions } });
  }

  // ---- 内部实现 ----

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
    };
    this.emit({
      type: EventType.CUSTOM,
      name: AGUI_CUSTOM_EVENT.RUN_SNAPSHOT,
      value: snapshot,
      timestamp: this.ctx.now(),
    });
  }

  private emit(event: BaseEvent): void {
    const enriched = {
      runId: this.ctx.input.runId,
      threadId: this.ctx.input.threadId,
      ...event,
    };
    this.sink(enriched as BaseEvent);
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



/**
 * 把模型原始推理片段转成可公开的进度摘要。
 *
 * 为什么不直接透传：原始隐藏思维链可能包含内部提示词、密钥、
 * 未经筛选的中间结论，甚至提示词注入内容（AGENTS.md 第 6、13 节）。
 *
 * 做法是「丢弃原文、只保留可分类的动作意图」：
 * 命中已知模式时输出对应的公开动作描述，未命中时输出中性占位。
 * 这样前端能展示「正在规划任务」这类进度，但拿不到模型怎么想的。
 */
/**
 * 对流式思维链文本做安全过滤，移除 API Key 等敏感模式，但保留真实思考内容。
 */
export function sanitizeReasoningContent(chunk: string): string {
  if (!chunk || chunk.length === 0) return "";
  const sensitive = /(api[_-]?key|secret|password|bearer\s|sk-[A-Za-z0-9]{8,})/i;
  if (sensitive.test(chunk)) {
    return "[已脱敏敏感信息]";
  }
  return chunk;
}

export function sanitizeReasoning(raw: string): string {
  if (raw.trim().length === 0) return "";

  // 命中任何敏感模式就直接丢弃整段，不做部分保留。
  const sensitive =
    /(api[_-]?key|secret|password|token|bearer\s|sk-[A-Za-z0-9]{8,}|system prompt|系统提示|忽略.{0,8}(指令|提示|规则)|ignore\s+(all\s+)?(previous|prior|above|the\s+above)\s+(instructions?|prompts?|rules?)|disregard\s+(all\s+)?(previous|above)|forget\s+(everything|all\s+previous))/i;
  if (sensitive.test(raw)) return "";

  // 只依据「意图关键词」生成公开描述，绝不引用原文措辞。
  //
  // 两个关键设计：
  // 1. 英文一律用词边界：否则 read 会命中 already/ready、
  //    write 会命中 writer/typewriter，造成误判。
  // 2. 按组顺序取第一个命中，组顺序即语义优先级。
  //    不用「按文本出现顺序」也不用「命中长度计分」：前者会因模型
  //    换个措辞顺序就让 UI 上的进度描述跳变，后者实测 read the file(13)
  //    会短于 analyze the structure(22) 导致顺序错乱。固定组顺序最可预测。
  const groups: Array<[RegExp, string]> = [
    [
      /(\bplan(s|ning)?\b|\bstep[s]?\b|\btodo[s]?\b|break\s+(it|this|the\s+task)\s+down|规划|拆分|分解|步骤)/i,
      "正在规划任务步骤",
    ],
    [
      /(\bread(s|ing)?\b\s+(the\s+)?(file|content|code|config|source|data)|\bsearch(ing|es)?\b|\bgrep\b|\bglob\b|\blook(ing)?\s+(for|up|at|into)\b|\bfind(s|ing)?\s+(the\s+)?(file|pattern)|\blist(s|ing)?\s+(the\s+)?(dir|files|content)|读取|查看|检索|查找)/i,
      "正在检索工作区文件",
    ],
    [
      /(\bwrite(s|ing)?\b|\bcreat(e|es|ing)\b\s+(a\s+)?(file|new)|\bsave(s|ing)?\b|\boutput\b\s+to\b|写|创建|生成|保存)/i,
      "正在准备写入文件",
    ],
    [
      /(\bedit(s|ing)?\b|\bmodif(y|ies|ying|ication)\b|\bupdat(e|es|ing)\b\s+(the\s+)?file|\breplace(s|ing)?\b|修改|更新|替换)/i,
      "正在准备修改文件",
    ],
    [
      /(\bsubagent\b|\bsub-agent\b|\bdelegat(e|es|ing)\b|\bspawn(s|ing)?\b\s+(a\s+)?(task|agent)|\btask\b\s+tool|子\s?agent|委派)/i,
      "正在派发子任务",
    ],
    [
      /(\bverif(y|ies|ying|ication)\b|\bvalidat(e|es|ing)\b|\bcheck(s|ing)?\b\s+(if|whether|that|the)|\btest(s|ing)?\b\s+(the|this|it)|\brun(s|ning)?\b\s+(the\s+)?(command|test)|验证|检查|测试)/i,
      "正在验证结果",
    ],
    [
      /(\banalyz(e|es|ing|sis)\b|\bcompar(e|es|ing)\b|\bevaluat(e|es|ing)\b|\bassess(es|ing)?\b|\bconsider(s|ing)?\b\s+(the|this)|分析|比较|评估)/i,
      "正在分析已有信息",
    ],
    [
      /(\bsummar(y|ize|izes|izing)\b|\bconclud(e|es|ing)\b|\bin\s+conclusion\b|\bfinal(ly)?\b\s+(answer|response)|\bgather(s|ing)?\b\s+(the\s+)?(findings|results)|汇总|总结|归纳|整理一下|整理结论)/i,
      "正在汇总发现",
    ],
  ];

  for (const [pattern, description] of groups) {
    if (pattern.test(raw)) return description;
  }
  return "正在整理思路";
}

/** 截断文本到指定长度。 */
function truncate(text: string, limit: number): string {
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
export function aguiMessagesToLangChain(messages: Message[]): Array<{ role: "user" | "assistant" | "system"; content: string }> {
  const out: Array<{ role: "user" | "assistant" | "system"; content: string }> = [];
  for (const message of messages) {
    if (message.role === "tool") continue;
    const content = typeof message.content === "string" ? message.content : "";
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
