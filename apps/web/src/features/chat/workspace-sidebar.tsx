/**
 * 现代化智能体工作台侧边栏。
 *
 * 严格按照用户需求：
 * - 纯黑极简底色（与官方 AI Elements 页面统一）
 * - 顶部当前工作区/项目标题，带新建对话 (+) 与添加工作区文件夹按钮 (FolderPlus)
 * - 点击“添加文件夹”弹出可视化目录选择弹窗，支持浏览、点选、新建与快捷定位
 * - 各文件夹作为分组节点展示，下面缩进排列对应的聊天会话条目
 * - 支持删除工作区文件夹功能（带删除确认操作）
 * - 会话条目前带圆形标识（选中为高亮深灰胶囊背景 + 实心白圆点，未选中为空心圆）
 * - 支持平滑展开与收缩
 */

import { useCallback, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  FolderPlusIcon,
  FolderMinusIcon,
  Trash2Icon,
  EraserIcon,
  PanelLeftCloseIcon,
  SettingsIcon,
  SearchIcon,
  AlertTriangleIcon,
  PencilIcon,
  MessageSquareIcon,
} from "lucide-react";
import { cn } from "cn";
import { Spinner } from "@/components/ui/spinner";
import type { FolderGroup, SessionSummary } from "./use-sessions.js";
import { FolderPickerModal } from "./folder-picker-modal.js";

interface WorkspaceSidebarProps {
  /** 侧边栏是否展开 */
  isOpen: boolean;
  /** 切换侧边栏展开/收起 */
  onToggle: () => void;
  /** 当前选中的工作区路径（绝对路径） */
  selected: string | null;
  /** 选择工作区路径回调 */
  onSelect: (path: string) => void;
  /** 新建会话回调 */
  onNewSession: (workspacePath?: string) => void;
  /** 会话列表 */
  sessions: SessionSummary[];
  /** 按文件夹分组的会话列表 */
  groupedSessions: FolderGroup[];
  /** 当前激活会话 ID */
  activeSessionId: string;
  /** 当前分屏右侧打开的会话 ID */
  splitSessionId?: string | null;
  /** 正在后台执行的会话 ID 列表（用于显示运行中指示） */
  runningSessionIds?: string[];
  /** 切换会话 */
  onSelectSession: (id: string) => void;
  /** 删除会话 */
  onRemoveSession: (id: string) => void;
  /** 清空指定会话的全部消息（保留会话本身） */
  onClearSession?: (id: string) => void;
  /** 打开模型设置模态框 */
  onOpenSettings: () => void;
  /** 添加工作区文件夹 */
  onAddWorkspace: (path: string) => void;
  /** 移除工作区文件夹 */
  onRemoveWorkspace: (path: string) => void;
  /** 打开文件夹选择弹窗回调 */
  onOpenFolderPicker?: () => void;
  serverUrl?: string;
}

/**
 * 格式化会话更新时间：
 * - 当天：HH:mm（例如 14:14）
 * - 跨天（同年）：M月D日
 * - 跨年：YYYY年M月D日
 */
