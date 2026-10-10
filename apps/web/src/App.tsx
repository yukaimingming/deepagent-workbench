/**
 * DeepAgent 工作台主界面。
 *
 * 严格按照用户需求：
 * 1. 聊天界面样式完全对齐官网 AI Elements 例子
 * 2. 界面统一纯黑背景（bg-black），无杂乱底色
 * 3. 左侧边栏完全参考用户截图（每个文件夹下对应聊天记录，支持点击/自定义添加文件夹）
 * 4. 思考等级嵌入输入框内部底部排版
 * 5. 去掉右上角模型设置杂项
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  availableEffortsForModel,
  resolveEffortForModel,
  type ReasoningEffort,
} from "@deepagent/shared";
import { useAgentClient } from "./features/chat/use-agent-client.js";
import { ChatMessages } from "./features/chat/chat-messages.js";
import { ChatInput } from "./features/chat/chat-input.js";
import { WorkspaceSidebar } from "./features/chat/workspace-sidebar.js";
import { SettingsModal } from "./features/settings/settings-modal.js";
import { useProviderSettings } from "./features/settings/use-provider-settings.js";
import { useTheme } from "./features/settings/use-theme.js";
import { useSessions, normalizePath } from "./features/chat/use-sessions.js";
import { FolderPickerModal } from "./features/chat/folder-picker-modal.js";
import { PanelLeftIcon, AlertCircleIcon } from "lucide-react";

/** AG-UI 服务端地址：走代理或直接连接。 */
const AGENT_URL = "/agent";



