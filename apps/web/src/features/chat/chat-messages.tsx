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

import { useMemo, useState } from "react";
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
import { ProcessActivityGroup, type ProcessTimelineItem } from "./process-activity-group.js";
import { DiffCard, type FileChangeSummary } from "./diff-card.js";
import { ChatAttachmentGallery, ImagePreviewDialog, type ChatAttachment } from "./chat-attachments.js";
import { ApprovalCard } from "./approval-card.js";
import { TodoCard } from "./todo-card.js";
import {
  CopyIcon,
  CheckIcon,
  RotateCcwIcon,
  SparklesIcon,
  ArrowRightIcon,
  PencilIcon,
  CornerDownLeftIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.js";
import { cn } from "../../lib/utils.js";
import type { Activity, ChatMessage } from "./chat-types.js";
import type { RunSnapshot } from "@deepagent/shared";

interface ChatMessagesProps {
  messages: ChatMessage[];
  activities: Activity[];
  error: string | null;
  isRunning?: boolean;
  runSnapshot?: RunSnapshot;
  onRetry?: (messageId: string) => void;
  onEditMessage?: (messageId: string, newContent: string, attachments?: ChatAttachment[]) => void;
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  decisions?: Record<string, { type: "approve" | "edit" | "reject" }>;
  onQuickPrompt?: (prompt: string) => void;
}

/** 将每轮助手过程和工具活动按事件时间合并，最终回答仍留在过程时间线之后。 */
export function buildTurnProcessTimeline(
  messages: ChatMessage[],
  activities: Activity[],
): { byFinalMessage: Map<string, ProcessTimelineItem[]>; ownedMessageIds: Set<string> } {
  const byFinalMessage = new Map<string, ProcessTimelineItem[]>();
  const ownedMessageIds = new Set<string>();
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    let start = index;
    while (start > 0 && messages[start - 1]?.role !== "user") start -= 1;
    let end = index + 1;
    while (end < messages.length && messages[end]?.role !== "user") end += 1;
    const turnMessages = messages.slice(start, end).filter((item) => item.role === "assistant");
    // 正式答复可能早于单独到达的推理增量；优先选择本轮最后一条含正文的消息，
    // 这样最终正文始终由独立消息区渲染，不会被收进可折叠过程时间线。
    const finalMessage = [...turnMessages].reverse().find((item) => item.content.trim()) ?? turnMessages.at(-1);
    if (!finalMessage || finalMessage.id !== message.id) continue;
    const runIds = new Set(turnMessages.map((item) => item.runId).filter((id): id is string => Boolean(id)));
    const firstTime = turnMessages[0]?.createdAt ?? 0;
    const nextTurnTime = messages[end]?.createdAt;
    const turnActivities = activities.filter((activity) => {
      if (activity.kind !== "tool" && activity.kind !== "subagent") return false;
      if (activity.runId && runIds.size > 0 && !runIds.has(activity.runId)) return false;
      if (!activity.runId && activity.startedAt < firstTime) return false;
      if (nextTurnTime !== undefined && activity.startedAt >= nextTurnTime) return false;
      return true;
    });
    if (turnActivities.length === 0) continue;
    const items: ProcessTimelineItem[] = [];
    for (const item of turnMessages) {
      const createdAt = item.createdAt ?? 0;
      if (item.reasoning) {
        items.push({
          id: `reasoning:${item.id}`, kind: "assistant",
          label: item.reasoningStreaming ? "正在思考" : "已完成分析",
          content: item.reasoning, startedAt: item.reasoningStartedAt ?? createdAt,
          streaming: item.reasoningStreaming,
          section: "reasoning",
        });
        if (item.id !== finalMessage.id) ownedMessageIds.add(item.id);
      }
      if (item.id !== finalMessage.id && item.content.trim()) {
        items.push({
          id: `message:${item.id}`, kind: "assistant",
          label: item.streaming ? "正在整理过程" : "已完成分析",
          content: item.content, startedAt: createdAt, streaming: item.streaming,
        });
        ownedMessageIds.add(item.id);
      }
    }
    for (const activity of turnActivities) items.push({ id: activity.id, kind: "activity", activity });
    items.sort((a, b) => {
      const at = a.kind === "assistant" ? a.startedAt : a.activity.startedAt;
      const bt = b.kind === "assistant" ? b.startedAt : b.activity.startedAt;
      return at - bt || (a.kind === "assistant" ? -1 : 1);
    });
    byFinalMessage.set(finalMessage.id, items);
  }
  return { byFinalMessage, ownedMessageIds };
}

