import { useMemo, useState } from "react";
import type { GitDiffResponse, GitFileItem } from "./review-types.js";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  CheckIcon,
  ImageIcon,
  FileCodeIcon,
  RefreshCwIcon,
  LayersIcon,
} from "lucide-react";

interface ReviewDiffViewProps {
  file: GitFileItem | null;
  allFiles?: GitFileItem[];
  diff: GitDiffResponse | null;
  loading: boolean;
  onRefresh?: () => void;
  onSelectFile?: (file: GitFileItem) => void;
}

export function ReviewDiffView({
  file,
  allFiles = [],
  diff,
  loading,
  onRefresh,
  onSelectFile,
}: ReviewDiffViewProps) {
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [fallbackContent, setFallbackContent] = useState<string | null>(null);

  useMemo(() => {
    if (file && !file.isImage && (!diff?.diff || diff.diff.trim() === "")) {
      void fetch(`/api/git/file-content?path=${encodeURIComponent(file.path)}`)
        .then((r) => r.json())
        .then((data) => {
          if (data.ok && data.content) {
            setFallbackContent(data.content);
          }
        })
        .catch(() => undefined);
    } else {
      setFallbackContent(null);
    }
  }, [file, diff?.diff]);

  const handleCopyPath = () => {
    if (!file) return;
    navigator.clipboard.writeText(file.path);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  /** 解析统一 Diff 行结构 */
  const diffLines = useMemo(() => {
    if (!diff?.diff) return [];
    const lines = diff.diff
      .split("\n")
      .filter((l) => !l.startsWith("warning: in the working copy of"));
    let oldLineNum = 0;
    let newLineNum = 0;

    return lines.map((raw) => {
      if (raw.startsWith("@@")) {
        const match = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          oldLineNum = parseInt(match[1] ?? "0", 10);
          newLineNum = parseInt(match[2] ?? "0", 10);
        }
        return { type: "chunk", text: raw, oldNum: null, newNum: null };
      }

      if (raw.startsWith("+") && !raw.startsWith("+++")) {
        const curNum = newLineNum++;
        return { type: "add", text: raw.substring(1), oldNum: null, newNum: curNum };
      }

      if (raw.startsWith("-") && !raw.startsWith("---")) {
        const curNum = oldLineNum++;
        return { type: "del", text: raw.substring(1), oldNum: curNum, newNum: null };
      }

      if (raw.startsWith(" ") || raw === "") {
        const oNum = oldLineNum++;
        const nNum = newLineNum++;
        return { type: "ctx", text: raw.startsWith(" ") ? raw.substring(1) : raw, oldNum: oNum, newNum: nNum };
      }

      return { type: "meta", text: raw, oldNum: null, newNum: null };
    });
  }, [diff?.diff]);

  const addCount = diffLines.filter((l) => l.type === "add").length;
  const delCount = diffLines.filter((l) => l.type === "del").length;

  if (!file) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-zinc-500 bg-black">
        <FileCodeIcon className="size-12 stroke-[1.2] mb-3 text-zinc-600" />
        <p className="text-sm font-medium text-zinc-400">未选择任何文件</p>
        <p className="text-xs text-zinc-600 mt-1">请从右侧变更文件列表中点击选中以查看代码差异</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden bg-black text-zinc-200">
      {/* 顶部选中的文件头部 */}
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="text-zinc-400 hover:text-white"
          >
            {isExpanded ? (
              <ChevronDownIcon className="size-4" />
            ) : (
              <ChevronRightIcon className="size-4" />
            )}
          </button>

          {file.isImage ? (
            <ImageIcon className="size-4 text-purple-400 shrink-0" />
          ) : (
            <FileCodeIcon className="size-4 text-blue-400 shrink-0" />
          )}

          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-semibold text-zinc-100 truncate">{file.name}</span>
            <span className="text-[11px] text-zinc-500 truncate">{file.dir || "."}</span>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {!file.isImage && (addCount > 0 || delCount > 0) && (
            <div className="flex items-center gap-1 font-mono text-[11px]">
              {addCount > 0 && <span className="text-emerald-400">+{addCount}</span>}
              {delCount > 0 && <span className="text-rose-400">-{delCount}</span>}
            </div>
          )}

          <button
            type="button"
            onClick={handleCopyPath}
            title={copied ? "已复制路径" : "复制相对路径"}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
          </button>

          {onRefresh && (
            <button
              type="button"
              onClick={onRefresh}
              title="重新加载 Diff"
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
            >
              <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
            </button>
          )}
        </div>
      </div>

      {/* 主体渲染内容 */}
      {isExpanded && (
        <div className="flex-1 overflow-auto bg-black font-mono text-xs select-text">
          {loading ? (
            <div className="flex items-center justify-center p-8 text-zinc-500">
              <RefreshCwIcon className="size-5 animate-spin mr-2" />
              <span>正在计算代码 Diff...</span>
            </div>
          ) : file.isImage ? (
            <div className="p-6 flex flex-col items-center justify-center gap-4">
              <div className="flex items-center gap-2 text-zinc-400 text-xs">
                <LayersIcon className="size-4 text-purple-400" />
                <span>图片变更对比</span>
              </div>
              <div className="flex flex-wrap gap-4 items-center justify-center max-w-full">
                {diff?.beforeImage && (
                  <div className="flex flex-col items-center border border-zinc-800 rounded bg-zinc-950 p-2">
                    <span className="text-[10px] text-zinc-500 mb-1">修改前</span>
                    <img
                      src={`data:${diff.mimeType || "image/png"};base64,${diff.beforeImage}`}
                      alt="变更前"
                      className="max-h-64 object-contain rounded"
                    />
                  </div>
                )}
                <div className="flex flex-col items-center border border-zinc-800 rounded bg-zinc-950 p-2">
                  <span className="text-[10px] text-zinc-500 mb-1">
                    {diff?.beforeImage ? "修改后 (当前)" : "新增图片"}
                  </span>
                  {diff?.afterImage ? (
                    <img
                      src={`data:${diff.mimeType || "image/png"};base64,${diff.afterImage}`}
                      alt="当前"
                      className="max-h-64 object-contain rounded"
                    />
                  ) : (
                    <div className="p-8 text-zinc-500">暂无图片内容</div>
                  )}
                </div>
              </div>
            </div>
          ) : diffLines.length > 0 ? (
            <div className="divide-y divide-zinc-900 min-w-full inline-block">
              {diffLines.map((line, idx) => {
                if (line.type === "chunk") {
                  return (
                    <div
                      key={idx}
                      className="bg-blue-950/30 text-blue-400/80 px-4 py-1 text-[11px] font-semibold border-y border-blue-900/30 select-none"
                    >
                      {line.text}
                    </div>
                  );
                }

                if (line.type === "meta") {
                  return null;
                }

                const isAdd = line.type === "add";
                const isDel = line.type === "del";

                return (
                  <div
                    key={idx}
                    className={`flex items-stretch leading-5 transition-colors ${
                      isAdd
                        ? "bg-emerald-950/25 text-emerald-300 hover:bg-emerald-950/40"
                        : isDel
                        ? "bg-rose-950/25 text-rose-300 hover:bg-rose-950/40"
                        : "text-zinc-300 hover:bg-zinc-900/40"
                    }`}
                  >
                    {/* 旧行号 */}
                    <div className="w-10 shrink-0 text-right pr-2 text-zinc-600 select-none text-[11px] border-r border-zinc-900">
                      {line.oldNum ?? ""}
                    </div>
                    {/* 新行号 */}
                    <div className="w-10 shrink-0 text-right pr-2 text-zinc-600 select-none text-[11px] border-r border-zinc-900">
                      {line.newNum ?? ""}
                    </div>
                    {/* 符号指示符 */}
                    <div className="w-5 shrink-0 text-center select-none font-bold">
                      {isAdd ? "+" : isDel ? "-" : " "}
                    </div>
                    {/* 行代码文本 */}
                    <div className="flex-1 whitespace-pre pr-4 overflow-x-visible">
                      {line.text}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : fallbackContent ? (
            <div className="p-4 space-y-1">
              <div className="text-[11px] text-zinc-500 mb-2 select-none">
                完整文件浏览（该文件暂无未暂存的修改）：
              </div>
              {fallbackContent.split("\n").map((l, i) => (
                <div key={i} className="flex leading-5 hover:bg-zinc-900/40">
                  <span className="w-10 shrink-0 text-right pr-3 text-zinc-600 select-none text-[11px]">
                    {i + 1}
                  </span>
                  <span className="flex-1 whitespace-pre text-zinc-300">{l}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center text-zinc-500">
              {diff?.error ? `Diff 错误: ${diff.error}` : "没有检测到任何内容差异"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
