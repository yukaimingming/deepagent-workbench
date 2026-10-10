/**
 * 对话会话管理器。
 *
 * 支持按工作区文件夹（Workspace Folders）分组管理对话历史：
 * - 纯净对齐用户设计（类似 Cursor / VSCode 分组）：每个工作区文件夹下挂载对应的聊天记录
 * - 记录并持久化自定义工作区文件夹列表
 * - 会话状态本地持久化存储（localStorage）
 * - 自动根据首条用户消息生成对话标题
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClientState } from "./client-reducer.js";

const SESSIONS_STORAGE_KEY = "deepagent_sessions_list_v2";
const WORKSPACES_STORAGE_KEY = "deepagent_workspaces_list_v2";
const SESSION_STATE_PREFIX = "deepagent_session_state_";

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  workspaceRoot: string;
  folderName: string;
}

export interface FolderGroup {
  folderPath: string;
  folderName: string;
  sessions: SessionSummary[];
}

/** 从路径提取文件夹名称。 */
export function extractFolderName(pathStr: string): string {
  if (!pathStr || pathStr.trim().length === 0) return "默认工作区";
  const normalized = pathStr.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] || normalized;
}

/** 初始空会话。 */
function createNewSessionSummary(id: string, workspaceRoot: string = "workspace"): SessionSummary {
  return {
    id,
    title: "新对话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageCount: 0,
    workspaceRoot,
    folderName: extractFolderName(workspaceRoot),
  };
}

