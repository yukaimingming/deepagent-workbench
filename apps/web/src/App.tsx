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
  DEFAULT_PERMISSION_MODE,
  PERMISSION_MODES,
  type PermissionMode,
  type ReasoningEffort,
} from "@deepagent/shared";
import { useAgentClient } from "./features/chat/use-agent-client.js";
import { ChatPane } from "./features/chat/chat-pane.js";
import { SplitChatView } from "./features/chat/split-chat-view.js";
import type { ClientState } from "./features/chat/client-reducer.js";
import type { ChatAttachment } from "./features/chat/chat-attachments.js";
import { WorkspaceSidebar } from "./features/chat/workspace-sidebar.js";
import { SettingsModal } from "./features/settings/settings-modal.js";
import { useProviderSettings } from "./features/settings/use-provider-settings.js";
import { useTheme } from "./features/settings/use-theme.js";
import { useSessions, normalizePath, type SessionSummary } from "./features/chat/use-sessions.js";
import { FolderPickerModal } from "./features/chat/folder-picker-modal.js";

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
    sendToThread,
    stop,
    stopThread,
    submitDecisions,
    newThread,
    setActiveThread,
    hasThread,
    disposeThread,
    loadState,
    setDecision,
    rollbackBeforeMessage,
    clearThread,
  } = useAgentClient(AGENT_URL);

  // 分屏状态管理：右侧分屏会话 ID 与比例
  const [splitSessionId, setSplitSessionId] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem("deepagent_split_session_id");
      return saved && saved.trim() ? saved : null;
    } catch {
      return null;
    }
  });

  const [splitRatio, setSplitRatio] = useState<number>(() => {
    try {
      const saved = localStorage.getItem("deepagent_split_ratio");
      if (saved) {
        const val = Number(saved);
        if (!Number.isNaN(val) && val >= 0.25 && val <= 0.75) return val;
      }
    } catch {
      // 忽略
    }
    return 0.5;
  });

  useEffect(() => {
    try {
      if (splitSessionId) {
        localStorage.setItem("deepagent_split_session_id", splitSessionId);
      } else {
        localStorage.removeItem("deepagent_split_session_id");
      }
    } catch {
      // 忽略
    }
  }, [splitSessionId]);

  useEffect(() => {
    try {
      localStorage.setItem("deepagent_split_ratio", String(splitRatio));
    } catch {
      // 忽略
    }
  }, [splitRatio]);

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
      const saved = localStorage.getItem("deepagent_langchain_workspace_v1");
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
        localStorage.setItem("deepagent_langchain_workspace_v1", "DIRECT_CHAT");
      } else {
        localStorage.setItem("deepagent_langchain_workspace_v1", workspaceRoot);
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
    clearSessionState,
    saveSessionState,
    customWorkspaces,
    addWorkspace,
    removeWorkspace,
    cacheRemoteSessionState,
    restoreRemoteIndex,
  } = sessionsManager;
  const [workbenchReady, setWorkbenchReady] = useState(false);

  // 文件夹选择器弹窗状态
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

  // 会话列表的权威副本：自动保存时用来取每个会话自己的 workspaceRoot，
  // 放进 ref 是为了避免「保存 → sessions 变化 → 再次保存」的循环。
  const sessionsRef = useRef(sessionsManager.sessions);
  useEffect(() => {
    sessionsRef.current = sessionsManager.sessions;
  }, [sessionsManager.sessions]);

  // 服务端以工作目录为边界保存工作台数据，因此改用另一个前端端口后仍可恢复。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/workbench");
        if (!response.ok) return;
        const payload = (await response.json()) as {
          workbench: {
            sessions: SessionSummary[];
            customWorkspaces: string[];
            activeSessionId: string;
            currentWorkspace: string | null;
          } | null;
        };
        if (cancelled) return;
        const savedIndex = payload.workbench;
        if (savedIndex?.sessions.length) {
          restoreRemoteIndex(savedIndex);
          setWorkspaceRoot(savedIndex.currentWorkspace);
          const activeId = savedIndex.sessions.some((session) => session.id === savedIndex.activeSessionId)
            ? savedIndex.activeSessionId
            : savedIndex.sessions[0]!.id;
          const stateResponse = await fetch(`/api/workbench/sessions/${encodeURIComponent(activeId)}`);
          if (cancelled) return;
          if (stateResponse.ok) {
            const savedState = (await stateResponse.json() as { state?: ClientState }).state;
            if (savedState) {
              cacheRemoteSessionState(activeId, savedState);
              loadState(savedState);
            } else {
              newThread(activeId);
            }
          } else {
            newThread(activeId);
          }
        } else {
          // 旧版数据按端口保存在浏览器里；首次迁移到本机服务端。
          for (const session of sessionsManager.sessions) {
            const saved = sessionsManager.loadSessionState(session.id);
            if (saved) {
              await fetch(`/api/workbench/sessions/${encodeURIComponent(session.id)}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(saved),
              });
            }
          }
        }
      } catch {
        // 后端暂不可用时仍可使用当前浏览器中已有的本地会话。
      } finally {
        if (!cancelled) setWorkbenchReady(true);
      }
    })();
    return () => { cancelled = true; };
  // 初始化只运行一次，避免页面状态变化时重放启动恢复流程。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!workbenchReady) return;
    void fetch("/api/workbench", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        sessions: sessionsManager.sessions,
        customWorkspaces: sessionsManager.customWorkspaces,
        activeSessionId: state.threadId,
        currentWorkspace: workspaceRoot,
      }),
    }).catch(() => undefined);
  }, [workbenchReady, sessionsManager.sessions, sessionsManager.customWorkspaces, state.threadId, workspaceRoot]);

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
        void fetch(`/api/workbench/sessions/${encodeURIComponent(threadId)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(threadState),
        }).catch(() => undefined);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [allStates, workspaceRoot, saveSessionState, workbenchReady]);

  const currentModelId = settings.currentModelId;

  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => {
    try {
      const saved = localStorage.getItem("deepagent_permission_mode");
      return PERMISSION_MODES.find((mode) => mode === saved) ?? DEFAULT_PERMISSION_MODE;
    } catch {
      return DEFAULT_PERMISSION_MODE;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("deepagent_permission_mode", permissionMode);
    } catch {
      // 浏览器禁用本地存储时，权限模式仍在当前页面会话内生效。
    }
  }, [permissionMode]);

  const effortResolution = useMemo(() => {
    if (!currentModelId) {
      return { effort: settings.effort, fallbackApplied: false, supported: availableEffortsForModel("") };
    }
    return resolveEffortForModel(currentModelId, settings.effort);
  }, [currentModelId, settings.effort]);

  const reasoningUnsupported = settings.activeProvider?.reasoning?.unsupported === true;

  // 注意：这里刻意不把降级后的档位回写到 settings.effort——
  // 静默回写会让「已降级」提示永远无法出现（AGENTS.md 第 8 节要求
  // 对不支持模型的降级必须显示说明）。settings.effort 保留用户的
  // 原始请求，运行实际使用 effortResolution.effort。

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
  const handleSend = useCallback(
    (content: string, attachments: ChatAttachment[] = []): void => {
      void send(content, {
        providerId: settings.activeProviderId ?? undefined,
        modelId: currentModelId ?? undefined,
        effort: effortResolution.effort,
        workspaceRoot: workspaceRoot ?? undefined,
        permissionMode,
      }, attachments);
    },
    [send, settings.activeProviderId, currentModelId, effortResolution.effort, workspaceRoot, permissionMode],
  );

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
        await fetch("/api/workspace/select", {
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
  const handleSelectSession = async (id: string) => {
    if (id === state.threadId) return;
    // 若点击的正好是右侧分屏的会话，关闭右侧分屏，主屏切换至该会话
    if (id === splitSessionId) {
      setSplitSessionId(null);
    }
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
    let saved = sessionsManager.loadSessionState(id);
    if (!saved) {
      try {
        const response = await fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`);
        if (response.ok) {
          saved = ((await response.json()) as { state?: ClientState }).state ?? null;
          if (saved) cacheRemoteSessionState(id, saved);
        }
      } catch {
        // 继续按空会话打开；已存在的本地会话不受影响。
      }
    }
    if (saved) {
      loadState(saved);
    } else {
      setActiveThread(id);
    }
    sessionsManager.setActiveSessionId(id);
  };

  // 打开分屏会话（从左侧拖拽或点击触发）
  const handleOpenSplitWithSession = useCallback(
    async (id: string) => {
      if (id === state.threadId) return; // 不与主屏相同会话分屏
      if (!hasThread(id)) {
        let saved = sessionsManager.loadSessionState(id);
        if (!saved) {
          try {
            const response = await fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`);
            if (response.ok) {
              saved = ((await response.json()) as { state?: ClientState }).state ?? null;
              if (saved) cacheRemoteSessionState(id, saved);
            }
          } catch {
            // 忽略
          }
        }
        if (saved) {
          loadState(saved, false); // activate=false，保持左侧主屏不被打乱
        } else {
          newThread(id);
        }
      }
      setSplitSessionId(id);
    },
    [state.threadId, hasThread, sessionsManager, cacheRemoteSessionState, loadState, newThread],
  );

  // 若分屏展示的会话在列表中已被删除，则右屏自动回退为 null（派生状态，避免在 effect 中触发 cascading render）
  const activeSplitSessionId = useMemo(() => {
    if (!splitSessionId) return null;
    if (sessions.length > 0 && !sessions.some((s) => s.id === splitSessionId)) {
      return null;
    }
    return splitSessionId;
  }, [splitSessionId, sessions]);

  // 关闭左侧窗格：右侧窗格的内容成为唯一的全屏窗格（关闭左边就显示右边）
  const handleCloseLeftPane = useCallback(() => {
    if (!activeSplitSessionId) return;
    const targetSessionId = activeSplitSessionId;
    setActiveThread(targetSessionId);
    sessionsManager.setActiveSessionId(targetSessionId);
    setSplitSessionId(null);
  }, [activeSplitSessionId, setActiveThread, sessionsManager]);

  // 关闭右侧窗格：左侧窗格成为唯一的全屏窗格（关闭右边就显示左边）
  const handleCloseRightPane = useCallback(() => {
    setSplitSessionId(null);
  }, []);

  // 左右分屏面板位置互换
  const handleSwapPanes = useCallback(() => {
    if (!splitSessionId) return;
    const oldLeft = state.threadId;
    const oldRight = splitSessionId;
    setActiveThread(oldRight);
    sessionsManager.setActiveSessionId(oldRight);
    setSplitSessionId(oldLeft);
  }, [splitSessionId, state.threadId, setActiveThread, sessionsManager]);

  // 人工审批操作（左屏）
  const handleDecide = (activityId: string, decision: "approve" | "reject"): void => {
    const interruptId = activityId.split(":")[1];
    if (interruptId) {
      setDecision(interruptId, {
        type: decision,
        message: decision === "reject" ? "用户拒绝了该操作。" : undefined,
      });
      setTimeout(() => {
        void submitDecisions({
          providerId: settings.activeProviderId ?? undefined,
          modelId: currentModelId ?? undefined,
          effort: effortResolution.effort,
          workspaceRoot: workspaceRoot ?? undefined,
          permissionMode,
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
      permissionMode,
    });
  };

  const handleRetry = (messageId: string): void => {
    const index = state.messages.findIndex((message) => message.id === messageId);
    if (index <= 0) return;
    const userMessage = [...state.messages.slice(0, index)]
      .reverse()
      .find((message) => message.role === "user");
    if (!userMessage) return;
    rollbackBeforeMessage(userMessage.id);
    handleSend(userMessage.content, userMessage.attachments);
  };

  const handleEditMessage = useCallback(
    (messageId: string, newContent: string, attachments: ChatAttachment[] = []): void => {
      rollbackBeforeMessage(messageId);
      handleSend(newContent, attachments);
    },
    [rollbackBeforeMessage, handleSend],
  );

  // 右屏状态计算与回调函数
  const rightState = activeSplitSessionId ? allStates[activeSplitSessionId] : undefined;
  const isRightRunning = activeSplitSessionId ? runningThreadIds.includes(activeSplitSessionId) : false;
  const rightSession = activeSplitSessionId ? sessions.find((s) => s.id === activeSplitSessionId) : undefined;
  const rightTitle = rightSession?.title || "分屏会话";
  const rightWorkspace = rightSession?.workspaceRoot ?? workspaceRoot;

  const handleSendRight = useCallback(
    (content: string, attachments: ChatAttachment[] = []): void => {
      if (!activeSplitSessionId) return;
      void sendToThread(
        activeSplitSessionId,
        content,
        {
          providerId: settings.activeProviderId ?? undefined,
          modelId: currentModelId ?? undefined,
          effort: effortResolution.effort,
          workspaceRoot: rightWorkspace ?? undefined,
          permissionMode,
        },
        attachments,
      );
    },
    [activeSplitSessionId, sendToThread, settings.activeProviderId, currentModelId, effortResolution.effort, rightWorkspace, permissionMode],
  );

  const handleStopRight = useCallback(() => {
    if (activeSplitSessionId) void stopThread(activeSplitSessionId);
  }, [activeSplitSessionId, stopThread]);

  const handleRetryRight = useCallback(
    (messageId: string): void => {
      if (!activeSplitSessionId) return;
      const tState = allStates[activeSplitSessionId];
      if (!tState) return;
      const index = tState.messages.findIndex((m) => m.id === messageId);
      if (index <= 0) return;
      const userMessage = [...tState.messages.slice(0, index)]
        .reverse()
        .find((m) => m.role === "user");
      if (!userMessage) return;
      rollbackBeforeMessage(userMessage.id, activeSplitSessionId);
      handleSendRight(userMessage.content, userMessage.attachments);
    },
    [activeSplitSessionId, allStates, rollbackBeforeMessage, handleSendRight],
  );

  const handleEditMessageRight = useCallback(
    (messageId: string, newContent: string, attachments: ChatAttachment[] = []): void => {
      if (!activeSplitSessionId) return;
      rollbackBeforeMessage(messageId, activeSplitSessionId);
      handleSendRight(newContent, attachments);
    },
    [activeSplitSessionId, rollbackBeforeMessage, handleSendRight],
  );

  const handleDecideRight = useCallback(
    (activityId: string, decision: "approve" | "reject"): void => {
      if (!activeSplitSessionId) return;
      const interruptId = activityId.split(":")[1];
      if (interruptId) {
        setDecision(
          interruptId,
          {
            type: decision,
            message: decision === "reject" ? "用户拒绝了该操作。" : undefined,
          },
          activeSplitSessionId,
        );
        setTimeout(() => {
          void submitDecisions(
            {
              providerId: settings.activeProviderId ?? undefined,
              modelId: currentModelId ?? undefined,
              effort: effortResolution.effort,
              workspaceRoot: rightWorkspace ?? undefined,
              permissionMode,
            },
            activeSplitSessionId,
          );
        }, 60);
      }
    },
    [activeSplitSessionId, setDecision, submitDecisions, settings.activeProviderId, currentModelId, effortResolution.effort, rightWorkspace, permissionMode],
  );

  const handleSubmitDecisionsRight = useCallback((): void => {
    if (!activeSplitSessionId) return;
    void submitDecisions(
      {
        providerId: settings.activeProviderId ?? undefined,
        modelId: currentModelId ?? undefined,
        effort: effortResolution.effort,
        workspaceRoot: rightWorkspace ?? undefined,
        permissionMode,
      },
      activeSplitSessionId,
    );
  }, [activeSplitSessionId, submitDecisions, settings.activeProviderId, currentModelId, effortResolution.effort, rightWorkspace, permissionMode]);

  useEffect(() => {
    (window as unknown as { __deepagentTestHooks?: unknown }).__deepagentTestHooks = {
      getState: () => state,
      getSplitState: () => (activeSplitSessionId ? allStates[activeSplitSessionId] : null),
      getSplitSessionId: () => activeSplitSessionId,
      loadState,
      handleSend,
      handleSendRight,
      handleEditMessage,
      handleNewSession,
      handleSubmitDecisions,
      handleOpenSplitWithSession,
      handleCloseSplit: handleCloseRightPane,
      handleCloseLeftPane,
      handleCloseRightPane,
      handleSwapPanes,
      sessionsManager,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, activeSplitSessionId, allStates, loadState, handleSend, handleSendRight, handleEditMessage, handleNewSession, sessionsManager]);

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
        splitSessionId={activeSplitSessionId}
        runningSessionIds={runningThreadIds}
        onSelectSession={handleSelectSession}
        onClearSession={(id) => {
          clearThread(id);
          clearSessionState(id);
          void fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
        }}
        onRemoveSession={(id) => {
          if (id === activeSplitSessionId) {
            setSplitSessionId(null);
          }
          removeSession(id);
          void fetch(`/api/workbench/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
          // 释放该会话的运行时（会中止其后台运行并切换到其它可用会话）。
          disposeThread(id);
        }}
        onOpenSettings={() => setSettingsOpen(true)}
        onAddWorkspace={addWorkspace}
        onRemoveWorkspace={handleRemoveWorkspace}
        onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
      />

      {/* 分屏与主聊天视图 */}
      <SplitChatView
        isSplit={Boolean(activeSplitSessionId && rightState)}
        splitRatio={splitRatio}
        onSplitRatioChange={setSplitRatio}
        onOpenSplitWithSession={handleOpenSplitWithSession}
        leftPane={
          <ChatPane
            paneId="left"
            isSplit={Boolean(activeSplitSessionId && rightState)}
            sessionId={state.threadId}
            sessionTitle={currentTitle}
            state={state}
            isRunning={isRunning}
            runningThreadIds={runningThreadIds}
            effort={effortResolution.effort}
            supportedEfforts={effortResolution.supported}
            reasoningUnsupported={reasoningUnsupported}
            fallbackApplied={effortResolution.fallbackApplied}
            requestedEffort={settings.effort}
            onEffortChange={(value: ReasoningEffort) => settings.setEffort(value)}
            availableModels={allAvailableModels}
            currentModelId={currentModelId ?? undefined}
            onSelectModel={(model: string) => settings.setActiveModelId(model)}
            modelStatus={modelStatus}
            modelStatusKind={modelStatusKind}
            permissionMode={permissionMode}
            onPermissionModeChange={setPermissionMode}
            workspaceRoot={workspaceRoot}
            customWorkspaces={customWorkspaces}
            onSelectWorkspace={(path) => {
              setWorkspaceRoot(path);
              if (state.messages.length === 0 && state.activities.length === 0) {
                saveSessionState(state.threadId, state, path ?? "");
              }
            }}
            onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            canSend={canSend}
            onSend={handleSend}
            onStop={() => void stop()}
            onRetry={handleRetry}
            onEditMessage={handleEditMessage}
            onDecide={handleDecide}
            onSubmitDecisions={handleSubmitDecisions}
            onCloseSplit={handleCloseLeftPane}
            onSwapPanes={handleSwapPanes}
            isSidebarOpen={isSidebarOpen}
            onToggleSidebar={toggleSidebar}
            onDropSession={(droppedId) => {
              if (droppedId !== state.threadId) {
                void handleOpenSplitWithSession(droppedId);
              }
            }}
          />
        }
        rightPane={
          activeSplitSessionId && rightState ? (
            <ChatPane
              paneId="right"
              isSplit={true}
              sessionId={activeSplitSessionId}
              sessionTitle={rightTitle}
              state={rightState}
              isRunning={isRightRunning}
              runningThreadIds={runningThreadIds}
              effort={effortResolution.effort}
              supportedEfforts={effortResolution.supported}
              reasoningUnsupported={reasoningUnsupported}
              fallbackApplied={effortResolution.fallbackApplied}
              requestedEffort={settings.effort}
              onEffortChange={(value: ReasoningEffort) => settings.setEffort(value)}
              availableModels={allAvailableModels}
              currentModelId={currentModelId ?? undefined}
              onSelectModel={(model: string) => settings.setActiveModelId(model)}
              modelStatus={modelStatus}
              modelStatusKind={modelStatusKind}
              permissionMode={permissionMode}
              onPermissionModeChange={setPermissionMode}
              workspaceRoot={rightWorkspace}
              customWorkspaces={customWorkspaces}
              onSelectWorkspace={(path) => {
                if (splitSessionId) {
                  saveSessionState(splitSessionId, rightState, path ?? "");
                }
              }}
              onOpenFolderPicker={() => setIsFolderPickerOpen(true)}
              onOpenSettings={() => setSettingsOpen(true)}
              canSend={canSend}
              onSend={handleSendRight}
              onStop={handleStopRight}
              onRetry={handleRetryRight}
              onEditMessage={handleEditMessageRight}
              onDecide={handleDecideRight}
              onSubmitDecisions={handleSubmitDecisionsRight}
              onCloseSplit={handleCloseRightPane}
              onSwapPanes={handleSwapPanes}
              onDropSession={(droppedId) => {
                if (droppedId !== splitSessionId) {
                  void handleOpenSplitWithSession(droppedId);
                }
              }}
            />
          ) : undefined
        }
      />

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
