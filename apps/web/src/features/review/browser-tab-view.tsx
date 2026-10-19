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

  return (
    <div className="flex flex-1 flex-col h-full overflow-hidden bg-black text-zinc-200">
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
            tooltip={copied ? "已复制链接" : "复制链接"}
            className="size-7 rounded-md p-0 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            {copied ? <CheckIcon className="size-3.5 text-emerald-400" /> : <CopyIcon className="size-3.5" />}
          </WebPreviewNavigationButton>

          {/* 在新标签页打开备用按钮 */}
          <WebPreviewNavigationButton
            onClick={handleOpenExternal}
            tooltip="在浏览器独立窗口打开"
            className="size-7 rounded-md p-0 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <ExternalLinkIcon className="size-3.5" />
          </WebPreviewNavigationButton>
        </WebPreviewNavigation>

        {/* 浏览器主体渲染区 */}
        <div className="relative flex-1 min-h-0 bg-zinc-950">
          <WebPreviewBody
            key={iframeKey}
            src={currentUrl}
            onLoad={() => setIsLoading(false)}
            className="size-full border-0 bg-white"
          />

          {/* 提示层：若网站有同源安全策略(X-Frame-Options)限制时的引导提示条 */}
          <div className="absolute bottom-2 right-2 left-2 flex items-center justify-between rounded-lg border border-zinc-800/80 bg-zinc-900/90 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur pointer-events-auto shadow-lg">
            <div className="flex items-center gap-1.5 truncate">
              <ShieldAlertIcon className="size-3.5 shrink-0 text-amber-400/90" />
              <span className="truncate">如部分网页因安全限制禁止被嵌入预览，可点击右侧在新窗口打开</span>
            </div>
            <button
              type="button"
              onClick={handleOpenExternal}
              className="ml-2 shrink-0 flex items-center gap-1 text-sky-400 hover:text-sky-300 font-medium underline-offset-2 hover:underline"
            >
              <span>外部打开</span>
              <ExternalLinkIcon className="size-3" />
            </button>
          </div>
        </div>
      </WebPreview>
    </div>
  );
}
