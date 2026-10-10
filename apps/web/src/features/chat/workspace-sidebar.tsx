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
  Trash2Icon,
  PanelLeftCloseIcon,
  SettingsIcon,
  SearchIcon,
  AlertTriangleIcon,
} from "lucide-react";
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
  /** 正在后台执行的会话 ID 列表（用于显示运行中指示） */
  runningSessionIds?: string[];
  /** 切换会话 */
  onSelectSession: (id: string) => void;
  /** 删除会话 */
  onRemoveSession: (id: string) => void;
  /** 打开模型设置模态框 */
  onOpenSettings: () => void;
  /** 添加工作区文件夹 */
  onAddWorkspace: (path: string) => void;
  /** 移除工作区文件夹 */
  onRemoveWorkspace: (path: string) => void;
  serverUrl?: string;
}

export function WorkspaceSidebar({
  isOpen,
  onToggle,
  selected,
  onSelect,
  onNewSession,
  groupedSessions,
  activeSessionId,
  runningSessionIds,
  onSelectSession,
  onRemoveSession,
  onOpenSettings,
  onAddWorkspace,
  onRemoveWorkspace,
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
        await fetch("http://127.0.0.1:8787/api/workspace/select", {
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

  /** 确认删除文件夹 */
  const handleConfirmDeleteFolder = useCallback(async () => {
    if (!folderToDelete) return;
    const { path } = folderToDelete;
    try {
      // 尝试调用后端删除接口
      await fetch("http://127.0.0.1:8787/api/workspace/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
    } catch {
      // 忽略网络错误
    }
    // 前端移除工作区并刷新会话
    onRemoveWorkspace(path);
    setFolderToDelete(null);
  }, [folderToDelete, onRemoveWorkspace]);

  if (!isOpen) return null;

  return (
    <>
      <aside className="relative flex h-full w-[260px] shrink-0 flex-col border-r border-zinc-800/60 bg-black text-zinc-300 select-none animate-in slide-in-from-left duration-200">
        {/* ================= 顶部工作区标题与操作栏 ================= */}
        <div className="flex h-12 items-center justify-between px-3 border-b border-zinc-800/40">
          <button
            type="button"
            onClick={() => setIsFolderPickerOpen(true)}
            className="flex items-center gap-1.5 text-[13px] font-medium text-zinc-200 hover:text-white transition-colors truncate max-w-[150px]"
            title="点击弹窗切换或浏览工作区文件夹"
          >
            <span className="truncate">{selected ? selected.split(/[\\/]/).pop() || selected : "工作区"}</span>
            <ChevronDownIcon className="size-3.5 text-zinc-500 shrink-0" />
          </button>

          <div className="flex items-center gap-0.5">
            {/* 添加文件夹按钮（弹窗选择） */}
            <button
              type="button"
              onClick={() => setIsFolderPickerOpen(true)}
              className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              title="添加工作区文件夹（弹窗浏览选择）"
            >
              <FolderPlusIcon className="size-3.5" />
            </button>

            {/* 搜索开关 */}
            <button
              type="button"
              onClick={() => setShowSearch((v) => !v)}
              className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              title="搜索会话"
            >
              <SearchIcon className="size-3.5" />
            </button>

            {/* 新建对话按钮 */}
            <button
              type="button"
              onClick={() => onNewSession(selected ?? undefined)}
              className="flex size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
              title="新建对话"
            >
              <PlusIcon className="size-4" />
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
          {groupedSessions.map((group) => {
            const isCollapsed = !!collapsedFolders[group.folderPath];
            const isCurrentSelectedFolder = selected === group.folderPath;

            // 搜索过滤
            const filteredSessions = searchQuery.trim()
              ? group.sessions.filter((s) => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
              : group.sessions;

            if (searchQuery.trim() && filteredSessions.length === 0) {
              return null;
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

                    {/* 删除文件夹按钮 */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setFolderToDelete({ path: group.folderPath, name: group.folderName });
                      }}
                      className="p-1 rounded text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 transition-colors"
                      title={`删除文件夹 ${group.folderName}`}
                    >
                      <Trash2Icon className="size-3" />
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
                      filteredSessions.map((session) => {
                        const isActive = session.id === activeSessionId;
                        const isSessionRunning = runningSessionIds?.includes(session.id) === true;
                        return (
                          <div
                            key={session.id}
                            onClick={() => {
                              onSelect(group.folderPath);
                              onSelectSession(session.id);
                            }}
                            className={`group/session relative flex items-center justify-between rounded-md px-2.5 py-1.5 text-[13px] cursor-pointer transition-colors ${
                              isActive
                                ? "bg-zinc-800 text-white font-medium shadow-xs"
                                : "text-zinc-300 hover:bg-zinc-900 hover:text-zinc-100"
                            }`}
                          >
                            {/* 左侧状态圆点：后台执行中显示绿色脉冲 */}
                            <div className="flex items-center gap-2.5 min-w-0 flex-1">
                              {isSessionRunning ? (
                                <span
                                  className="size-2 rounded-full bg-emerald-400 animate-pulse shrink-0"
                                  title="正在执行中"
                                />
                              ) : isActive ? (
                                <span className="size-2 rounded-full bg-zinc-200 shrink-0" />
                              ) : (
                                <span className="size-2 rounded-full border border-zinc-500 shrink-0" />
                              )}
                              <span className="truncate text-[12.5px]">{session.title}</span>
                              {isSessionRunning && (
                                <span className="shrink-0 text-[10.5px] text-emerald-400/80">
                                  执行中
                                </span>
                              )}
                            </div>

                            {/* 会话删除按钮 */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onRemoveSession(session.id);
                              }}
                              className="opacity-0 group-hover/session:opacity-100 p-1 text-zinc-500 hover:text-rose-400 hover:bg-zinc-700/60 rounded transition-opacity"
                              title="删除会话"
                            >
                              <Trash2Icon className="size-3" />
                            </button>
                          </div>
                        );
                      })
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
            onClick={onOpenSettings}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-[12.5px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200 transition-colors"
          >
            <SettingsIcon className="size-4 text-zinc-500" />
            <span>模型与提供商设置</span>
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

      {/* 文件夹删除确认弹窗 */}
      {folderToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-[#09090b] p-5 shadow-2xl text-zinc-100 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center gap-2.5 text-amber-400 mb-2.5">
              <AlertTriangleIcon className="size-5 shrink-0" />
              <h3 className="text-[14px] font-semibold text-zinc-100">确认删除文件夹？</h3>
            </div>
            <p className="text-[12.5px] text-zinc-400 leading-relaxed mb-4">
              确定要删除工作区文件夹 <strong className="text-zinc-200">{folderToDelete.name}</strong> 吗？
              这将移除其列表条目及关联的所有会话。
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
                className="px-3 py-1.5 rounded-lg bg-rose-600 text-[12px] font-medium text-white hover:bg-rose-500"
              >
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
