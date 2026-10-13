/**
 * AG-UI Agent 实现。
 *
 * 继承 `AbstractAgent`，把 DeepAgent 的运行接到 AG-UI 事件流上。
 * 每个线程一个 LangGraph thread_id，通过本地 Markdown 检查点持久化状态，
 * 刷新页面或重启本地服务后都可以继续同一会话。
 */

import { type BaseEvent, type RunAgentInput, type ResumeEntry } from "@ag-ui/core";
import { AbstractAgent } from "@ag-ui/client";
import { Observable } from "rxjs";
import type { Decision } from "langchain";
import { FileCheckpointSaver } from "../config/file-checkpoint-saver.js";
import { ConfigStore } from "../config/store.js";
import {
  createAgentBundle,
  FileDiffRecorder,
  type CreateAgentOptions,
} from "./create-agent.js";
import { describeRunError } from "./errors.js";
import {
  DeepAgentToAguiAdapter,
  aguiMessagesToLangChain,
} from "./agui-adapter.js";
import {
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type ReasoningEffort,
} from "@deepagent/shared";
import { resolveEffortForModel } from "@deepagent/shared";
import { randomUUID } from "node:crypto";
import { resolve, sep } from "node:path";

/** Agent 服务的配置。 */
export interface DeepAgentServiceOptions {
  store: ConfigStore;
  workspaceRoot: string;
  shellEnabled: boolean;
  approvalRequired: boolean;
  /** 推理强度（客户端可在 forwardedProps 里覆盖）。 */
  defaultEffort: ReasoningEffort;
}

/** 一个线程的运行句柄（用于取消）。 */
interface ThreadRun {
  abortController: AbortController;
  threadId: string;
}

export class DeepAgentAgui extends AbstractAgent {
  private readonly store: ConfigStore;
  private workspaceRoot: string;
  private readonly baseWorkspaceRoot: string;
  private readonly shellEnabled: boolean;
  private readonly approvalRequired: boolean;
  private readonly defaultEffort: ReasoningEffort;
  private readonly checkpointer: FileCheckpointSaver;
  /** threadId → 当前运行，支持取消。 */
  private readonly activeRuns = new Map<string, ThreadRun>();

  constructor(config: { agentId?: string; checkpointer: FileCheckpointSaver } & DeepAgentServiceOptions) {
    super({ agentId: config.agentId ?? "deepagent" });
    this.store = config.store;
    this.workspaceRoot = resolve(config.workspaceRoot);
    this.baseWorkspaceRoot = resolve(config.workspaceRoot);
    this.shellEnabled = config.shellEnabled;
    this.approvalRequired = config.approvalRequired;
    this.defaultEffort = config.defaultEffort;
    this.checkpointer = config.checkpointer;
  }

  close(): Promise<void> { return this.checkpointer.flush(); }

  /** 动态更新当前活动工作区根目录。 */
  setWorkspaceRoot(newRoot: string): void {
    this.workspaceRoot = resolve(newRoot);
  }

