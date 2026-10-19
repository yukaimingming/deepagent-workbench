import { useState } from "react";
import { useGitReview } from "./use-git-review.js";
import { ReviewDiffView } from "./review-diff-view.js";
import { ReviewFileList } from "./review-file-list.js";
import {
  ChevronDownIcon,
  SearchIcon,
  LayoutListIcon,
  RefreshCwIcon,
  CheckIcon,
  SendIcon,
} from "lucide-react";

interface ReviewPanelProps {
  workspaceRoot: string | null;
}

export function ReviewPanel({ workspaceRoot }: ReviewPanelProps) {
  const {
    status,
    loading,
    selectedCommit,
    setSelectedCommit,
    selectedFile,
    setSelectedFile,
    currentDiff,
    diffLoading,
    commitLoading,
    refresh,
    commit,
  } = useGitReview(workspaceRoot);

  const [isCommitModalOpen, setIsCommitModalOpen] = useState(false);
  const [commitMsg, setCommitMsg] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const handleDoCommit = async () => {
    if (!commitMsg.trim()) {
      setCommitError("请输入提交说明");
      return;
    }
    setCommitError(null);
    try {
      await commit(commitMsg);
      setCommitSuccess(true);
      setCommitMsg("");
      setTimeout(() => {
        setCommitSuccess(false);
        setIsCommitModalOpen(false);
      }, 1200);
    } catch (err: unknown) {
      setCommitError(err instanceof Error ? err.message : "提交失败");
    }
  };

  const stagedFiles = status?.staged || [];
  const changesFiles = status?.changes || [];
  const commits = status?.commits || [];
  const totalChanges = stagedFiles.length + changesFiles.length;

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden bg-black text-zinc-200">
      {/* 顶部 Review 工具栏 */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3">
        {/* 左侧 Review 与 Commit 下拉选择 */}
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-zinc-300">Review</span>
          <div className="relative">
            <select
              value={selectedCommit}
              onChange={(e) => setSelectedCommit(e.target.value)}
              className="appearance-none rounded border border-zinc-800 bg-zinc-900 py-1 pl-2.5 pr-7 text-xs text-zinc-200 hover:border-zinc-700 focus:border-zinc-600 focus:outline-none"
            >
              <option value="uncommitted">
                Uncommitted ({changesFiles.length + stagedFiles.length})
              </option>
              {commits.map((c) => (
                <option key={c.hash} value={c.hash}>
                  {c.hash} {c.subject.slice(0, 24)}...
                </option>
              ))}
            </select>
            <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 size-3 text-zinc-500" />
          </div>
        </div>

        {/* 右侧蓝色 Commit 按钮与工具图标 */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsCommitModalOpen(!isCommitModalOpen)}
              className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white shadow hover:bg-blue-500 active:bg-blue-700 transition-colors"
            >
              <span>Commit</span>
              <ChevronDownIcon className="size-3" />
            </button>

            {/* Commit 提交浮层 */}
            {isCommitModalOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-72 rounded-lg border border-zinc-800 bg-zinc-900 p-3 shadow-2xl z-50 animate-in fade-in zoom-in-95">
                <div className="text-xs font-medium text-zinc-300 mb-1.5">Git 提交修改</div>
                <textarea
                  value={commitMsg}
                  onChange={(e) => setCommitMsg(e.target.value)}
                  placeholder="输入提交信息 (Commit message)..."
                  className="w-full rounded border border-zinc-700 bg-zinc-950 p-2 text-xs text-zinc-200 placeholder-zinc-500 outline-none focus:border-blue-500 resize-none h-20"
                  autoFocus
                />
                {commitError && (
                  <div className="text-[11px] text-rose-400 mt-1 leading-tight">
                    {commitError}
                  </div>
                )}
                {commitSuccess && (
                  <div className="flex items-center gap-1 text-[11px] text-emerald-400 mt-1">
                    <CheckIcon className="size-3" />
                    <span>提交成功！</span>
                  </div>
                )}
                <div className="flex justify-end gap-2 mt-2">
                  <button
                    type="button"
                    onClick={() => setIsCommitModalOpen(false)}
                    className="rounded px-2.5 py-1 text-xs text-zinc-400 hover:text-white"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={handleDoCommit}
                    disabled={commitLoading || !commitMsg.trim()}
                    className="flex items-center gap-1 rounded bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
                  >
                    <SendIcon className="size-3" />
                    <span>{commitLoading ? "提交中..." : "确认提交"}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 刷新状态 */}
          <button
            type="button"
            onClick={refresh}
            title="刷新 Git 变更"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>

          {/* 搜索开关 */}
          <button
            type="button"
            onClick={() => setShowSearch(!showSearch)}
            title="搜索文件"
            className={`rounded p-1 transition-colors ${
              showSearch
                ? "bg-zinc-800 text-white"
                : "text-zinc-400 hover:bg-zinc-800 hover:text-white"
            }`}
          >
            <SearchIcon className="size-3.5" />
          </button>
        </div>
      </div>

      {/* 搜索过滤输入框 */}
      {showSearch && (
        <div className="border-b border-zinc-800 bg-zinc-950 px-3 py-1.5 flex items-center gap-2">
          <SearchIcon className="size-3.5 text-zinc-500 shrink-0" />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="过滤文件..."
            className="w-full bg-transparent text-xs text-zinc-200 placeholder-zinc-500 outline-none"
            autoFocus
          />
          {searchTerm && (
            <button
              type="button"
              onClick={() => setSearchTerm("")}
              className="text-xs text-zinc-500 hover:text-white"
            >
              清空
            </button>
          )}
        </div>
      )}

      {/* 主工作区：左侧 Diff 详情，右侧变更文件列表 */}
      <div className="flex flex-1 min-h-0 divide-x divide-zinc-800 overflow-hidden">
        {/* 左侧 Diff 内容 */}
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          <ReviewDiffView
            file={selectedFile}
            allFiles={[...stagedFiles, ...changesFiles]}
            diff={currentDiff}
            loading={diffLoading}
            onRefresh={() => selectedFile && setSelectedFile({ ...selectedFile })}
            onSelectFile={setSelectedFile}
          />
        </div>

        {/* 右侧变更文件列表 */}
        <div className="w-56 shrink-0 h-full overflow-hidden bg-zinc-950">
          <ReviewFileList
            stagedFiles={stagedFiles}
            changesFiles={changesFiles}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            searchTerm={searchTerm}
          />
        </div>
      </div>
    </div>
  );
}
