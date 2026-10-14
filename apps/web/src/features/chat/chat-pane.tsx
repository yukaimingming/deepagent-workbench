import { useMemo, useState } from "react";
import type { Activity, PermissionMode, ReasoningEffort } from "@deepagent/shared";
import type { ClientState } from "./client-reducer.js";
import { ChatMessages } from "./chat-messages.js";
import { ChatInput } from "./chat-input.js";
import { ApprovalCard } from "./approval-card.js";
import type { ChatAttachment } from "./chat-attachments.js";
import type { FileUIPart } from "ai";
import {
  AlertCircleIcon,
  Columns2Icon,
  PanelLeftIcon,
  XIcon,
} from "lucide-react";

export interface ChatPaneProps {
  paneId: "left" | "right";
  isSplit: boolean;
  sessionId: string;
  sessionTitle: string;
  state: ClientState;
  isRunning: boolean;
  runningThreadIds: string[];
  effort: ReasoningEffort;
  supportedEfforts: readonly ReasoningEffort[];
  reasoningUnsupported: boolean;
  fallbackApplied: boolean;
  requestedEffort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
  availableModels: string[];
  currentModelId?: string;
  onSelectModel: (model: string) => void;
  modelStatus?: string;
  modelStatusKind?: "ok" | "warn" | "error";
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  workspaceRoot: string | null;
  customWorkspaces: string[];
  onSelectWorkspace: (path: string | null) => void;
  onOpenFolderPicker: () => void;
  onOpenSettings: () => void;
  canSend: boolean;
  onSend: (content: string, attachments?: Array<FileUIPart & { id: string }>) => void;
  onStop: () => void;
  onRetry: (messageId: string) => void;
  onEditMessage: (messageId: string, content: string, attachments?: ChatAttachment[]) => void;
  onDecide: (activityId: string, decision: "approve" | "reject") => void;
  onSubmitDecisions: () => void;
  onCloseSplit?: () => void;
  onSwapPanes?: () => void;
  isSidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  onDropSession?: (droppedSessionId: string) => void;
}

