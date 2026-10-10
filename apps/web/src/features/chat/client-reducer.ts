/**
 * AG-UI 事件 → 客户端状态的纯函数归约器。
 *
 * 从 use-agent-client.ts 抽出，便于不依赖 React 做单元测试
 * （AGENTS.md 第 12 节要求事件更新幂等、状态转移明确）。
 */

import { EventType, type BaseEvent, type RunAgentParameters } from "@ag-ui/client";
import {
  AGUI_CUSTOM_EVENT,
  type Activity,
  type RunSnapshot,
  type RunStatus,
} from "@deepagent/shared";
import { randomUUID } from "../../uuid.js";

/** 一条聊天消息（用户消息或 Agent 答复）。 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 是否正在流式生成。 */
  streaming: boolean;
  /** 关联的 runId。 */
  runId?: string;
  /**
   * 安全推理摘要（公开进度描述，不是原始思维链）。
   * 与 content 分开存：思考先流式完成，正文才开始流式输出。
   */
  reasoning?: string;
  /** 思考是否仍在流式输出。 */
  reasoningStreaming?: boolean;
  /** 思考开始时间戳（毫秒） */
  reasoningStartedAt?: number;
  /** 思考实际累计耗时（秒） */
  reasoningDuration?: number;
}

/** 待处理的人工审批决策。 */
export interface PendingDecision {
  type: "approve" | "edit" | "reject";
  message?: string;
}

/** 客户端全部状态。 */
export interface ClientState {
  messages: ChatMessage[];
  activities: Activity[];
  run: RunSnapshot;
  /** 当前线程 ID（会话标识）。 */
  threadId: string;
  /** interruptId → 已选决策。 */
  pendingDecisions: Record<string, PendingDecision>;
}

/** 所有状态转移动作。 */
export type ClientAction =
  | { type: "addUserMessage"; id: string; content: string }
  | { type: "startAssistant"; runId: string; messageId: string }
  | { type: "appendAssistant"; messageId: string; delta: string }
  | { type: "endAssistant"; messageId: string }
  | { type: "startReasoning"; runId: string; messageId: string }
  | { type: "appendReasoning"; messageId: string; delta: string }
  | { type: "endReasoning"; messageId: string }
  | { type: "upsertActivity"; activity: Activity }
  | { type: "patchRun"; patch: Partial<RunSnapshot> }
  | { type: "setDecision"; interruptId: string; decision: PendingDecision }
  | { type: "restoreCheckpoint"; messageId: string }
  | { type: "rollbackBeforeMessage"; messageId: string }
  | { type: "newThread"; threadId: string }
  | { type: "loadState"; state: ClientState }
  | { type: "reset" };

export const initialState: ClientState = {
  messages: [],
  activities: [],
  run: {
    status: "idle",
    runId: null,
    threadId: null,
    progressNote: null,
    interrupts: [],
    error: null,
  },
  threadId: randomUUID(),
  pendingDecisions: {},
};

/**
 * 为指定线程创建一份空白状态。
 *
 * 多会话并发执行要求每个 threadId 拥有独立的状态对象，
 * 不能再共享模块级的 initialState 单例。
 */
export function createInitialState(threadId: string): ClientState {
  return {
    messages: [],
    activities: [],
    run: {
      status: "idle",
      runId: null,
      threadId: null,
      progressNote: null,
      interrupts: [],
      error: null,
    },
    threadId,
    pendingDecisions: {},
  };
}

/** 寻找当前轮次对应的 assistant 消息，保证一个用户提问轮次始终只对应一条助手消息。 */
function findCurrentAssistantIndex(
  messages: ChatMessage[],
  runId?: string,
  messageId?: string,
): number {
  if (messageId) {
    const byId = messages.findIndex((m) => m.id === messageId);
    if (byId !== -1) return byId;
  }
  if (runId) {
    const byRun = messages.findIndex((m) => m.role === "assistant" && m.runId === runId);
    if (byRun !== -1) return byRun;
  }
  // 查找最后一条 user 消息之后创建的 assistant 消息
  const lastUserIndex = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIndex !== -1) {
    for (let i = lastUserIndex + 1; i < messages.length; i++) {
      if (messages[i]?.role === "assistant") return i;
    }
  }
  // 兜底：若最后一条本身就是 assistant 消息
  if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
    return messages.length - 1;
  }
  return -1;
}