export function App() {
  const settings = useProviderSettings();
  const { theme, setTheme } = useTheme();
  const {
    state,
    isRunning,
    runningThreadIds,
    allStates,
    send,
    stop,
    submitDecisions,
    newThread,
    setActiveThread,
    hasThread,
    disposeThread,
    loadState,
    setDecision,
    restoreCheckpoint,
    rollbackBeforeMessage,
  } = useAgentClient(AGENT_URL);

  const [settingsOpen, setSettingsOpen] = useState(false);

  // 侧边栏折叠/展开
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("deepagent_sidebar_open");
      return saved !== null ? saved === "true" : true;
    } catch {
      return true;
    }
  });

  const toggleSidebar = () => {
    setIsSidebarOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("deepagent_sidebar_open", String(next));
      } catch {
        // 忽略
      }
      return next;
    });
  };

  /** 当前工作区目录。若为 null 则表示单纯不在工作区的直接聊天模式。 */
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem("deepagent_current_workspace_v3");
      if (saved !== null) {
        return saved === "DIRECT_CHAT" ? null : saved;
      }
    } catch {
      // 忽略
    }
    return null;
  });

  // 持久化当前选中的工作区模式
  useEffect(() => {
    try {
      if (workspaceRoot === null || workspaceRoot.trim() === "") {
        localStorage.setItem("deepagent_current_workspace_v3", "DIRECT_CHAT");
      } else {
        localStorage.setItem("deepagent_current_workspace_v3", workspaceRoot);
      }
    } catch {
      // 忽略
    }
  }, [workspaceRoot]);

  // 会话管理器
  const sessionsManager = useSessions(state.threadId, workspaceRoot ?? "");
  const {
    sessions,
    groupedSessions,
    removeSession,
    saveSessionState,
    customWorkspaces,
    addWorkspace,
    removeWorkspace,
  } = sessionsManager;

  // 文件夹选择器弹窗状态
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

  // 会话列表的权威副本：自动保存时用来取每个会话自己的 workspaceRoot，
  // 放进 ref 是为了避免「保存 → sessions 变化 → 再次保存」的循环。
  const sessionsRef = useRef(sessionsManager.sessions);
  useEffect(() => {
    sessionsRef.current = sessionsManager.sessions;
  }, [sessionsManager.sessions]);

  /**
   * 自动保存：对所有会话（含正在后台执行的会话）做防抖持久化。
   * 这样即使某个会话在后台跑完、用户没有切回去看，内容也不会丢。
   */
  useEffect(() => {
    const entries = Object.entries(allStates);
    if (entries.length === 0) return;
    const timer = setTimeout(() => {
      for (const [threadId, threadState] of entries) {
        if (threadState.messages.length === 0 && threadState.activities.length === 0) continue;
        const sessionWorkspace =
          sessionsRef.current.find((session) => session.id === threadId)?.workspaceRoot ??
          (workspaceRoot ?? "");
        saveSessionState(threadId, threadState, sessionWorkspace);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [allStates, workspaceRoot, saveSessionState]);

  const currentModelId = settings.currentModelId;

  const effortResolution = useMemo(() => {
    if (!currentModelId) {
      return { effort: settings.effort, fallbackApplied: false, supported: availableEffortsForModel("") };
    }
    return resolveEffortForModel(currentModelId, settings.effort);
  }, [currentModelId, settings.effort]);

  const reasoningUnsupported = settings.activeProvider?.reasoning?.unsupported === true;

  useEffect(() => {
    if (effortResolution.fallbackApplied && effortResolution.effort !== settings.effort) {
      settings.setEffort(effortResolution.effort);
    }
  }, [effortResolution, settings]);

  const allAvailableModels = useMemo(() => {
    if (settings.activeProvider?.models && settings.activeProvider.models.length > 0) {
      return settings.activeProvider.models;
    }
    const set = new Set<string>();
    for (const p of settings.providers) {
      if (p.enabled) {
        for (const m of p.models) set.add(m);
      }
    }
    return Array.from(set);
  }, [settings.activeProvider, settings.providers]);

  const canSend =
    settings.activeProvider !== null && settings.activeProvider.hasApiKey && currentModelId !== null;

  const modelStatus = !settings.activeProvider
    ? "未配置提供商"
    : !settings.activeProvider.hasApiKey
      ? "未填 API Key"
      : currentModelId === null
        ? "未选择模型"
        : `${currentModelId}`;

  const modelStatusKind: "ok" | "warn" | "error" = canSend ? "ok" : "error";

  // 发送消息
  const handleSend = (content: string): void => {
    void send(content, {
      providerId: settings.activeProviderId ?? undefined,
      modelId: currentModelId ?? undefined,
      effort: effortResolution.effort,
      workspaceRoot: workspaceRoot ?? undefined,
    });
  };

  // 新建会话
  const handleNewSession = useCallback(
    (targetWorkspace?: string | null) => {
      const ws = targetWorkspace !== undefined ? targetWorkspace : workspaceRoot;
      setWorkspaceRoot(ws ?? null);
      // 如果当前已经是空会话，直接复用当前对话，不重复向列表追加多余的「新对话」
      if (state.messages.length === 0 && state.activities.length === 0) {
        sessionsManager.setActiveSessionId(state.threadId);
        return;
      }
      // 保存当前会话
      if (state.messages.length > 0 || state.activities.length > 0) {
        saveSessionState(state.threadId, state, workspaceRoot ?? "");
      }
      const newSessionId = cryptoRandomId();
      // 只切换当前视图：旧会话若正在执行，会在后台继续跑完，互不影响。
      newThread(newSessionId);
      sessionsManager.createSession(newSessionId, ws ?? "");
    },
    [workspaceRoot, state, sessionsManager, saveSessionState, newThread],
  );

  // 文件夹选择器完成选择
  const handleFolderPicked = useCallback(
    async (pickedPath: string) => {
      const trimmed = pickedPath.trim();
      if (!trimmed) return;
      try {
        await fetch("http://127.0.0.1:8787/api/workspace/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: trimmed }),
        });
      } catch {
        // 忽略
      }
      addWorkspace(trimmed);
      setWorkspaceRoot(trimmed);
      handleNewSession(trimmed);
      setIsFolderPickerOpen(false);
    },
    [addWorkspace, handleNewSession],
  );

  // 移除工作区文件夹
  const handleRemoveWorkspace = useCallback(
    (folderPath: string) => {
      removeWorkspace(folderPath);
      // 若当前选中的正好是被移除的工作区，平滑切换到其他工作区或直接聊天模式
      setWorkspaceRoot((cur) => {
        if (!cur) return null;
        if (cur === folderPath || normalizePath(cur) === normalizePath(folderPath)) {
          const remaining = customWorkspaces.filter(
            (w) => w !== folderPath && normalizePath(w) !== normalizePath(folderPath),
          );
          return remaining[0] ?? null;
        }
        return cur;
      });
    },
    [removeWorkspace, customWorkspaces],
  );

  // 切换会话
  const handleSelectSession = (id: string) => {
    if (id === state.threadId) return;
    const sessionWorkspace = sessionsRef.current.find((s) => s.id === id)?.workspaceRoot;
    setWorkspaceRoot(sessionWorkspace ? sessionWorkspace : null);
    // 目标会话若已在内存中（尤其是正在后台执行的），直接切过去看实时状态，
    // 绝不能用磁盘快照覆盖它。
    if (hasThread(id)) {
      setActiveThread(id);
      sessionsManager.setActiveSessionId(id);
      return;
    }
    // 切换前先保存当前对话
    if (state.messages.length > 0 || state.activities.length > 0) {
      saveSessionState(state.threadId, state, workspaceRoot ?? "");
    }
    const saved = sessionsManager.loadSessionState(id);
    if (saved) {
      loadState(saved);
    } else {
      setActiveThread(id);
    }
    sessionsManager.setActiveSessionId(id);
  };

  // 人工审批操作
  const handleDecide = (activityId: string, decision: "approve" | "reject"): void => {
    const interruptId = activityId.split(":")[1];
    if (interruptId) {
      setDecision(interruptId, {
        type: decision,
        message: decision === "reject" ? "用户拒绝了该操作。" : undefined,
      });
      // 用户在卡片上点击批准/拒绝后，自动触发恢复执行，避免卡在底栏等待
      setTimeout(() => {
        void submitDecisions({
          providerId: settings.activeProviderId ?? undefined,
          modelId: currentModelId ?? undefined,
          effort: effortResolution.effort,
          workspaceRoot: workspaceRoot ?? undefined,
        });
      }, 60);
    }
  };

  const handleSubmitDecisions = (): void => {
    void submitDecisions({
      providerId: settings.activeProviderId ?? undefined,
      modelId: currentModelId ?? undefined,
      effort: effortResolution.effort,
      workspaceRoot: workspaceRoot ?? undefined,
    });
  };

  const handleRetry = (messageId: string): void => {
    const index = state.messages.findIndex((message) => message.id === messageId);
    if (index <= 0) return;
    const userMessage = [...state.messages.slice(0, index)]
      .reverse()
      .find((message) => message.role === "user");
    if (!userMessage) return;
    restoreCheckpoint(userMessage.id);
    handleSend(userMessage.content);
  };

  const handleEditMessage = (messageId: string, newContent: string): void => {
    rollbackBeforeMessage(messageId);
    handleSend(newContent);
  };

  useEffect(() => {
    (window as unknown as { __deepagentTestHooks?: unknown }).__deepagentTestHooks = {
      getState: () => state,
      loadState,
      handleSend,
      handleEditMessage,
      handleNewSession,
      sessionsManager,
    };
  }, [state, loadState, handleSend, handleNewSession, sessionsManager]);

  const hasDecisions = Object.keys(state.pendingDecisions).length > 0;
  const pendingInterrupts = state.run.interrupts;

  const currentSession = sessions.find((s) => s.id === state.threadId);
  const currentTitle = currentSession?.title || "新对话";

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-black text-zinc-100 antialiased">
      {/* 左侧边栏（完全参考用户截图设计） */}
      <WorkspaceSidebar
        isOpen={isSidebarOpen}
        onToggle={toggleSidebar}
        selected={workspaceRoot}
        onSelect={(path) => setWorkspaceRoot(path)}
        onNewSession={handleNewSession}
        sessions={sessions}
        groupedSessions={groupedSessions}
        activeSessionId={state.threadId}
        runningSessionIds={runningThreadIds}
        onSelectSession={handleSelectSession}
        onRemoveSession={(id) => {
          removeSession(id);
          // 释放该会话的运行时（会中止其后台运行并切换到其它可用会话）。
          disposeThread(id);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onAddWorkspace={addWorkspace}
        onRemoveWorkspace={handleRemoveWorkspace}
        onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
      />

      {/* 右侧主聊天区 */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-black">
        {/* 顶部 Header：极致极简，去掉右上角设置等杂项 */}
        <header className="flex h-12 shrink-0 items-center justify-between px-4 border-b border-zinc-800/40 bg-black">
          <div className="flex items-center gap-2.5 min-w-0">
            {!isSidebarOpen && (
              <button
                type="button"
                onClick={toggleSidebar}
                title="展开侧边栏"
                aria-label="展开侧边栏"
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
              >
                <PanelLeftIcon className="size-4" />
              </button>
            )}

            <h1 className="truncate text-[13px] font-medium text-zinc-300" title={currentTitle}>
              {currentTitle}
            </h1>
          </div>

          {/* 右上角保持干净，仅展示微小的运行中提示（若有） */}
          <div className="flex items-center gap-2">
            {runningThreadIds.length > 0 && (
              <div className="flex items-center gap-1.5 text-[11px] text-zinc-400">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span>
                  {isRunning
                    ? state.run.progressNote || "运行中"
                    : `${runningThreadIds.length} 个会话在后台运行`}
                </span>
              </div>
            )}
          </div>
        </header>

        {/* 聊天消息区 */}
        <section className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-black">
          <ChatMessages
            messages={state.messages}
            activities={state.activities}
            error={state.run.error}
            isRunning={isRunning}
            onRetry={handleRetry}
            onEditMessage={handleEditMessage}
            onDecide={handleDecide}
            decisions={state.pendingDecisions}
            onQuickPrompt={handleSend}
          />

          {/* 人工审批通知栏 */}
          {pendingInterrupts.length > 0 ? (
            <div className="shrink-0 border-t border-amber-900/60 bg-amber-950/30 px-4 py-2.5">
              <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
                <div className="flex items-center gap-2 text-amber-300 text-[12px]">
                  <AlertCircleIcon className="size-4 shrink-0" />
                  <span>
                    需人工确认：{pendingInterrupts.length} 项敏感操作
                    {hasDecisions ? "（已选择决策）" : ""}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleSubmitDecisions}
                  disabled={!hasDecisions || isRunning}
                  className="rounded bg-amber-500 hover:bg-amber-400 px-3 py-1 text-[12px] font-semibold text-black transition-colors disabled:opacity-40"
                >
                  继续执行
                </button>
              </div>
            </div>
          ) : null}

          {/* 底部输入框（支持输入框上方对齐的工作区下拉选择、模型下拉选择与思考等级） */}
          <ChatInput
            onSend={handleSend}
            onStop={() => void stop()}
            isRunning={isRunning}
            effort={effortResolution.effort}
            onEffortChange={(value: ReasoningEffort) => settings.setEffort(value)}
            supportedEfforts={effortResolution.supported}
            reasoningUnsupported={reasoningUnsupported}
            fallbackApplied={effortResolution.fallbackApplied}
            modelStatus={modelStatus}
            modelStatusKind={modelStatusKind}
            disabled={!canSend}
            availableModels={allAvailableModels}
            currentModel={currentModelId}
            onSelectModel={(model: string) => settings.setActiveModelId(model)}
            onOpenSettings={() => setSettingsOpen(true)}
            workspaceRoot={workspaceRoot}
            customWorkspaces={customWorkspaces}
            onSelectWorkspace={(path) => {
              setWorkspaceRoot(path);
              if (state.messages.length === 0 && state.activities.length === 0) {
                saveSessionState(state.threadId, state, path ?? "");
              }
            }}
            onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
          />
        </section>
      </div>

      {/* 文件夹选择弹窗 */}
      <FolderPickerModal
        open={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        onSelect={handleFolderPicked}
        initialPath={workspaceRoot || undefined}
      />

      {/* 模型设置弹窗 */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        providers={settings.providers}
        loading={settings.loading}
        onSave={settings.save}
        onRemove={settings.remove}
        onFetchModels={settings.fetchModelList}
        onTest={settings.testConnection}
        onAddModel={settings.addModel}
        draftFor={settings.draftFor}
        activeProviderId={settings.activeProviderId}
        onSelectProvider={settings.setActiveProviderId}
        theme={theme}
        onThemeChange={setTheme}
      />
    </div>
  );
}

function cryptoRandomId(): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export { Fragment };