export function useSessions(initialThreadId: string, defaultWorkspace: string = "workspace") {
  // 自定义添加的工作区文件夹路径列表
  const [customWorkspaces, setCustomWorkspaces] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(WORKSPACES_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // 忽略存储读取异常
    }
    return [defaultWorkspace];
  });

  const [sessions, setSessions] = useState<SessionSummary[]>(() => {
    try {
      const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as SessionSummary[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed;
        }
      }
    } catch {
      // 容错处理
    }
    return [createNewSessionSummary(initialThreadId, defaultWorkspace)];
  });

  const [activeSessionId, setActiveSessionId] = useState<string>(() => {
    return sessions[0]?.id ?? initialThreadId;
  });

  // 持久化工作区文件夹列表
  useEffect(() => {
    try {
      localStorage.setItem(WORKSPACES_STORAGE_KEY, JSON.stringify(customWorkspaces));
    } catch {
      // 忽略
    }
  }, [customWorkspaces]);

  // 持久化会话摘要列表
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      // 忽略
    }
  }, [sessions]);

  /** 添加或切换工作区文件夹。 */
  const addWorkspace = useCallback((folderPath: string) => {
    const trimmed = folderPath.trim();
    if (!trimmed) return;
    setCustomWorkspaces((prev) => {
      if (prev.includes(trimmed)) return prev;
      return [...prev, trimmed];
    });
  }, []);

  /** 移除工作区文件夹。 */
  const removeWorkspace = useCallback((folderPath: string) => {
    setCustomWorkspaces((prev) => prev.filter((p) => p !== folderPath));
  }, []);

  /** 读取指定会话的完整状态。 */
  const loadSessionState = useCallback((id: string): ClientState | null => {
    try {
      const raw = localStorage.getItem(`${SESSION_STATE_PREFIX}${id}`);
      if (raw) {
        return JSON.parse(raw) as ClientState;
      }
    } catch {
      // 异常时返回 null
    }
    return null;
  }, []);

  /** 保存指定会话的完整状态并同步会话摘要。 */
  const saveSessionState = useCallback(
    (id: string, state: ClientState, workspaceRoot: string = defaultWorkspace) => {
      try {
        localStorage.setItem(`${SESSION_STATE_PREFIX}${id}`, JSON.stringify(state));
      } catch {
        // 存储异常
      }

      setSessions((prev) => {
        const index = prev.findIndex((s) => s.id === id);
        const userMsg = state.messages.find((m) => m.role === "user");
        let title = "新对话";
        if (userMsg && userMsg.content) {
          title = userMsg.content.slice(0, 24).trim();
          if (userMsg.content.length > 24) title += "…";
        }

        const now = Date.now();
        const root = workspaceRoot || defaultWorkspace;
        const folder = extractFolderName(root);

        if (index >= 0) {
          const current = prev[index];
          if (!current) return prev;
          const nextTitle = current.title !== "新对话" ? current.title : title;
          if (
            current.title === nextTitle &&
            current.messageCount === state.messages.length &&
            current.workspaceRoot === root
          ) {
            return prev;
          }
          const updated: SessionSummary = {
            ...current,
            title: nextTitle,
            updatedAt: now,
            messageCount: state.messages.length,
            workspaceRoot: root,
            folderName: folder,
          };
          const next = [...prev];
          next[index] = updated;
          return next;
        }

        const newSummary: SessionSummary = {
          id,
          title,
          createdAt: now,
          updatedAt: now,
          messageCount: state.messages.length,
          workspaceRoot: root,
          folderName: folder,
        };
        return [newSummary, ...prev];
      });
    },
    [defaultWorkspace],
  );

  /** 新建会话。 */
  const createSession = useCallback((newId: string, workspaceRoot: string = defaultWorkspace): string => {
    const summary = createNewSessionSummary(newId, workspaceRoot);
    setSessions((prev) => [summary, ...prev.filter((s) => s.id !== newId)]);
    setActiveSessionId(newId);
    return newId;
  }, [defaultWorkspace]);

  /** 删除会话。 */
  const removeSession = useCallback((id: string) => {
    try {
      localStorage.removeItem(`${SESSION_STATE_PREFIX}${id}`);
    } catch {
      // 异常
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
  }, []);

  /** 重命名会话。 */
  const renameSession = useCallback((id: string, newTitle: string) => {
    const trimmed = newTitle.trim();
    if (!trimmed) return;
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, title: trimmed, updatedAt: Date.now() } : s)),
    );
  }, []);

  /** 当前激活会话所属的工作区根目录。 */
  const activeSession = useMemo(() => {
    return sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  }, [sessions, activeSessionId]);

  /** 按工作区文件夹分组后的会话列表（做严格名称与路径去重，绝对杜绝重复的workspace节点）。 */
  const groupedSessions = useMemo((): FolderGroup[] => {
    // 文件夹名称Key -> { canonicalPath, sessions }
    const groupMap = new Map<string, { canonicalPath: string; sessions: SessionSummary[] }>();

    const registerFolder = (rawPath: string) => {
      const trimmed = rawPath.trim();
      if (!trimmed) return;
      // 提取文件夹纯名称作为去重 Key（例如 "workspace"、"aiagent"、"desktop"）
      const nameKey = extractFolderName(trimmed).toLowerCase();
      const existing = groupMap.get(nameKey);
      if (existing) {
        // 优先保留具有盘符/更长路径的完整绝对路径
        if (trimmed.length > existing.canonicalPath.length) {
          existing.canonicalPath = trimmed;
        }
      } else {
        groupMap.set(nameKey, { canonicalPath: trimmed, sessions: [] });
      }
    };

    // 1. 严格按 customWorkspaces 的固定顺序注册文件夹，绝对不因当前选中的工作区改变顺序！
    for (const ws of customWorkspaces) {
      registerFolder(ws);
    }
    if (!groupMap.has("workspace")) {
      registerFolder(defaultWorkspace || "workspace");
    }

    // 2. 将会话归类到对应工作区（若有外部工作区则稳定追加至末尾）
    for (const session of sessions) {
      const root = session.workspaceRoot || defaultWorkspace || "workspace";
      const nameKey = extractFolderName(root).toLowerCase();
      let target = groupMap.get(nameKey);
      if (!target) {
        target = { canonicalPath: root, sessions: [] };
        groupMap.set(nameKey, target);
      }
      target.sessions.push(session);
    }

    // 3. 生成最终的 FolderGroup 列表：
    // 会话列表按固定的创建时间（createdAt）排序，创建后位置固定，不会因点击选择而变动跑第一位置
    const groups: FolderGroup[] = [];
    for (const { canonicalPath, sessions: sessionList } of groupMap.values()) {
      groups.push({
        folderPath: canonicalPath,
        folderName: extractFolderName(canonicalPath),
        sessions: sessionList.sort((a, b) => {
          const timeA = a.createdAt || a.updatedAt || 0;
          const timeB = b.createdAt || b.updatedAt || 0;
          return timeB - timeA;
        }),
      });
    }
    return groups;
  }, [customWorkspaces, defaultWorkspace, sessions]);

  return {
    sessions,
    groupedSessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    createSession,
    removeSession,
    renameSession,
    loadSessionState,
    saveSessionState,
    customWorkspaces,
    addWorkspace,
    removeWorkspace,
  };
}