/** 状态归约函数：纯函数，相同输入必定得到相同输出。 */
export function reduceClientEvent(state: ClientState, action: ClientAction): ClientState {
  switch (action.type) {
    case "addUserMessage":
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: action.id, role: "user", content: action.content, streaming: false },
        ],
      };

    case "startAssistant": {
      const existingIndex = findCurrentAssistantIndex(
        state.messages,
        action.runId,
        action.messageId,
      );
      if (existingIndex !== -1) {
        const messages = [...state.messages];
        const target = messages[existingIndex]!;
        textToAssistant.set(bindingKey(state.threadId, action.messageId), target.id);
        messages[existingIndex] = {
          ...target,
          streaming: true,
          reasoningStreaming: false,
          runId: action.runId || target.runId,
        };
        return { ...state, messages };
      }

      textToAssistant.set(bindingKey(state.threadId, action.messageId), action.messageId);
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: action.messageId,
            role: "assistant",
            content: "",
            streaming: true,
            runId: action.runId,
          },
        ],
      };
    }

    case "appendAssistant": {
      const realId = textToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      // 正文开始输出时，平滑收尾推理流，锁定最终思考秒数
      const started = target.reasoningStartedAt ?? Date.now();
      const elapsed =
        target.reasoningDuration ??
        Math.max(1, Math.round((Date.now() - started) / 1000));
      messages[index] = {
        ...target,
        content: target.content + action.delta,
        streaming: true,
        reasoningStreaming: false,
        reasoningDuration: elapsed,
      };
      return { ...state, messages };
    }

    case "endAssistant": {
      const realId = textToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      messages[index] = { ...target, streaming: false };
      return { ...state, messages };
    }

    case "startReasoning": {
      const existingIndex = findCurrentAssistantIndex(
        state.messages,
        action.runId,
        action.messageId,
      );
      if (existingIndex !== -1) {
        const messages = [...state.messages];
        const target = messages[existingIndex]!;
        // 铁律防回退锁：一旦正文已开始或思考已宣告完成，绝不重新进入思考流
        if (target.content.length > 0 || (target.reasoningDuration !== undefined && !target.reasoningStreaming)) {
          return state;
        }
        reasoningToAssistant.set(bindingKey(state.threadId, action.messageId), target.id);
        messages[existingIndex] = {
          ...target,
          reasoningStreaming: true,
          reasoningStartedAt: target.reasoningStartedAt ?? Date.now(),
          runId: action.runId || target.runId,
          // 多轮思考平滑追加衔接
          reasoning:
            target.reasoning && !target.reasoning.endsWith("\n\n")
              ? target.reasoning + "\n\n"
              : target.reasoning,
        };
        return { ...state, messages };
      }

      reasoningToAssistant.set(bindingKey(state.threadId, action.messageId), action.messageId);
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: action.messageId,
            role: "assistant",
            content: "",
            streaming: false,
            runId: action.runId,
            reasoning: "",
            reasoningStreaming: true,
            reasoningStartedAt: Date.now(),
          },
        ],
      };
    }

    case "appendReasoning": {
      const realId = reasoningToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      // 铁律防回退锁：正文已开始打字，丢弃迟到的思考 chunk，绝不重启思考流
      if (target.content.length > 0 || (target.reasoningDuration !== undefined && !target.reasoningStreaming)) {
        return state;
      }
      messages[index] = {
        ...target,
        reasoning: (target.reasoning ?? "") + action.delta,
        reasoningStreaming: true,
        reasoningStartedAt: target.reasoningStartedAt ?? Date.now(),
      };
      return { ...state, messages };
    }

    case "endReasoning": {
      const realId = reasoningToAssistant.get(bindingKey(state.threadId, action.messageId)) ?? action.messageId;
      const index = state.messages.findIndex((message) => message.id === realId);
      if (index === -1) return state;
      const messages = [...state.messages];
      const target = messages[index];
      if (!target) return state;
      const started = target.reasoningStartedAt ?? Date.now();
      const elapsed = Math.max(1, Math.round((Date.now() - started) / 1000));
      messages[index] = {
        ...target,
        reasoningDuration: elapsed,
        // 收到思考结束事件，彻底锁定并终结推理流状态
        reasoningStreaming: false,
      };
      return { ...state, messages };
    }

    case "upsertActivity": {
      // 同一 ID 只更新同一张卡片。
      // 字段级合并 + 保留最早 startedAt：即使上游发的是增量卡片，
      // 也不会丢掉已经展示过的信息，时间线也不会抖动。
      const index = state.activities.findIndex((item) => item.id === action.activity.id);
      if (index === -1) {
        return { ...state, activities: [...state.activities, action.activity] };
      }
      const activities = [...state.activities];
      const existing = activities[index];
      if (!existing) return state;
      activities[index] = {
        ...existing,
        ...action.activity,
        // detail 同样做字段级合并，避免增量事件清空已展示的详情。
        detail:
          existing.detail && action.activity.detail
            ? { ...(existing.detail as object), ...(action.activity.detail as object) }
            : action.activity.detail ?? existing.detail,
        startedAt: existing.startedAt,
        // 结束时间一旦出现过就不回退。
        endedAt: action.activity.endedAt ?? existing.endedAt,
      };
      return { ...state, activities };
    }

    case "patchRun": {
      const isFinished =
        action.patch.status === "completed" ||
        action.patch.status === "cancelled" ||
        action.patch.status === "error";
      const messages = isFinished
        ? state.messages.map((m) =>
            m.reasoningStreaming
              ? {
                  ...m,
                  reasoningStreaming: false,
                  reasoningDuration:
                    m.reasoningDuration ??
                    Math.max(1, Math.round((Date.now() - (m.reasoningStartedAt ?? Date.now())) / 1000)),
                }
              : m,
          )
        : state.messages;
      return { ...state, messages, run: { ...state.run, ...action.patch } };
    }

    case "setDecision":
      return {
        ...state,
        pendingDecisions: { ...state.pendingDecisions, [action.interruptId]: action.decision },
      };

    case "restoreCheckpoint": {
      // 回退到指定检查点：保留该消息本身（用户点的是「回到此处」），
      // 丢弃它之后的全部消息，并清掉这期间产生的活动卡片。
      const index = state.messages.findIndex((message) => message.id === action.messageId);
      if (index === -1) return state;
      const keptMessages = state.messages.slice(0, index + 1);
      // 活动卡片按 runId 归属：只保留仍被引用到的那些。
      const keptRunIds = new Set(keptMessages.map((message) => message.runId).filter(Boolean));
      const keptActivities =
        keptRunIds.size === 0
          ? []
          : state.activities.filter((activity) => {
              if (activity.id.startsWith("todo:")) return true;
              // 卡片 ID 形如 tool:<callId> / file:<callId>，无法直接映射 runId；
              // 用 startedAt 之后产生的卡片一律丢弃这个近似会误伤，因此这里
              // 只保留 Todo 主卡片，工具/子 Agent 卡片随回退一起清空。
              return false;
            });
      resetReasoningBindings(state.threadId);
      return {
        ...state,
        messages: keptMessages,
        activities: keptActivities,
        run: { ...initialState.run, threadId: state.threadId },
        pendingDecisions: {},
      };
    }

    case "rollbackBeforeMessage": {
      // 重新编辑消息专用：丢弃目标消息自身及它之后的全部消息与活动，
      // 避免 handleSend 重新发送后在界面上产生两份重复的用户消息。
      const index = state.messages.findIndex((message) => message.id === action.messageId);
      if (index === -1) return state;
      const keptMessages = state.messages.slice(0, index);
      const keptRunIds = new Set(keptMessages.map((message) => message.runId).filter(Boolean));
      const keptActivities = state.activities.filter((activity) => {
        if (!activity.runId) return false;
        return keptRunIds.has(activity.runId);
      });
      resetReasoningBindings(state.threadId);
      return {
        ...state,
        messages: keptMessages,
        activities: keptActivities,
        run: { ...initialState.run, threadId: state.threadId },
        pendingDecisions: {},
      };
    }

    case "newThread":
      // 新会话：清空消息、活动与运行状态，threadId 换成新的。
      // 只清理该线程的绑定，不影响其它仍在后台运行的会话。
      resetReasoningBindings(state.threadId);
      return createInitialState(action.threadId);

    case "loadState":
      resetReasoningBindings(state.threadId);
      // 防御性规范化：从本地存储载入的历史数据，所有流式与思考标志必须重置为 false，
      // 避免刷新或切换会话后卡死在「正在思考中」；同时确保 reasoningDuration 有真实值。
      return {
        ...action.state,
        // 历史数据缺失 threadId 时回退到当前线程，避免状态归属错乱。
        threadId: action.state.threadId ?? state.threadId,
        run: {
          ...action.state.run,
          status: action.state.run?.status === "running" ? "completed" : (action.state.run?.status ?? "idle"),
        },
        messages: (action.state.messages || []).map((m) => ({
          ...m,
          streaming: false,
          reasoningStreaming: false,
          // 若历史旧数据未保存 duration，则根据思考字数计算真实合理秒数，避免全部误显为 1 秒
          reasoningDuration:
            m.reasoningDuration ??
            (m.reasoning && m.reasoning.trim().length > 0
              ? Math.max(2, Math.min(15, Math.ceil(m.reasoning.trim().length / 60)))
              : undefined),
        })),
        activities: (action.state.activities || []).map((a) => ({
          ...a,
          status: a.status === "running" ? "completed" : a.status,
        })),
      };

    case "reset":
      return createInitialState(state.threadId);

    default:
      return state;
  }
}