  /** 获取当前活动工作区根目录。 */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }

  /** AG-UI 要求的入口：返回事件 Observable。 */
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((observer) => {
      const controller = new AbortController();
      this.activeRuns.set(input.threadId, { abortController: controller, threadId: input.threadId });

      const sink = (event: BaseEvent): void => {
        observer.next(event);
      };
      // bundle（含文件变更记录器）在 execute 里才创建，适配器创建更早；
      // 用惰性 getter 在真正消费工具调用时才解析记录器，多会话并发各自隔离。
      const runtime: { diffRecorder?: FileDiffRecorder } = {};
      const adapter = new DeepAgentToAguiAdapter(
        {
          input,
          newId: () => randomUUID(),
          now: () => Date.now(),
          get diffRecorder() {
            return runtime.diffRecorder;
          },
        },
        sink,
      );

      void this.execute(input, adapter, controller.signal, runtime)
        .catch((error: unknown) => {
          // 底层模型/LangGraph 的原始错误信息对用户不可读，
          // 也不该把内部文档链接直接抛到界面上。
          adapter.fail(new Error(describeRunError(error)));
        })
        .finally(() => {
          this.activeRuns.delete(input.threadId);
          observer.complete();
        });

      // 订阅方取消时中止底层运行。
      return () => {
        controller.abort();
        this.activeRuns.delete(input.threadId);
      };
    });
  }

  /** 取消指定线程的运行。 */
  cancelThread(threadId: string): boolean {
    const run = this.activeRuns.get(threadId);
    if (!run) return false;
    run.abortController.abort();
    return true;
  }

  private async execute(
    input: RunAgentInput,
    adapter: DeepAgentToAguiAdapter,
    signal: AbortSignal,
    runtime: { diffRecorder?: FileDiffRecorder },
  ): Promise<void> {
    // RUN_STARTED 必须第一个发出，即使随后立即失败：
    // AG-UI 客户端依赖它标记运行开始。
    adapter.start();

    const provider = this.resolveProvider(input);
    if (!provider) {
      adapter.fail(
        new Error("尚未配置可用的模型提供商。请在「模型设置」中添加提供商并填写 API Key。"),
      );
      return;
    }
    const modelId = readModelId(input) ?? provider.defaultModel ?? provider.models[0] ?? "";
    if (!modelId) {
      adapter.fail(new Error("该提供商尚未选择默认模型。请在「模型设置」中设置默认模型。"));
      return;
    }

    const effort = resolveEffortForModel(
      modelId,
      readEffort(input) ?? this.defaultEffort,
    ).effort;
    const permissionMode = readPermissionMode(input);

    // 前端左侧树选中的目录会作为 forwardedProps.workspaceRoot 传上来。
    // 必须校验它确实落在配置的工作区之内，否则前端可以借这个字段
    // 让 Agent 访问任意目录。
    const requestedWorkspace = readWorkspaceRoot(input);
    const workspaceRoot =
      requestedWorkspace && (isInside(this.workspaceRoot, requestedWorkspace) || isInside(this.baseWorkspaceRoot, requestedWorkspace))
        ? requestedWorkspace
        : this.workspaceRoot;

    const bundle = createAgentBundle(
      {
        provider,
        workspaceRoot,
        effort,
        shellEnabled: this.shellEnabled,
        approvalRequired: this.approvalRequired && permissionMode !== "full",
        permissionMode,
      } satisfies CreateAgentOptions,
      this.checkpointer,
    );
    runtime.diffRecorder = bundle.diffRecorder;

    const resume = input.resume ?? [];
    const isResume = resume.length > 0;

    const config = {
      configurable: { thread_id: input.threadId },
      signal,
    };

    if (isResume) {
      // 审批续跑需要保留已有 checkpoint，同时把已存在消息里的 tool_calls 记入 seenToolCalls，
      // 避免中断前的工具调用在续跑时被重复当作新工具推送。
      const existingTuple = await this.checkpointer.getTuple(config);
      const existingMessages = (
        existingTuple?.checkpoint?.channel_values as { messages?: unknown } | undefined
      )?.messages;
      adapter.markHistoricalMessages(existingMessages);
    } else {
      // 非审批续跑时，前端 input.messages 已携带当前线程完整的有效对话历史（含重试/编辑回滚后的历史）。
      // 清理该线程旧 checkpoint，防止「重新生成回答」或「编辑消息重发」时旧轮次的 AIMessage(tool_calls)
      // 与 ToolMessage 残留在 LangGraph 状态中并在第一帧被重放出来。
      await this.checkpointer.deleteThread(input.threadId);
    }

    const state = isResume
      ? DeepAgentToAguiAdapter.decisionsToCommand(resumeToDecisions(resume))
      : {
          messages: aguiMessagesToLangChain(
            input.messages,
            provider.type === "stepfun" || provider.type === "openai" || provider.type === "openai-compatible",
          ),
        };

    const run = await bundle.agent.streamEvents(state, { ...config, version: "v3" as const });

    // 并发消费各个投影；消息流与 run.output 为主完成条件，辅助投影若挂起则在短暂宽限后放行。
    const messagesDone = adapter.consumeMessages(run).catch((error: unknown) => {
      throw error;
    });
    const auxConsumersDone = Promise.all([
      adapter.consumeToolCalls(run),
      adapter.consumeSubagents(run),
      adapter.consumeValues(run),
    ]);

    // 等待运行本身完成，再收尾。
    const runFinished = run.output.then(
      () => undefined,
      (error: unknown) => {
        throw error;
      },
    );

    const coreDone = Promise.all([messagesDone, runFinished]);
    await Promise.race([
      Promise.all([coreDone, auxConsumersDone]),
      coreDone.then(() => new Promise<void>((resolve) => setTimeout(resolve, 150))),
    ]);

    const interrupts = run.interrupts ?? [];
    if (interrupts.length > 0) {
      adapter.emitInterrupts(interrupts);
      adapter.finishWithInterrupt();
      return;
    }
    // resume 运行收尾对账：最终状态的总结文本若未通过流式事件发出，平滑补发。
    if (isResume) {
      const output = await run.output;
      const finalMessages = (output as { messages?: unknown }).messages;
      await adapter.reconcileResumeSummary(finalMessages);
    }
    adapter.finish();
  }

  /** 从 forwardedProps 里解析提供商；缺省用当前启用的那个。 */
  private resolveProvider(input: RunAgentInput) {
    const props = (input.forwardedProps ?? {}) as { providerId?: string };
    const active = this.store.getActive(props.providerId);
    if (!active) return null;
    if (active.apiKey.trim().length === 0) return null;
    if (!active.enabled) return null;
    return active;
  }
}