export function findPromotedMessageId(
  messages: ChatMessage[],
  toolsByMessage: Map<string, Activity[]>,
): string | null {
  const latest = [...messages].reverse().find((item) => item.role === "assistant");
  if (!latest) return null;
  const runMessages = messages.filter((item) => item.role === "assistant" && item.runId === latest.runId && item.content.trim());
  if (runMessages.some((item) => (toolsByMessage.get(item.id) ?? []).length === 0)) return null;
  return runMessages.at(-1)?.id ?? null;
}

export function shouldHideIntermediateAssistantText(
  message: Pick<ChatMessage, "id" | "content" | "streaming">,
  toolActivities: Activity[],
  promotedId: string | null,
): boolean {
  return toolActivities.length > 0 && message.content.length > 0 && message.id !== promotedId && !message.streaming;
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

/** 格式化消息发送时间为 HH:mm 格式（例如 14:14） */
function formatMessageTime(createdAt?: number): string {
  const d = createdAt ? new Date(createdAt) : new Date();
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function ChatMessages({
  messages,
  activities,
  error: _error,
  isRunning: _isRunning = false,
  runSnapshot,
  onRetry,
  onEditMessage,
  onDecide,
  decisions,
  onQuickPrompt,
}: ChatMessagesProps) {
  // 待办计划任务
  const _todoActivity = activities.find((activity) => activity.kind === "todo");
  // 人工审批活动
  const approvals = activities.filter((activity) => activity.kind === "approval");
  // 工具调用卡片
  const _toolActivities = useMemo(() => {
    return activities.filter((activity) => activity.kind === "tool");
  }, [activities]);

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<ChatAttachment | null>(null);
  const { byFinalMessage: turnTimelineByMessage, ownedMessageIds: timelineOwnedMessageIds } = useMemo(
    () => buildTurnProcessTimeline(messages, activities),
    [messages, activities],
  );

  // 用户消息原地编辑状态
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState("");
  const [editingAttachments, setEditingAttachments] = useState<ChatAttachment[]>([]);

  const fileChanges = useMemo<FileChangeSummary[]>(() => {
    const grouped = new Map<string, FileChangeSummary>();
    for (const activity of activities) {
      if (activity.kind !== "file") continue;
      const detail = activity.detail as { path?: string; operation?: string; diff?: { additions?: number; deletions?: number; patch?: string; truncated?: boolean } } | undefined;
      if (!detail?.path || !detail.diff || typeof detail.diff.additions !== "number") continue;
      const revision = {
        additions: detail.diff.additions,
        deletions: detail.diff.deletions ?? 0,
        patch: detail.diff.patch ?? "",
        truncated: Boolean(detail.diff.truncated),
      };
      const operation = detail.operation === "edit" || detail.operation === "delete" ? detail.operation : "write";
      const existing = grouped.get(detail.path);
      if (existing) {
        existing.additions += revision.additions;
        existing.deletions += revision.deletions;
        existing.revisions.push(revision);
        existing.operation = operation;
      } else {
        grouped.set(detail.path, { path: detail.path, operation, additions: revision.additions, deletions: revision.deletions, revisions: [revision] });
      }
    }
    return [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path));
  }, [activities]);

  const handleCopy = (id: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const startEditMessage = (id: string, currentContent: string, attachments: ChatAttachment[] = []) => {
    setEditingMessageId(id);
    setEditingContent(currentContent);
    setEditingAttachments(attachments);
  };

  const handleSaveEdit = (messageId: string) => {
    const trimmed = editingContent.trim();
    if (trimmed && onEditMessage) {
      const message = messages.find((item) => item.id === messageId);
      onEditMessage(messageId, trimmed, editingAttachments.length ? editingAttachments : message?.attachments);
    }
    setEditingMessageId(null);
  };

  return (
    <Conversation className="min-h-0 flex-1 bg-black">
      <ConversationContent className="mx-auto w-full max-w-3xl px-0 py-8">
        {messages.length === 0 ? (
          /* 空状态引导区 */
          <div className="flex h-full min-h-[360px] flex-col items-center justify-center text-center">
            <div className="mb-4 flex size-12 items-center justify-center rounded-2xl bg-zinc-900 border border-zinc-800 text-zinc-300 shadow-inner">
              <SparklesIcon className="size-6 text-zinc-100" />
            </div>
            {(() => {
              const hour = new Date().getHours();
              let greetingTitle: string;
              let greetingDesc: string;
              if (hour >= 5 && hour < 9) {
                greetingTitle = "早上好呀！";
                greetingDesc = "新的一天开始啦，今天想一起做些什么呢？";
              } else if (hour >= 9 && hour < 12) {
                greetingTitle = "上午好！";
                greetingDesc = "保持专注与好心情，有什么任务或灵感随时告诉我。";
              } else if (hour >= 12 && hour < 14) {
                greetingTitle = "中午好！";
                greetingDesc = "忙碌了一上午，记得适度休息、按时吃顿午餐哦。";
              } else if (hour >= 14 && hour < 18) {
                greetingTitle = "下午好！";
                greetingDesc = "喝杯水稍作休息，今天也辛苦啦，继续为你提供全方位协助。";
              } else if (hour >= 18 && hour < 23) {
                greetingTitle = "晚上好！";
                greetingDesc = "今天辛苦啦！放松一下心情，或者整理沉淀一下今天的成果吧。";
              } else {
                greetingTitle = "夜深了！";
                greetingDesc = "夜深人静啦，注意早点休息哦，明天又是充实而美好的一天。";
              }
              return (
                <>
                  <h2 className="mb-2 text-xl font-semibold text-zinc-100 tracking-tight">
                    {greetingTitle}
                  </h2>
                  <p className="mb-6 max-w-md text-[13.5px] text-zinc-400">
                    {greetingDesc}
                  </p>
                </>
              );
            })()}

            <div className="grid w-full max-w-xl grid-cols-1 gap-2 text-left sm:grid-cols-2">
              {[
                { label: "查看工作区文件", prompt: "查看当前工作区目录下的所有文件并说明用途。" },
                { label: "分析项目结构", prompt: "分析当前工作区的技术栈、入口文件、主要模块和模块之间的调用关系，只做分析，先不要修改文件。" },
                { label: "搜索代码与配置", prompt: "在当前工作区搜索与我指定功能相关的代码和配置，列出文件路径、关键实现和调用关系。" },
                { label: "规划待办任务", prompt: "根据当前工作区的现状规划实现目标所需的待办清单，拆分为可执行步骤，先不要执行。" },
                { label: "实现功能需求", prompt: "先检查当前工作区相关代码和项目约定，再按需求实现功能，保留现有行为并总结改动。" },
                { label: "排查并修复问题", prompt: "检查当前工作区中与问题相关的实现，定位原因，做最小范围修复，并说明验证结果。" },
                { label: "创建或更新文档", prompt: "阅读当前工作区的实现和现有文档，创建或更新中文 Markdown 使用说明，确保内容与代码一致。" },
                { label: "检查环境与 Git 状态", prompt: "检查当前工作区的运行环境和 Git 工作区状态，汇总 Node.js、包管理器、当前分支和未提交改动；不要修改文件。" },
              ].map((item) => (
                <button
                  key={item.label}
                  type="button"
                  onClick={() => onQuickPrompt?.(item.prompt)}
                  className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 text-left text-[12.5px] text-zinc-300 transition-all hover:border-zinc-700 hover:bg-zinc-900 hover:text-white"
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
                const messageTime = formatMessageTime(message.createdAt);
                const isCopied = copiedId === message.id;

                return (
                  <div key={message.id} className="group/user flex flex-col items-end w-full">
                    {isEditing ? (
                      /* 内联编辑模式：与提示词输入框风格统一，重新发送按钮完全一致 */
                      <div className="w-full max-w-[85%] rounded-2xl border border-zinc-700/80 bg-zinc-900 p-3.5 shadow-xl">
                        <ChatAttachmentGallery files={editingAttachments} onPreview={setPreviewAttachment} />
                        <textarea
                          value={editingContent}
                          onChange={(e) => setEditingContent(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                              e.preventDefault();
                              handleSaveEdit(message.id);
                            } else if (e.key === "Escape") {
                              setEditingMessageId(null);
                            }
                          }}
                          className="w-full min-h-[75px] bg-transparent text-[14px] text-zinc-100 outline-none resize-none placeholder:text-zinc-500 leading-relaxed"
                          placeholder="重新编辑消息内容..."
                          autoFocus
                        />
                        <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-zinc-800/80">
                          <button
                            type="button"
                            onClick={() => setEditingMessageId(null)}
                            className="px-2.5 py-1 text-[12px] text-zinc-400 hover:text-zinc-200 transition-colors"
                          >
                            取消
                          </button>
                          {/* 重新发送按钮：与底部提示词输入框样式及图标完全一致 */}
                          <button
                            type="button"
                            onClick={() => handleSaveEdit(message.id)}
                            disabled={!editingContent.trim()}
                            className="size-8 rounded-lg bg-zinc-100 text-black hover:bg-white disabled:opacity-30 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors shadow-none flex items-center justify-center cursor-pointer disabled:cursor-not-allowed"
                            title="重新发送 (Enter)"
                          >
                            <CornerDownLeftIcon className="size-4" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* 普通气泡展示模式：按用户截图样式呈现（气泡 + 下方时间戳 + 复制 + 编辑） */
                      <div className="flex flex-col items-end max-w-[85%] space-y-1">
                        {/* 气泡主体 */}
                        <div className="rounded-2xl bg-zinc-900/90 px-4 py-2.5 text-[14px] text-zinc-100 shadow-sm border border-zinc-800/80">
                          <p className="whitespace-pre-wrap break-words leading-relaxed">
                            {message.content}
                          </p>
                        </div>
                        <ChatAttachmentGallery files={message.attachments ?? []} onPreview={setPreviewAttachment} />

                        {/* 气泡右下方元数据操作栏：时间戳、复制、编辑（完全对齐用户上传截图） */}
                        <div className="flex items-center gap-1.5 pt-0.5 text-zinc-400">
                          {/* 时间戳 */}
                          <span className="text-[12px] text-zinc-500 select-none tabular-nums font-normal mr-0.5">
                            {messageTime}
                          </span>

                          {/* 复制按钮 */}
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  onClick={() => handleCopy(message.id, message.content)}
                                  className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors cursor-pointer"
                                >
                                  {isCopied ? (
                                    <CheckIcon className="size-3.5 text-emerald-400" />
                                  ) : (
                                    <CopyIcon className="size-3.5" />
                                  )}
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="bottom">
                                {isCopied ? "已复制" : "复制"}
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>

                          {/* 编辑按钮（悬停弹出黑底白字 Tooltip） */}
                          {onEditMessage && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    type="button"
                                  onClick={() => startEditMessage(message.id, message.content, message.attachments)}
                                    className="flex size-6 items-center justify-center rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/80 transition-colors cursor-pointer"
                                  >
                                    <PencilIcon className="size-3.5" />
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="bottom">
                                  编辑
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
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

              const processItems = turnTimelineByMessage.get(message.id) ?? [];
              const messageIsInTimeline = timelineOwnedMessageIds.has(message.id);
              if (messageIsInTimeline && processItems.length === 0) return null;
              const reasoningText = message.reasoning ?? "";
              const reasoningIsInTimeline = processItems.some(
                (item) => item.kind === "assistant" && item.section === "reasoning" && item.id === `reasoning:${message.id}`,
              );
              const hasReasoning = reasoningText.length > 0 && !messageIsInTimeline && !reasoningIsInTimeline;
              // 严格互斥：一旦正文开始打字或思考收到结束信号，思考流锁定为已完成
              const isReasoningStreaming = message.reasoningStreaming === true;
              const hasRunningTool = currentToolActivities.some((a) => a.status === "running");

              // 严格时序铁律：思考必须完全结束（!isReasoningStreaming）且无正在运行工具，才允许流式输出正式内容
              const shouldShowMessageContent =
                !messageIsInTimeline && !isReasoningStreaming && !hasRunningTool && (message.content.length > 0 || message.streaming);

              return (
                <div key={message.id} className="flex flex-col w-full text-zinc-100 space-y-3">
                  {/* 1. 思考组件（Reasoning）：生命周期自发送时刻起全程唯一且稳定，秒表与打字内容毫秒级同步 */}
                  {(hasReasoning || (isReasoningStreaming && !messageIsInTimeline && !reasoningIsInTimeline)) ? (
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
                  <ProcessActivityGroup
                    key={`${message.id}-${message.content.trim() ? "answer" : "process"}`}
                    items={processItems}
                    finalAnswerStarted={message.content.trim().length > 0}
                    durationMs={message.runDurationMs ?? (message.runId === runSnapshot?.runId ? runSnapshot?.durationMs : undefined)}
                    runCompleted={message.runId === runSnapshot?.runId ? runSnapshot?.status === "completed" : message.runDurationMs !== undefined}
                  />

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
        {fileChanges.length > 0 && <DiffCard changes={fileChanges} />}
      </ConversationContent>
      <ConversationScrollButton />
      <ImagePreviewDialog file={previewAttachment} onOpenChange={(open) => { if (!open) setPreviewAttachment(null); }} />
    </Conversation>
  );
}
