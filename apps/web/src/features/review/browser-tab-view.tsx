import { useState, useEffect } from "react";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
  WebPreviewBody,
} from "../../components/ai-elements/web-preview.js";
import {
  RotateCwIcon,
  ExternalLinkIcon,
  CopyIcon,
  CheckIcon,
  GlobeIcon,
  ShieldAlertIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
} from "lucide-react";

interface BrowserTabViewProps {
  initialUrl?: string;
}

export function BrowserTabView({ initialUrl = "https://www.bing.com" }: BrowserTabViewProps) {
  const [currentUrl, setCurrentUrl] = useState<string>(initialUrl);
  const [iframeKey, setIframeKey] = useState<number>(1);
  const [copied, setCopied] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [history, setHistory] = useState<string[]>([initialUrl]);
  const [historyIndex, setHistoryIndex] = useState<number>(0);

  // 当外部 initialUrl 发生变化时同步更新
  useEffect(() => {
    if (initialUrl && initialUrl !== currentUrl) {
      setCurrentUrl(initialUrl);
      setIsLoading(true);
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), initialUrl]);
      setHistoryIndex((prev) => prev + 1);
      setIframeKey((prev) => prev + 1);
    }
  }, [initialUrl]);

  const handleNavigate = (newUrl: string) => {
    let formatted = newUrl.trim();
    if (!formatted) return;
    if (!formatted.startsWith("http://") && !formatted.startsWith("https://")) {
      formatted = `https://${formatted}`;
    }
    setCurrentUrl(formatted);
    setIsLoading(true);
    setHistory((prev) => [...prev.slice(0, historyIndex + 1), formatted]);
    setHistoryIndex((prev) => prev + 1);
    setIframeKey((prev) => prev + 1);
  };

  const handleRefresh = () => {
    setIsLoading(true);
    setIframeKey((prev) => prev + 1);
  };

  const handleBack = () => {
    if (historyIndex > 0) {
      const prevUrl = history[historyIndex - 1];
      if (prevUrl) {
        setHistoryIndex(historyIndex - 1);
        setCurrentUrl(prevUrl);
        setIsLoading(true);
        setIframeKey((prev) => prev + 1);
      }
    }
  };

  const handleForward = () => {
    if (historyIndex < history.length - 1) {
      const nextUrl = history[historyIndex + 1];
      if (nextUrl) {
        setHistoryIndex(historyIndex + 1);
        setCurrentUrl(nextUrl);
        setIsLoading(true);
        setIframeKey((prev) => prev + 1);
      }
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(currentUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略复制失败
    }
  };

  const handleOpenExternal = () => {
    if (currentUrl) {
      window.open(currentUrl, "_blank", "noopener,noreferrer");
    }
  };

  const getEffectiveSrc = (rawUrl: string) => {
    if (!rawUrl) return "";
    if (rawUrl.startsWith("http://127.0.0.1") || rawUrl.startsWith("http://localhost") || rawUrl.startsWith("/api/")) {
      return rawUrl;
    }
    if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
      return `/api/web-preview/proxy?url=${encodeURIComponent(rawUrl)}`;
    }
    return rawUrl;
  };

  return (
    <div className="flex flex-1 flex-col size-full h-full overflow-hidden bg-black text-zinc-200">
      <WebPreview
        defaultUrl={currentUrl}
        onUrlChange={handleNavigate}
        className="flex flex-1 flex-col size-full border-0 rounded-none bg-transparent"
      >
        {/* 顶部浏览器控制导航条 */}
        <WebPreviewNavigation className="flex h-11 shrink-0 items-center gap-1.5 border-b border-zinc-800 bg-zinc-950 px-3">
          {/* 后退按钮 */}
          <WebPreviewNavigationButton
            onClick={handleBack}
            disabled={historyIndex <= 0}
            tooltip="后退"
            className="size-7 rounded-md p-0 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ArrowLeftIcon className="size-3.5" />
          </WebPreviewNavigationButton>

          {/* 前进按钮 */}
          <WebPreviewNavigationButton
            onClick={handleForward}
            disabled={historyIndex >= history.length - 1}
            tooltip="前进"
            className="size-7 rounded-md p-0 text-zinc-400 hover:bg-zinc-800 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent"
          >
            <ArrowRightIcon className="size-3.5" />
          </WebPreviewNavigationButton>

          {/* 刷新按钮 */}
          <WebPreviewNavigationButton
            onClick={handleRefresh}
            tooltip="重新加载"
            className="size-7 rounded-md p-0 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <RotateCwIcon className={`size-3.5 ${isLoading ? "animate-spin text-blue-400" : ""}`} />
          </WebPreviewNavigationButton>

          {/* 地址栏输入框 */}
          <div className="relative flex-1 min-w-0">
            <GlobeIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-zinc-500" />
            <WebPreviewUrl
              value={currentUrl}
              onChange={(e) => setCurrentUrl(e.target.value)}
              className="h-7 w-full rounded-md border border-zinc-800 bg-zinc-900/90 pl-8 pr-3 text-xs text-zinc-200 placeholder-zinc-500 shadow-none outline-none focus:border-zinc-700 focus:bg-zinc-900"
              placeholder="输入网址并回车..."
            />
          </div>

          {/* 复制 URL 按钮 */}
          <WebPreviewNavigationButton
            onClick={handleCopy}
            tooltip={copied ? "已复制网址" : "复制网址"}
            className="size-7 rounded-md p-0 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
          </WebPreviewNavigationButton>

          {/* 在新标签页打开备用按钮 */}
          <WebPreviewNavigationButton
            onClick={handleOpenExternal}
            tooltip="在新标签页中打开原网站"
            className="size-7 rounded-md p-0 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <ExternalLinkIcon className="size-3.5" />
          </WebPreviewNavigationButton>
        </WebPreviewNavigation>

        {/* 顶部加载状态条 */}
        {isLoading && (
          <div className="h-0.5 w-full overflow-hidden bg-zinc-900">
            <div className="h-full w-1/3 animate-[shimmer_1.5s_infinite] bg-blue-500" />
          </div>
        )}

        {/* 跨域安全策略说明提示条（严格对齐 Microsoft Agent 规范，位于导航条下方） */}
        <div className="flex items-center justify-between border-b border-zinc-800/80 bg-zinc-950/60 px-3 py-1.5 text-[11px] text-zinc-400 select-none">
          <div className="flex items-center gap-1.5 truncate">
            <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-500/80" />
            <span className="truncate">Webview 预览模式：若网站受 X-Frame 限制，可随时点击右侧在新标签页打开</span>
          </div>
          <button
            type="button"
            onClick={handleOpenExternal}
            className="shrink-0 text-blue-400 hover:underline cursor-pointer ml-2"
          >
            在新标签页打开 ↗
          </button>
        </div>

        {/* 主体 Webview 内容呈现区（撑满全屏高度，背景纯白避免黑边） */}
        <div className="relative flex flex-1 flex-col size-full min-h-0 bg-white">
          <WebPreviewBody
            key={iframeKey}
            src={getEffectiveSrc(currentUrl)}
            className="size-full flex-1 border-0 bg-white"
            onLoad={() => setIsLoading(false)}
          />
        </div>
      </WebPreview>
    </div>
  );
}
