import { useState, useEffect } from "react";
import { FileCodeIcon, SearchIcon, RefreshCwIcon, CopyIcon, CheckIcon } from "lucide-react";

interface FileViewerProps {
  initialPath?: string;
  workspaceRoot: string | null;
}

export function FileViewer({ initialPath, workspaceRoot }: FileViewerProps) {
  const [filePath, setFilePath] = useState(initialPath || "apps/web/src/App.tsx");
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [searchFilter, setSearchFilter] = useState("");

  const loadFile = async (path: string) => {
    if (!path.trim()) return;
    try {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams({ path });
      if (workspaceRoot) {
        params.set("root", workspaceRoot);
      }
      const res = await fetch(`/api/git/file-content?${params.toString()}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "读取文件失败");
      }
      setContent(data.content || "");
      setFilePath(path);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setContent("");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (initialPath) {
      void loadFile(initialPath);
    } else {
      void loadFile(filePath);
    }
  }, [initialPath]);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const lines = content.split("\n");

  return (
    <div className="flex flex-1 flex-col h-full bg-black text-zinc-200 text-xs overflow-hidden">
      {/* 顶部路径输入与操作条 */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 gap-2">
        <div className="flex flex-1 items-center gap-2 min-w-0">
          <FileCodeIcon className="size-4 text-blue-400 shrink-0" />
          <input
            type="text"
            value={filePath}
            onChange={(e) => setFilePath(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void loadFile(filePath)}
            placeholder="输入工作区相对路径并回车..."
            className="flex-1 bg-zinc-900 border border-zinc-800 rounded px-2.5 py-1 text-xs text-zinc-200 outline-none focus:border-zinc-700"
          />
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void loadFile(filePath)}
            title="重新加载"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            <RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? "已复制" : "复制代码"}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white transition-colors"
          >
            {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* 页面内行搜索 */}
      <div className="border-b border-zinc-800 bg-zinc-950/70 px-3 py-1 flex items-center gap-2">
        <SearchIcon className="size-3.5 text-zinc-500" />
        <input
          type="text"
          value={searchFilter}
          onChange={(e) => setSearchFilter(e.target.value)}
          placeholder="在当前文件中搜索行..."
          className="bg-transparent text-xs text-zinc-300 placeholder-zinc-500 outline-none w-full"
        />
      </div>

      {/* 代码内容区域 */}
      <div className="flex-1 overflow-auto p-2 font-mono text-[11px] leading-5 bg-black select-text">
        {loading ? (
          <div className="p-8 text-center text-zinc-500">正在加载文件...</div>
        ) : error ? (
          <div className="p-8 text-center text-rose-400">{error}</div>
        ) : content ? (
          lines.map((line, idx) => {
            const matches =
              searchFilter.trim() &&
              line.toLowerCase().includes(searchFilter.toLowerCase());
            return (
              <div
                key={idx}
                className={`flex hover:bg-zinc-900/50 ${
                  matches ? "bg-yellow-950/40 text-yellow-200" : ""
                }`}
              >
                <span className="w-10 shrink-0 text-right pr-3 text-zinc-600 select-none border-r border-zinc-900">
                  {idx + 1}
                </span>
                <span className="flex-1 whitespace-pre pl-3 text-zinc-300">{line}</span>
              </div>
            );
          })
        ) : (
          <div className="p-8 text-center text-zinc-500">文件为空</div>
        )}
      </div>
    </div>
  );
}