function formatSessionTime(timestamp?: number): string {
  if (!timestamp) return "";
  const d = new Date(timestamp);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    const hours = String(d.getHours()).padStart(2, "0");
    const minutes = String(d.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

export function WorkspaceSidebar({
  isOpen,
  onToggle,
  selected,
  onSelect,
  onNewSession,
  groupedSessions,
  activeSessionId,
  splitSessionId,
  runningSessionIds,
  onSelectSession,
  onRemoveSession,
  onClearSession,
  onOpenSettings,
  onAddWorkspace,
  onRemoveWorkspace,
  onOpenFolderPicker,
}: WorkspaceSidebarProps) {
  // 控制“选择工作区文件夹”弹窗
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false);

  // 删除文件夹确认弹窗状态
  const [folderToDelete, setFolderToDelete] = useState<{ path: string; name: string } | null>(null);

  // 搜索关键字（快速过滤会话）
  const [searchQuery, setSearchQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  // 折叠/展开各文件夹的本地状态
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({});

  const toggleFolder = useCallback((folderPath: string) => {
    setCollapsedFolders((prev) => ({
      ...prev,
      [folderPath]: !prev[folderPath],
    }));
  }, []);

  /** 弹窗中完成选择工作区文件夹 */
  const handleFolderPicked = useCallback(
    async (pickedPath: string) => {
      const trimmed = pickedPath.trim();
      if (!trimmed) return;
      try {
        // 通知后端切换当前工作区
        await fetch("/api/workspace/select", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: trimmed }),
        });
      } catch {
        // 即使请求异常也同步记录在前端
      }
      onAddWorkspace(trimmed);
      onSelect(trimmed);
      onNewSession(trimmed);
      setIsFolderPickerOpen(false);
    },
    [onAddWorkspace, onSelect, onNewSession],
  );

  /** 确认从列表中移除工作区文件夹（仅取消关联，绝不删除物理磁盘文件） */
  const handleConfirmDeleteFolder = useCallback(async () => {
    if (!folderToDelete) return;
    const { path } = folderToDelete;
    // 前端直接从工作区列表中移除，绝不删除物理磁盘上的任何文件
    onRemoveWorkspace(path);
    setFolderToDelete(null);
  }, [folderToDelete, onRemoveWorkspace]);

  const orderedGroups = [...groupedSessions].sort((a, b) => Number(!a.folderPath) - Number(!b.folderPath));

  const renderSession = (session: SessionSummary) => {
    const isActive = session.id === activeSessionId;
    const isSplit = session.id === splitSessionId;
    const isSessionRunning = runningSessionIds?.includes(session.id) === true;
    return (
      <div
        key={session.id}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-deepagent-session", session.id);
          event.dataTransfer.setData("text/plain", session.id);
          event.dataTransfer.effectAllowed = "copyMove";
        }}
        onClick={() => onSelectSession(session.id)}
        className={`group/session sidebar-session-item relative flex items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] cursor-pointer transition-colors ${
          isActive || isSplit
            ? "bg-zinc-800 text-white font-medium shadow-xs"
            : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
        }`}
        data-active={isActive ? "true" : "false"}
        data-split={isSplit ? "true" : "false"}
        data-session-id={session.id}
        title="点击切换会话，或按住拖拽分屏并排显示"
      >
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          {isSessionRunning ? (
            <span title="正在执行中" className="inline-flex shrink-0">
              <Spinner className="size-3.5 text-emerald-400 shrink-0" />
            </span>
          ) : (
            <MessageSquareIcon
              className={cn(
                "size-3.5 shrink-0 transition-colors",
                isActive || isSplit
                  ? "text-zinc-200"
                  : "text-zinc-500 group-hover/session:text-zinc-300",
              )}
            />
          )}
          <span className="truncate text-[12.5px]">{session.title}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-1">
          <span className="text-[11px] text-zinc-500 tabular-nums select-none session-time">
            {formatSessionTime(session.updatedAt || session.createdAt)}
          </span>
          {onClearSession && (
            <button type="button" onClick={(event) => { event.stopPropagation(); onClearSession(session.id); }}
              className="opacity-0 group-hover/session:opacity-100 p-0.5 text-zinc-500 hover:text-amber-400 hover:bg-zinc-700/60 rounded transition-opacity"
              title="清空会话内容（保留会话）"><EraserIcon className="size-3" /></button>
          )}
          <button type="button" onClick={(event) => { event.stopPropagation(); onRemoveSession(session.id); }}
            className="opacity-0 group-hover/session:opacity-100 p-0.5 text-red-500 hover:text-red-600 hover:bg-zinc-700/60 rounded transition-opacity"
            title="删除会话"><Trash2Icon className="size-3" /></button>
        </div>
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <>
      <aside className="relative flex h-full w-[260px] shrink-0 flex-col border-r border-zinc-800/60 bg-black text-zinc-300 select-none animate-in slide-in-from-left duration-200">
        {/* ================= 顶部操作栏（去除了无用的工作区名称按钮，保留核心操作） ================= */}
        <div className="flex h-16 items-center gap-2 px-3 border-b border-zinc-800/40">
          <button type="button" onClick={() => onNewSession(selected ?? undefined)}
            className="new-chat-sidebar-button flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-xl bg-zinc-900 px-3 text-sm font-medium text-zinc-100 hover:bg-zinc-800 transition-colors">
            <PencilIcon className="size-4 shrink-0" />
            <span>新聊天</span>
          </button>
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setShowSearch((v) => !v)}
              className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              title="搜索会话"
            >
              <SearchIcon className="size-3.5" />
            </button>

            {/* 收缩侧边栏按钮 */}
            <button
              type="button"
              onClick={onToggle}
              className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              title="收缩侧边栏"
            >
              <PanelLeftCloseIcon className="size-3.5" />
            </button>
          </div>
        </div>

        {/* 搜索输入框 */}
        {showSearch && (
          <div className="px-2.5 py-2 border-b border-zinc-800/40">
            <input
              type="text"
              placeholder="搜索聊天历史..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded bg-zinc-900 px-2.5 py-1 text-[12px] text-zinc-200 placeholder:text-zinc-500 border border-zinc-700/60 focus:outline-none focus:border-zinc-500"
            />
          </div>
        )}

        {/* ================= 主体会话树（每个文件夹下面对应专属聊天记录） ================= */}
        <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4 scrollbar-thin scrollbar-thumb-zinc-800">
          <div className="sidebar-section-heading flex items-center justify-between px-2 pt-1 text-[12px] font-semibold text-zinc-400">
            <span>工作区</span>
            <button type="button" onClick={() => (onOpenFolderPicker ? onOpenFolderPicker() : setIsFolderPickerOpen(true))}
              className="sidebar-add-workspace-button rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="添加工作区"><FolderPlusIcon className="size-3.5" /></button>
          </div>
          {orderedGroups.map((group) => {
            const isCollapsed = !!collapsedFolders[group.folderPath];
            const isCurrentSelectedFolder = selected === group.folderPath;

            // 搜索过滤
            const filteredSessions = searchQuery.trim()
              ? group.sessions.filter((s) => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
              : group.sessions;

            if (searchQuery.trim() && filteredSessions.length === 0) {
              return null;
            }

            if (!group.folderPath) {
              return (
                <div key="recent-sessions" className="flex flex-col space-y-1">
                  <div className="sidebar-section-heading px-2 py-1.5 text-[12.5px] font-semibold text-zinc-400">最近</div>
                  <div className="flex flex-col space-y-0.5">
                    {filteredSessions.length > 0
                      ? filteredSessions.map(renderSession)
                      : <div className="px-2 py-2 text-[11.5px] text-zinc-500">暂无直接聊天</div>}
                  </div>
                </div>
              );
            }

            return (
              <div key={group.folderPath} className="flex flex-col space-y-1">
                {/* 文件夹分组标题行 */}
                <div className="group flex items-center justify-between px-2 py-1.5 rounded text-[12.5px] font-medium text-zinc-400 hover:text-zinc-200 cursor-pointer transition-colors">
                  <div
                    className="flex items-center gap-1.5 flex-1 min-w-0"
                    onClick={() => toggleFolder(group.folderPath)}
                  >
                    {isCollapsed ? (
                      <ChevronRightIcon className="size-3 text-zinc-500 shrink-0" />
                    ) : (
                      <ChevronDownIcon className="size-3 text-zinc-500 shrink-0" />
                    )}
                    <span
                      className={`truncate ${
                        isCurrentSelectedFolder ? "text-zinc-100 font-semibold" : ""
                      }`}
                      title={group.folderPath}
                    >
                      {group.folderName}
                    </span>
                  </div>

                  {/* 文件夹右侧悬浮快速操作：新建会话 & 删除文件夹 */}
                  <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity">
                    {/* 在此文件夹下新建会话 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(group.folderPath);
                        onNewSession(group.folderPath);
                      }}
                      className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                      title={`在 ${group.folderName} 下新建对话`}
                    >
                      <PlusIcon className="size-3" />
                    </button>

                    {/* 移除工作区文件夹按钮（仅取消关联，不删文件） */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFolderToDelete({ path: group.folderPath, name: group.folderName });
                      }}
                      className="p-1 rounded text-zinc-500 hover:text-amber-400 hover:bg-zinc-800 transition-colors"
                      title={`从工作区列表中移除 ${group.folderName}（不会删除磁盘文件）`}
                    >
                      <FolderMinusIcon className="size-3" />
                    </button>
                  </div>
                </div>

                {/* 该文件夹下的聊天会话列表（缩进展示，每项带圆圈图标） */}
                {!isCollapsed && (
                  <div className="flex flex-col space-y-0.5 pl-3">
                    {filteredSessions.length === 0 ? (
                      <div
                        onClick={() => {
                          onSelect(group.folderPath);
                          onNewSession(group.folderPath);
                        }}
                        className="flex items-center gap-2 px-2 py-1 text-[11.5px] text-zinc-600 hover:text-zinc-400 cursor-pointer rounded"
                      >
                        <span className="size-1.5 rounded-full border border-zinc-600" />
                        <span>暂无对话，点击新建</span>
                      </div>
                    ) : (
                      filteredSessions.map(renderSession)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 底部设置入口 */}
        <div className="border-t border-zinc-800/40 p-2.5">
          <button
            type="button"
            data-testid="open-settings-modal-btn"
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
          >
            <SettingsIcon className="size-4 text-zinc-500" />
            <span>设置</span>
          </button>
        </div>
      </aside>

      {/* 文件夹选择弹窗 */}
      <FolderPickerModal
        open={isFolderPickerOpen}
        onClose={() => setIsFolderPickerOpen(false)}
        onSelect={handleFolderPicked}
        initialPath={selected ?? undefined}
      />

      {/* 文件夹移除确认弹窗（仅从列表移除，绝不删除磁盘文件） */}
      {folderToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-[#09090b] p-5 shadow-2xl text-zinc-100 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 text-amber-400 mb-2.5">
              <AlertTriangleIcon className="size-5 shrink-0" />
              <h3 className="text-[14px] font-semibold text-zinc-100">确认移除工作区？</h3>
            </div>
            <p className="text-[12.5px] text-zinc-400 leading-relaxed mb-4">
              确定要将工作区 <strong className="text-zinc-200">{folderToDelete.name}</strong> 从列表中移除吗？
              <br />
              <span className="text-emerald-400 font-medium block mt-1">
                ✓ 安全说明：此操作仅从工作台移除显示，绝不会删除您物理磁盘上的任何文件。
              </span>
            </p>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setFolderToDelete(null)}
                className="px-3 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-[12px] text-zinc-300 hover:bg-zinc-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDeleteFolder()}
                className="px-3 py-1.5 rounded-lg bg-zinc-800 border border-zinc-700 text-[12px] font-medium text-zinc-200 hover:bg-zinc-700 hover:text-white transition-colors"
              >
                确认移除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