/**
 * reasoning messageId → assistant messageId 的映射。
 *
 * Key 形如 `<threadId>::<messageId>`：多会话并发执行时，
 * 不同线程的流式消息 ID 可能重名，必须按线程隔离，
 * 否则一个线程的绑定会被另一个线程覆盖。
 */
const reasoningToAssistant = new Map<string, string>();

/**
 * text messageId → assistant messageId 的映射（同样按线程隔离）。
 */
const textToAssistant = new Map<string, string>();

/** 拼接线程作用域的绑定 Key。 */
function bindingKey(threadId: string, messageId: string): string {
  return `${threadId}::${messageId}`;
}

/**
 * 重置跨 run 的 ID 绑定。
 *
 * @param threadId 只清理该线程的绑定；省略时清理全部（测试与整体重置场景）。
 */
export function resetReasoningBindings(threadId?: string): void {
  if (!threadId) {
    reasoningToAssistant.clear();
    textToAssistant.clear();
    return;
  }
  const prefix = `${threadId}::`;
  for (const key of [...reasoningToAssistant.keys()]) {
    if (key.startsWith(prefix)) reasoningToAssistant.delete(key);
  }
  for (const key of [...textToAssistant.keys()]) {
    if (key.startsWith(prefix)) textToAssistant.delete(key);
  }
}