export function ChatPane({
  paneId,
  isSplit,
  sessionTitle,
  state,
  isRunning,
  effort,
  supportedEfforts,
  reasoningUnsupported,
  fallbackApplied,
  requestedEffort,
  onEffortChange,
  availableModels,
  currentModelId,
  onSelectModel,
  modelStatus,
  modelStatusKind,
  permissionMode,
  onPermissionModeChange,
  workspaceRoot,
  customWorkspaces,
  onSelectWorkspace,
  onOpenFolderPicker,
  onOpenSettings,
  canSend,
  onSend,
  onStop,
  onRetry,
  onEditMessage,
  onDecide,
  onSubmitDecisions,
  onCloseSplit,
  onSwapPanes,
  isSidebarOpen,
  onToggleSidebar,
  onDropSession,
}: ChatPaneProps) {
  const latestTodoActivity = useMemo<Activity | null>(() => {
    const todos = state.activities.filter((activity) => activity.kind === "todo");
    return todos.reduce<Activity | null>(
      (latest, activity) => !latest || activity.startedAt >= latest.startedAt ? activity : latest,
      null,
    );
  }, [state.activities]);

  const pendingInterrupts = state.run.interrupts;
  const hasDecisions =
    pendingInterrupts.length > 0 &&
    pendingInterrupts.every((interrupt) => Boolean(state.pendingDecisions[interrupt.id]));

  // 支持向本窗格直接拖拽放置会话
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      data-testid={`chat-pane-${paneId}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("application/x-deepagent-session")) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          setIsDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragOver(false);
        const droppedId = e.dataTransfer.getData("application/x-deepagent-session");
        if (droppedId) {
          onDropSession?.(droppedId);
        }
      }}
      className={`relative flex min-w-0 flex-1 flex-col overflow-hidden bg-black ${
        isSplit ? (paneId === "left" ? "border-r border-zinc-800/80" : "") : ""
      }`}
    >
      {/* 窗格拖拽放置指示遮罩 */}
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-sky-950/40 backdrop-blur-[2px] border-2 border-dashed border-sky-400/80">
          <div className="flex items-center gap-2 rounded-xl bg-zinc-900/90 px-4 py-2 text-sm font-medium text-sky-200 shadow-xl border border-sky-600/40">
            <Columns2Icon className="size-4 text-sky-400" />
            <span>放置以在此处打开对话</span>
          </div>
        </div>
      )}

      {/* 顶部 Header */}
      <header className="flex h-12 shrink-0 items-center justify-between px-3.5 border-b border-zinc-800/40 bg-black select-none">
        <div className="flex items-center gap-2 min-w-0">
          {paneId === "left" && !isSidebarOpen && onToggleSidebar && (
            <button
              type="button"
              onClick={onToggleSidebar}
              title="展开侧边栏"
              aria-label="展开侧边栏"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <PanelLeftIcon className="size-4" />
            </button>
          )}

          <h2 className="truncate text-[13px] font-medium text-zinc-300" title={sessionTitle}>
            {sessionTitle}
          </h2>
        </div>

        {/* 右上角操作项 */}
        <div className="flex items-center gap-2 shrink-0">
          {isRunning && (
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
              <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>{state.run.progressNote || "运行中"}</span>
            </div>
          )}

          {isSplit && (
            <div className="flex items-center gap-1 ml-1">
              {paneId === "right" && onSwapPanes && (
                <button
                  type="button"
                  onClick={onSwapPanes}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors text-[11px]"
                  title="互换两栏位置"
                >
                  <Columns2Icon className="size-3.5" />
                </button>
              )}
              {onCloseSplit && (
                <button
                  type="button"
                  onClick={onCloseSplit}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
                  title="关闭此窗格"
                >
                  <XIcon className="size-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* 聊天内容与时间线 */}
      <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
        <ChatMessages
          messages={state.messages}
          activities={state.activities}
          error={state.run.error}
          isRunning={isRunning}
          runSnapshot={state.run}
          onRetry={onRetry}
          onEditMessage={onEditMessage}
          onQuickPrompt={(prompt) => onSend(prompt)}
        />

        {/* 人工审批通知栏 */}
        {pendingInterrupts.length > 0 ? (
          <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 px-4 py-3">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
              <div className="max-h-[min(32vh,20rem)] space-y-2 overflow-y-auto">
                {pendingInterrupts.map((interrupt) => {
                  const activity = state.activities.find(
                    (item) => item.kind === "approval" && item.id === `approval:${interrupt.id}`,
                  );
                  if (!activity) return null;
                  const selectedDecision = state.pendingDecisions[interrupt.id]?.type;
                  const decision =
                    selectedDecision === "approve" || selectedDecision === "reject"
                      ? selectedDecision
                      : undefined;
                  return (
                    <ApprovalCard
                      key={interrupt.id}
                      activity={activity}
                      decision={decision}
                      onDecide={onDecide}
                    />
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-zinc-200 text-[12.5px] font-medium">
                  <AlertCircleIcon className="size-4 shrink-0 text-amber-400" />
                  <span>
                    需人工确认：{pendingInterrupts.length} 项操作
                    {hasDecisions ? "（已就绪）" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onSubmitDecisions}
                  disabled={!hasDecisions || isRunning}
                  title={
                    isRunning
                      ? "正在运行中"
                      : hasDecisions
                        ? "按已选择的决策恢复执行（未选择的将按批准处理）"
                        : "请先在审批卡片中点击「批准」或「拒绝」"
                  }
                  className="rounded-md bg-zinc-100 text-black hover:bg-white px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  继续执行
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {/* 底部独立输入框 */}
        <ChatInput
          todoActivity={latestTodoActivity}
          onSend={onSend}
          onStop={onStop}
          isRunning={isRunning}
          effort={effort}
          onEffortChange={onEffortChange}
          supportedEfforts={supportedEfforts as ReasoningEffort[]}
          reasoningUnsupported={reasoningUnsupported}
          fallbackApplied={fallbackApplied}
          requestedEffort={requestedEffort}
          modelStatus={modelStatus ?? ""}
          modelStatusKind={modelStatusKind ?? "error"}
          disabled={!canSend}
          availableModels={availableModels}
          currentModel={currentModelId}
          onSelectModel={onSelectModel}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          onOpenSettings={onOpenSettings}
          workspaceRoot={workspaceRoot}
          usage={state.run.usage ?? null}
          customWorkspaces={customWorkspaces}
          onSelectWorkspace={onSelectWorkspace}
          onOpenFolderPicker={onOpenFolderPicker}
        />
      </section>
    </div>
  );
}