/** 从本次运行参数读取审批模式；缺省或无效值采用最严格模式。 */
export function readPermissionMode(input: RunAgentInput): PermissionMode {
  const props = (input.forwardedProps ?? {}) as { permissionMode?: unknown };
  if (props.permissionMode === "auto" || props.permissionMode === "full" || props.permissionMode === "ask") {
    return props.permissionMode;
  }
  return DEFAULT_PERMISSION_MODE;
}

/** 把 AG-UI 的 ResumeEntry 数组转成 LangGraph 的 Decision 数组。 */
function resumeToDecisions(resume: readonly ResumeEntry[]): Decision[] {
  const decisions: Decision[] = [];
  for (const entry of resume) {
    const payload = entry.payload as { type?: string; message?: string } | undefined;
    const type = payload?.type;
    if (type === "approve") {
      decisions.push({ type: "approve" });
    } else if (type === "edit") {
      // 编辑场景：payload 需带 editedAction，缺省时退化为批准。
      const edited = (payload as { editedAction?: { name: string; args: Record<string, unknown>; description?: string } }).editedAction;
      if (edited) {
        decisions.push({ type: "edit", editedAction: edited });
      } else {
        decisions.push({ type: "approve" });
      }
    } else {
      decisions.push({ type: "reject", message: payload?.message ?? "用户拒绝了该操作。" });
    }
  }
  return decisions;
}

/** 读取客户端请求的工作区目录（左侧树选中的那个）。 */
function readWorkspaceRoot(input: RunAgentInput): string | null {
  const props = (input.forwardedProps ?? {}) as { workspaceRoot?: unknown };
  return typeof props.workspaceRoot === "string" && props.workspaceRoot.length > 0
    ? props.workspaceRoot
    : null;
}

/**
 * 判断 candidate 是否在 root 之内（或就是 root）。
 *
 * 前端传上来的目录必须通过这个检查，否则任何人都能借 forwardedProps
 * 让 Agent 读写工作区以外的路径。用解析后的路径做前缀比较，
 * 挡住 `..`、绝对路径和符号链接逃逸。
 */
export function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (resolvedCandidate === resolvedRoot) return true;
  // 加分隔符再比，避免 /a/bc 被误判为 /a/b 的子目录。
  return resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

/** 读取客户端请求的模型 ID。 */
function readModelId(input: RunAgentInput): string | null {
  const props = (input.forwardedProps ?? {}) as { modelId?: unknown };
  return typeof props.modelId === "string" && props.modelId.length > 0 ? props.modelId : null;
}

/** 读取客户端请求的推理强度。 */
function readEffort(input: RunAgentInput): ReasoningEffort | null {
  const props = (input.forwardedProps ?? {}) as { effort?: unknown };
  if (props.effort === "low" || props.effort === "medium" || props.effort === "high") {
    return props.effort;
  }
  return null;
}
