/**
 * 聊天消息列表。
 *
 * 严格对齐 AI SDK Elements 官网组件规范 (https://elements.ai-sdk.dev/components)：
 * 1. 纯黑极简底色（与侧边栏一体化），完全去掉用户和智能体的头像。
 * 2. 用户消息：支持重新编辑功能（点击编辑按钮原地修改并重新发送），彻底删除无用的 Checkpoint。
 * 3. 思考组件（Reasoning）：
 *    - 具备微光闪烁（Shimmer 闪光 2 秒动效）；
 *    - 在生成中时展示流式思考动态，并可实时折叠/展开；
 *    - 回答完成后保留折叠卡片，可随时回顾思考过程。
 * 4. 任务列表组件（Queue / Todo）：
 *    - 严格遵循 AI SDK Elements Queue 规范，支持任务状态指示与划线完成。
 * 5. 工具调用卡片（Tool）：
 *    - 实时展开展示调用的工具名、参数输入（ToolInput）与终端执行结果（ToolOutput）。
 * 6. 人工安全审批与纯净 Markdown 渲染。
 */

import { Fragment, useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "../../components/ai-elements/conversation.js";
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageToolbar,
  MessageActions as MessageActionsGroup,
  MessageAction,
} from "../../components/ai-elements/message.js";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "../../components/ai-elements/reasoning.js";
import { ApprovalCard } from "./approval-card.js";
import { TodoCard } from "./todo-card.js";
import {
  CopyIcon,
  CheckIcon,
  RotateCcwIcon,
  SparklesIcon,
  ArrowRightIcon,
  PencilIcon,
  ArrowUpIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "../../lib/utils.js";
import type { Activity, ChatMessage } from "./chat-types.js";

interface ChatMessagesProps {
  messages: ChatMessage[];
  activities: Activity[];
  error: string | null;
  isRunning?: boolean;
  onRetry?: (messageId: string) => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  decisions?: Record<string, { type: "approve" | "edit" | "reject" }>;
  onQuickPrompt?: (prompt: string) => void;
}

/** 从活动详情里提取输入和输出 */
function toolIo(activity: Activity): { input: unknown; output: string | undefined } {

  const detail = activity.detail as { input?: unknown; output?: unknown } | undefined;
  const input = detail?.input;
  const output = typeof detail?.output === "string" ? detail.output : undefined;
  return { input, output };
}

/** 映射审批中断决策 */
function decisionFor(
  decisions: Record<string, { type: "approve" | "edit" | "reject" }> | undefined,
  activity: Activity,
): "approve" | "reject" | undefined {
  if (!decisions) return undefined;
  const interruptId = activity.id.split(":")[1];
  if (!interruptId) return undefined;
  const decision = decisions[interruptId] ?? decisions[activity.id];
  if (!decision) return undefined;
  return decision.type === "approve" ? "approve" : "reject";
}

export function ChatMessages({
  messages,
  activities,
  error,
  isRunning = false,
  onRetry,
  onEditMessage,
  onDecide,
  decisions,
  onQuickPrompt,
}: ChatMessagesProps) {
  // 待办计划任务
  const todoActivity = activities.find((activity) => activity.kind === "todo");
  // 人工审批活动
  const approvals = activities.filter((activity) => activity.kind === "approval");
  // 工具调用卡片
  const toolActivities = useMemo(() => {
    return activities.filter((activity) => activity.kind === "tool");
  }, [activities]);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  // 用户消息原地编辑状态
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");

  const handleCopy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const startEditMessage = (id: string, currentContent: string) => {
    setEditingMessageId(id);
    setEditingContent(currentContent);
  };

  const handleSaveEdit = (messageId: string) => {
    const trimmed = editingContent.trim();
    if (trimmed && onEditMessage) {
      onEditMessage(messageId, trimmed);
    }
    setEditingMessageId(null);
  };

  return (
    <Conversation className="min-h-0 flex-1 bg-black">
      <ConversationContent className="mx-auto w-full max-w-3xl px-4 py-8">
        {messages.length === 0 ? (
          /* 空状态引导区 */
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-zinc-900 border border-zinc-800 text-zinc-300 shadow-inner">
              <SparklesIcon className="size-6 text-zinc-100" />
            </div>
            <h2 className="mb-2 text-lg font-semibold text-zinc-100">
              DeepAgent 桌面工作台
            </h2>
            <p className="mb-6 max-w-md text-[13px] text-zinc-500">
              基于 LangChain Deep Agents 与 AI SDK Elements 构建。支持任务分解队列、Shell终端命令、文件工具、子智能体与可控推理。
            </p>

            <div className="grid w-full max-w-md grid-cols-1 gap-2 sm:grid-cols-2 text-left">
              {[
                { label: "查看工作区文件", prompt: "查看当前工作区目录下的所有文件并说明用途。" },
                { label: "规划待办开发任务", prompt: "为当前工作区规划一份构建 TypeScript CLI 工具的待办清单并开始执行。" },
                { label: "创建项目说明文档", prompt: "在工作区创建 README.md 文件，写入工作台的功能特性与使用指南。" },
                { label: "检查系统运行环境", prompt: "执行 Shell 命令检查当前系统的 Node.js 版本和操作系统平台。" },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => onQuickPrompt?.(item.prompt)}
                  className="flex items-center justify-between rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 text-[12.5px] text-zinc-300 hover:border-zinc-700 hover:bg-zinc-900 hover:text-white transition-all text-left"
                >
                  <span className="truncate mr-1">{item.label}</span>
                  <ArrowRightIcon className="size-3.5 text-zinc-500 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col space-y-6">
            {messages.map((message, idx) => {
              const isUser = message.role === "user";
              const isLast = idx === messages.length - 1;
              const isEditing = editingMessageId === message.id;

              // 用户消息渲染
              if (isUser) {
                return (
                  <div key={message.id} className="group/user flex flex-col items-end w-full">
                    {isEditing ? (
                      /* 内联编辑模式 */
                      <div className="w-full max-w-[85%] rounded-2xl border border-zinc-700 bg-zinc-900 p-3 shadow-lg">
                        <textarea
                          value={editingContent}
                          onChange={(e) => setEditingContent(e.target.value)}
                          className="w-full min-h-[70px] bg-transparent text-[13.5px] text-zinc-100 outline-none resize-none placeholder:text-zinc-500"
                          placeholder="重新编辑消息内容..."
                          autoFocus
                        />
                        <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-zinc-800">
                          <button
                            type="button"
                            onClick={() => setEditingMessageId(null)}
                            className="px-2.5 py-1 text-[11.5px] text-zinc-400 hover:text-zinc-200"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(message.id)}
                            className="flex items-center gap-1 px-3 py-1 rounded bg-zinc-100 hover:bg-white text-black font-medium text-[11.5px] transition-colors"
                          >
                            <ArrowUpIcon className="size-3" />
                            <span>重新发送</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* 普通气泡展示模式 */
                      <div className="flex items-start gap-1.5 max-w-[85%]">
                        {/* 悬浮操作按钮：重新编辑 */}
                        {onEditMessage && (
                          <button
                            type="button"
                            onClick={() => startEditMessage(message.id, message.content)}
                            className="opacity-0 group-hover/user:opacity-100 p-1 text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 rounded transition-opacity"
                            title="重新编辑此消息"
                          >
                            <PencilIcon className="size-3.5" />
                          </button>
                        )}

                        <div className="rounded-2xl bg-zinc-900 px-4 py-2.5 text-[14px] text-zinc-100 shadow-sm border border-zinc-800/80">
                          <p className="whitespace-pre-wrap break-words leading-relaxed">
                            {message.content}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              }

              // 助手 Agent 消息（无头像、左对齐纯净排版）

              // 严格按 runId 归属当前轮次的活动，绝不把其他轮次或历史工具倾倒到本轮
              const currentRunId = message.runId;
              const rawToolActivities = activities
                .filter((activity) => {
                  if (activity.kind !== "tool") return false;
                  if (currentRunId && activity.runId) {
                    return activity.runId === currentRunId;
                  }
                  // 若无明确 runId 归属，且当前是最后一条 assistant 消息，则承载活动，无论运行中还是已结束绝不消失
                  return isLast && (!currentRunId || !activity.runId);
                })
                .sort((a, b) => a.startedAt - b.startedAt);

              // 严格按工具名归一化去重：同一轮次内同一个工具只保留最新的一条，绝不重复展示两个同名标签或卡片
              const toolMap = new Map<string, Activity>();
              for (const activity of rawToolActivities) {
                const existing = toolMap.get(activity.title);
                if (!existing) {
                  toolMap.set(activity.title, activity);
                } else {
                  // 优先保留具有明确输入参数的、或最新状态的记录
                  const existingHasInput = Boolean(toolIo(existing).input);
                  const currentHasInput = Boolean(toolIo(activity).input);
                  if (!existingHasInput && currentHasInput) {
                    toolMap.set(activity.title, activity);
                  } else if (activity.status === "completed" || activity.status === "failed") {
                    toolMap.set(activity.title, activity);
                  } else {
                    toolMap.set(activity.title, activity);
                  }
                }
              }
              const currentToolActivities = Array.from(toolMap.values()).sort(
                (a, b) => a.startedAt - b.startedAt,
              );

              const currentTodoActivity = activities.find((activity) => {
                if (activity.kind !== "todo") return false;
                if (currentRunId && activity.runId) {
                  return activity.runId === currentRunId;
                }
                return isLast && (!currentRunId || !activity.runId);
              });

              const reasoningText = (message.reasoning ?? "").trim();
              const hasReasoning = reasoningText.length > 0;
              // 严格互斥：一旦正文开始打字或思考收到结束信号，思考流锁定为已完成
              const isReasoningStreaming = message.reasoningStreaming === true;
              const hasRunningTool = currentToolActivities.some((a) => a.status === "running");

              // 严格时序铁律：思考必须完全结束（!isReasoningStreaming）且无正在运行工具，才允许流式输出正式内容
              const shouldShowMessageContent =
                !isReasoningStreaming && !hasRunningTool && (message.content.length > 0 || message.streaming);

              return (
                <div key={message.id} className="flex flex-col w-full text-zinc-100 space-y-3">
                  {/* 1. 思考组件（Reasoning）：生命周期自发送时刻起全程唯一且稳定，秒表与打字内容毫秒级同步 */}
                  {(hasReasoning || isReasoningStreaming) ? (
                    <Reasoning
                      className="mb-1 w-full"
                      isStreaming={isReasoningStreaming}
                      defaultOpen={isReasoningStreaming}
                      duration={message.reasoningDuration}
                      startedAt={message.reasoningStartedAt}
                    >
                      <ReasoningTrigger className="text-zinc-400 hover:text-zinc-200 py-1 flex items-center gap-2 text-xs" />

                      <ReasoningContent className="text-zinc-400 text-[13px] leading-relaxed pl-3 border-l-2 border-zinc-800 my-2">
                        {reasoningText}
                      </ReasoningContent>
                    </Reasoning>
                  ) : null}

                  {/* 2. 待办任务队列卡片（Queue / Todo）：仅在当前轮次调用了 write_todos 时展示 */}
                  {currentTodoActivity ? (
                    <div className="w-full my-1">
                      <TodoCard activity={currentTodoActivity} />
                    </div>
                  ) : null}

                  {/* 3. 工具调用提示：完全去掉复杂卡片，按工具名归一化展示干净的单行提示 */}
                  {currentToolActivities.length > 0 && (
                    <div className="flex w-full flex-col gap-1.5 my-1">
                      {currentToolActivities.map((activity) => {
                        const { input, output } = toolIo(activity);
                        const isRunningTool = activity.status === "running";
                        const isFailedTool = activity.status === "failed";

                        // 工具名友好展示
                        const toolLabel = (() => {
                          switch (activity.title) {
                            case "execute": return "执行 Shell 命令";
                            case "ls": return "列出目录文件";
                            case "read_file": return "读取文件";
                            case "write_file": return "写入文件";
                            case "edit_file": return "修改文件";
                            case "write_todos": return "规划待办任务";
                            case "task": return "派发子任务";
                            case "glob": return "搜索文件路径";
                            case "grep": return "搜索文件内容";
                            case "delete_file": return "删除文件";
                            default: return activity.title;
                          }
                        })();

                        // 取输入摘要：路径/命令/内容截断
                        const inputSummary = (() => {
                          if (!input || typeof input !== "object") return "";
                          const rec = input as Record<string, unknown>;
                          const v = rec.path ?? rec.command ?? rec.pattern ?? rec.query ?? rec.content ?? "";
                          const s = String(v ?? "").trim().replace(/\s+/g, " ");
                          return s.length > 70 ? s.slice(0, 70) + "…" : s;
                        })();

                        return (
                          <div
                            key={activity.title}
                            className="flex items-center gap-2 text-xs py-0.5 text-zinc-400"
                          >
                            <TerminalIcon className="size-3.5 shrink-0 text-zinc-500" />
                            <span className="text-zinc-300">
                              {isRunningTool ? "正在调用工具：" : "已调用工具："}
                              <span className="text-zinc-200 font-medium">{toolLabel}</span>
                            </span>
                            {inputSummary && (
                              <span className="text-zinc-500 truncate max-w-[360px]" title={inputSummary}>
                                › {inputSummary}
                              </span>
                            )}
                            {isRunningTool ? (
                              <span className="text-[11px] text-zinc-500 animate-pulse ml-auto">调用中...</span>
                            ) : isFailedTool ? (
                              <span className="text-[11px] text-red-400 ml-auto">失败</span>
                            ) : (
                              <span className="text-[11px] text-emerald-500/80 ml-auto">完成</span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* 4. 人工安全审批卡片 */}
                  {isLast &&
                    approvals.map((activity) => (
                      <div key={activity.id} className="w-full my-1">
                        <ApprovalCard
                          activity={activity}
                          decision={decisionFor(decisions, activity)}
                          onDecide={onDecide}
                        />
                      </div>
                    ))}

                  {/* 5. 消息正文与流式回答：仅在推理完成后开始输出 */}
                  {shouldShowMessageContent && (
                    <Message from="assistant" className="w-full">
                      <MessageContent className="text-zinc-100 w-full text-[14px]">
                        {message.streaming && message.content.length === 0 ? (
                          <span className="text-[13px] text-zinc-500 animate-pulse">
                            正在输出回答…
                          </span>
                        ) : message.content.length > 0 ? (
                          <div className={cn("w-full text-zinc-100", message.streaming && "streaming-caret")}>
                            <MessageResponse mode={message.streaming ? "streaming" : "static"}>
                              {message.content}
                            </MessageResponse>
                          </div>
                        ) : null}
                      </MessageContent>

                      {/* 消息底部操作工具条（复制、重试） */}
                      {!message.streaming && message.content.length > 0 && (
                        <MessageToolbar className="mt-2 text-zinc-500">
                          <MessageActionsGroup>
                            <MessageAction
                              tooltip="复制回答"
                              onClick={() => handleCopy(message.id, message.content)}
                              className="hover:text-zinc-200"
                            >
                              {copiedId === message.id ? (
                                <CheckIcon className="size-3.5 text-emerald-400" />
                              ) : (
                                <CopyIcon className="size-3.5" />
                              )}
                            </MessageAction>

                            {onRetry && (
                              <MessageAction
                                tooltip="重新生成回答"
                                onClick={() => onRetry(message.id)}
                                className="hover:text-zinc-200"
                              >
                                <RotateCcwIcon className="size-3.5" />
                              </MessageAction>
                            )}
                          </MessageActionsGroup>
                        </MessageToolbar>
                      )}
                    </Message>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}