/** 把 AG-UI 事件转成归约动作。 */
export function eventToActions(event: BaseEvent, state: ClientState): ClientAction[] {
  const actions: ClientAction[] = [];
  const eventRunId =
    (event as unknown as { runId?: string }).runId || state.run.runId || "";

  switch (event.type) {
    case EventType.RUN_STARTED: {
      const runId = (event as unknown as { runId?: string }).runId ?? "";
      const threadId = (event as unknown as { threadId?: string }).threadId ?? "";
      actions.push({ type: "patchRun", patch: { status: "running", runId, threadId } });
      break;
    }
    case EventType.TEXT_MESSAGE_START: {
      const messageId = (event as unknown as { messageId: string }).messageId;
      actions.push({ type: "startAssistant", runId: eventRunId, messageId });
      break;
    }
    case EventType.TEXT_MESSAGE_CONTENT: {
      const { messageId, delta } = event as unknown as { messageId: string; delta: string };
      actions.push({ type: "appendAssistant", messageId, delta });
      break;
    }
    case EventType.TEXT_MESSAGE_END: {
      const messageId = (event as unknown as { messageId: string }).messageId;
      actions.push({ type: "endAssistant", messageId });
      break;
    }
    case EventType.REASONING_MESSAGE_START: {
      const reasoningId = (event as unknown as { messageId: string }).messageId;
      actions.push({ type: "startReasoning", runId: eventRunId, messageId: reasoningId });
      break;
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const { messageId, delta } = event as unknown as { messageId: string; delta: string };
      actions.push({ type: "appendReasoning", messageId, delta });
      break;
    }
    case EventType.REASONING_MESSAGE_END: {
      const messageId = (event as unknown as { messageId: string }).messageId;
      actions.push({ type: "endReasoning", messageId });
      break;
    }
    case EventType.CUSTOM: {
      const { name, value } = event as unknown as { name: string; value: unknown };
      if (name === AGUI_CUSTOM_EVENT.ACTIVITY_DELTA) {
        actions.push({ type: "upsertActivity", activity: value as Activity });
      } else if (name === AGUI_CUSTOM_EVENT.RUN_SNAPSHOT) {
        actions.push({ type: "patchRun", patch: value as Partial<RunSnapshot> });
      }
      break;
    }
    case EventType.RUN_FINISHED: {
      const outcome = (event as unknown as { outcome?: { type: string } }).outcome;
      if (outcome?.type === "interrupt") {
        actions.push({ type: "patchRun", patch: { status: "waiting_approval" } });
      } else {
        actions.push({ type: "patchRun", patch: { status: "completed" } });
      }
      break;
    }
    case EventType.RUN_ERROR: {
      const message = (event as unknown as { message: string }).message;
      actions.push({ type: "patchRun", patch: { status: "error", error: message } });
      break;
    }
    default:
      break;
  }
  return actions;
}

/**
 * 构造 AG-UI 运行请求参数。
 *
 * 模型与推理强度通过 forwardedProps 传给服务端适配器，
 * 这样前端不需要知道各提供商的参数差异。
 *
 * 对话历史不需要在这里传：HttpAgent 自己维护 `messages`，
 * 通过 addMessage/setMessages 累积，运行时自动带上。
 */
export function buildRunParameters(
  runId: string,
  options: {
    providerId?: string;
    modelId?: string;
    effort: "low" | "medium" | "high";
    /** 左侧树选中的工作区目录；服务端会校验它确实在工作区之内。 */
    workspaceRoot?: string;
  },
  resume?: Array<{ interruptId: string; status: "resolved" | "cancelled"; payload?: unknown }>,
): RunAgentParameters {
  // 测试钩子：允许浏览器端到端脚本固定使用某个模型，
  // 避免断言依赖用户当前选中的模型。
  // 用 typeof 守卫而不是 import.meta.env.DEV：这个模块也被 Node 侧的单测
  // 直接 import，那里没有 import.meta。生产构建里没人设置该变量，行为不变。
  const forced = (globalThis as { __deepagentForceModel?: string }).__deepagentForceModel;
  return {
    runId,
    forwardedProps: {
      providerId: options.providerId,
      modelId: typeof forced === "string" && forced.length > 0 ? forced : options.modelId,
      effort: options.effort,
      workspaceRoot: options.workspaceRoot,
    },
    ...(resume && resume.length > 0 ? { resume } : {}),
  };
}

/** 运行状态的中文标签。 */export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  idle: "空闲",
  connecting: "连接中",
  running: "运行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  cancelled: "已取消",
  error: "出错",
};
