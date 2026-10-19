import { useEffect, useRef, useState } from "react";
import { MessageResponse } from "../../components/ai-elements/message.js";
import {
  BrainCircuitIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  ExternalLinkIcon,
  FileSearchIcon,
  GlobeIcon,
  ListTodoIcon,
  PencilLineIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Activity } from "@deepagent/shared";
import { Shimmer } from "../../components/ai-elements/shimmer.js";
import { openInWebPreview } from "../review/web-preview-events.js";

export type ProcessTimelineItem =
  | {
      id: string;
      kind: "assistant";
      label: string;
      content: string;
      startedAt: number;
      streaming?: boolean;
      section?: "reasoning";
      reasoningDuration?: number;
    }
  | {
      id: string;
      kind: "activity";
      activity: Activity;
    };

export function hasActiveProcess(items: ProcessTimelineItem[], toolActivities: Activity[] = []): boolean {
  const isActive = (activity: Activity) =>
    activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval";
  return items.some((item) => item.kind === "assistant" ? item.streaming : isActive(item.activity))
    || toolActivities.some(isActive);
}

interface ProcessActivityGroupProps {
  items: ProcessTimelineItem[];
  isActive?: boolean;
  startedAt?: number;
  finalAnswerComplete?: boolean;
  finalAnswerStreaming?: boolean;
  runCompleted?: boolean;
  durationMs?: number;
}

const TOOL_ACTIONS: Record<string, string> = {
  execute: "执行了命令",
  ls: "查看了目录",
  read_file: "分析了文件",
  write_file: "写入了文件",
  edit_file: "编辑了文件",
  write_todos: "更新了计划",
  task: "派发了子任务",
  glob: "查找了文件",
  grep: "搜索了文件",
  delete_file: "删除了文件",
  web_search: "搜索了网络",
  search_web: "搜索了网络",
};

const ACTIVE_TOOL_ACTIONS: Record<string, string> = {
  execute: "正在执行命令",
  ls: "正在查看目录",
  read_file: "正在分析文件",
  write_file: "正在写入文件",
  edit_file: "正在编辑文件",
  write_todos: "正在更新计划",
  task: "正在派发子任务",
  glob: "正在查找文件",
  grep: "正在搜索文件",
  delete_file: "正在删除文件",
  web_search: "正在搜索网络",
  search_web: "正在搜索网络",
};

export function formatElapsedDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  return `${Math.floor(totalSeconds / 60)}分${totalSeconds % 60}秒`;
}

export function getToolActionLabel(toolName: string): string {
  return TOOL_ACTIONS[toolName] ?? `调用了 ${toolName}`;
}

function toolName(activity: Activity): string {
  const detail = activity.detail as { toolName?: unknown } | undefined;
  if (typeof detail?.toolName === "string") return detail.toolName;
  return activity.title.split(" · ").at(-1) ?? activity.title;
}

function toolInputSummary(activity: Activity): string {
  const detail = activity.detail as { input?: unknown; path?: unknown } | undefined;
  if (typeof detail?.path === "string") return `文件：${detail.path}`;
  if (!detail?.input || typeof detail.input !== "object") return "";
  const input = detail.input as Record<string, unknown>;
  const get = (...keys: string[]): string => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim()) return value.trim().replace(/\s+/g, " ");
    }
    return "";
  };
  const path = get("file_path", "filePath", "path", "dir_path", "directory");
  const command = get("command", "cmd");
  const pattern = get("pattern", "regex");
  const query = get("query", "glob");
  const name = toolName(activity);
  const parts = name === "execute"
    ? [command]
    : name === "grep"
      ? [pattern, path]
      : name === "glob"
        ? [query, path]
        : [path];
  const summary = parts.filter(Boolean).join(" · ");
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

function stringifyDetail(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function detailSections(activity: Activity): Array<{ label: string; value: string }> {
  const detail = activity.detail as { input?: unknown; output?: unknown; args?: unknown } | undefined;
  const input = detail?.input ?? detail?.args;
  const sections: Array<{ label: string; value: string }> = [];
  if (input !== undefined) sections.push({ label: "输入参数", value: stringifyDetail(input) });
  if (detail?.output !== undefined) sections.push({ label: "执行结果", value: stringifyDetail(detail.output) });
  if (activity.error) sections.push({ label: "错误信息", value: activity.error });
  return sections;
}

function reasoningPreview(content: string): string {
  return content.trim().split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function isLiveActivity(activity: Activity): boolean {
  return activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval";
}

function ActionGlyph({ name, className }: { name: string; className?: string }) {
  if (name === "web_search" || name === "search_web" || name.includes("search") || name.includes("web")) {
    return <GlobeIcon className={className} />;
  }
  if (name === "execute") return <TerminalIcon className={className} />;
  if (name === "write_todos") return <PencilLineIcon className={className} />;
  if (name === "read_file" || name === "ls" || name === "grep" || name === "glob") return <FileSearchIcon className={className} />;
  if (name === "task") return <BrainCircuitIcon className={className} />;
  if (name === "delete_file") return <TriangleAlertIcon className={className} />;
  return <ListTodoIcon className={className} />;
}

export interface ExtractedSource {
  title: string;
  url: string;
  snippet?: string;
}

function extractToolSources(activity: Activity): ExtractedSource[] {
  const detail = activity.detail as { output?: unknown } | undefined;
  if (!detail?.output) return [];

  let parsed: unknown = detail.output;
  if (typeof detail.output === "string") {
    try {
      parsed = JSON.parse(detail.output);
    } catch {
      // 尝试匹配文本中的 URL
      const urlMatches = detail.output.match(/https?:\/\/[^\s"'<>]+/g);
      if (urlMatches && urlMatches.length > 0) {
        return Array.from(new Set(urlMatches)).slice(0, 4).map((url) => {
          let host = url;
          try {
            host = new URL(url).hostname;
          } catch {
            // 保留原样
          }
          return { title: host, url };
        });
      }
      return [];
    }
  }

  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.sources)) {
      return (obj.sources as unknown[])
        .filter((s): s is ExtractedSource => Boolean(s && typeof s === "object" && "url" in (s as any)))
        .slice(0, 5);
    }
  }

  return [];
}

function StreamingText({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <MessageResponse mode="static" isAnimating={Boolean(streaming)}>
      {content}
    </MessageResponse>
  );
}

function ReasoningActivity({ item }: { item: Extract<ProcessTimelineItem, { kind: "assistant" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="process-activity-enter group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 text-[13px] text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
        <BrainCircuitIcon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
        {item.streaming ? (
          <span className="shimmer shimmer-color-blue-500/60 shrink-0 font-medium">思考</span>
        ) : (
          <span className="shrink-0">思考</span>
        )}
        {!open && <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-text-muted)]">{reasoningPreview(item.content)}</span>}
        <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" />
      </summary>
      <div className="ml-[26px] mt-1.5 break-words border-l border-[var(--color-border-subtle)] pl-3 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
        <StreamingText content={item.content} streaming={item.streaming} />
      </div>
    </details>
  );
}

function ToolActivityRow({
  itemId,
  activity,
  style,
}: {
  itemId: string;
  activity: Activity;
  style: { animationDelay: string };
}) {
  const live = isLiveActivity(activity);
  const [open, setOpen] = useState(false);
  const name = toolName(activity);
  const summaryText = toolInputSummary(activity);
  const sections = detailSections(activity);
  const sources = extractToolSources(activity);
  const detail = activity.detail as { truncated?: unknown } | undefined;
  const tone = activity.status === "failed"
    ? "text-[var(--color-state-error)]"
    : activity.status === "waiting_approval"
      ? "text-[var(--color-state-warn)]"
      : "text-[var(--color-text-secondary)]";
  return (
    <div key={itemId} className={`process-activity-enter flex min-w-0 items-start gap-2 text-[13px] ${tone}`} style={style}>
      <ActionGlyph name={name} className="mt-0.5 size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
      <div className="min-w-0 flex-1">
        <details className="group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 [&::-webkit-details-marker]:hidden">
            {live ? (
              <span className="shimmer shimmer-color-blue-500/60 font-medium">{activityLabel(activity)}</span>
            ) : (
              <span>{activityLabel(activity)}</span>
            )}
            {summaryText && <code className="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--color-text-primary)]">{summaryText}</code>}
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
          {sources.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <span className="text-[11px] font-medium text-[var(--color-text-muted)]">来源引用：</span>
              {sources.map((src, idx) => (
                <button
                  key={`${src.url}-${idx}`}
                  type="button"
                  className="inline-flex max-w-[260px] items-center gap-1 truncate rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-surface-2)] px-2.5 py-0.5 text-[11px] text-[var(--color-brand)] transition-colors hover:border-[var(--color-brand)] hover:bg-[var(--color-surface-3)] cursor-pointer"
                  title={`${src.title}\n${src.url}\n(点击在右侧浏览器中预览)`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    openInWebPreview(src.url, src.title);
                  }}
                >
                  <GlobeIcon className="size-3 shrink-0 text-[var(--color-brand)]" />
                  <span className="truncate">{src.title || src.url}</span>
                  <ExternalLinkIcon className="size-2.5 shrink-0 opacity-70" />
                </button>
              ))}
            </div>
          )}
          <div className="mt-2 space-y-3">
            {sections.map((section) => (
              <section key={section.label}>
                <h4 className="mb-1 text-[11px] font-medium text-[var(--color-text-muted)]">{section.label}</h4>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-2)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--color-text-primary)]">{section.value}</pre>
              </section>
            ))}
            {detail?.truncated === true && <p className="text-[12px] text-[var(--color-text-muted)]">服务端返回的结果已截断</p>}
            {sections.length === 0 && <p className="text-[13px] text-[var(--color-text-muted)]">此工具调用没有提供可展示的参数或结果。</p>}
          </div>
        </details>
      </div>
    </div>
  );
}

function activityLabel(activity: Activity): string {
  const name = toolName(activity);
  const label = TOOL_ACTIONS[name] ?? `调用了 ${name}`;
  if (activity.status === "running" || activity.status === "pending") return ACTIVE_TOOL_ACTIONS[name] ?? `正在调用 ${name}`;
  if (activity.status === "waiting_approval") return `等待审批：${label}`;
  if (activity.status === "failed") return `${label}（失败）`;
  if (activity.status === "cancelled") return `${label}（已取消）`;
  return label;
}

export function ProcessActivityGroup({
  items,
  isActive = false,
  startedAt: runStartedAt,
  finalAnswerComplete = false,
  finalAnswerStreaming = false,
  runCompleted = false,
  durationMs,
}: ProcessActivityGroupProps) {
  const activities = items.flatMap((item) => item.kind === "activity" ? [item.activity] : []);
  const failedCount = activities.filter((activity) => activity.status === "failed").length;
  const hasStreamingMessage = items.some((item) => item.kind === "assistant" && item.streaming);

  // 终态判定：严格参考 Microsoft agent 项目
  // 1. 整轮运行已结束 (runCompleted)；
  // 2. 最终答复已完成 (finalAnswerComplete)；
  // 3. 最终答复已开始流式揭示且思考过程已结束 (finalAnswerStreaming && !hasStreamingMessage)；
  // 4. 当前会话非活跃生成中 (!isActive)。
  const isComplete = Boolean(
    runCompleted ||
    finalAnswerComplete ||
    !isActive ||
    (finalAnswerStreaming && !hasStreamingMessage)
  );

  // 当整轮已完成或正文已进入输出阶段时，activeCount 强制视为 0，杜绝状态残留导致的持续展开
  const activeCount = isComplete
    ? 0
    : activities.filter((activity) =>
        activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval",
      ).length;

  const analysisBusy =
    !isComplete &&
    (activeCount > 0 ||
      hasStreamingMessage ||
      (isActive && !finalAnswerStreaming && !finalAnswerComplete && !runCompleted));

  const settled = !analysisBusy && items.length > 0;

  // 展开与收缩策略：
  // 1. 过程进行中（思考、中间过程说明、工具调用等执行中，!settled）大时间线默认保持展开；
  // 2. 总体工具和思考执行完毕、开始正式输出最后总结正文（settled 为 true）时大时间线自动收缩；
  // 3. 用户手动点击标题栏可随时展开/收起查看详情；过渡到正式正文时重置手动状态，确保自然收缩。
  const [manualExpanded, setManualExpanded] = useState<boolean | undefined>(undefined);
  const prevSettledRef = useRef(settled);
  useEffect(() => {
    if (prevSettledRef.current !== settled) {
      prevSettledRef.current = settled;
      setManualExpanded(undefined);
    }
  }, [settled]);

  const expanded = manualExpanded ?? !settled;
  const statusLabel = isComplete ? "已完成分析" : "正在分析";

  // 提取历史活动记录中的精确起始与结束时间，推导稳定的历史耗时（完全隔离当前系统时钟）
  const itemStartTimes: number[] = [];
  const itemEndTimes: number[] = [];
  for (const item of items) {
    if (item.kind === "assistant") {
      if (typeof item.startedAt === "number" && item.startedAt > 0) {
        itemStartTimes.push(item.startedAt);
        if (typeof item.reasoningDuration === "number" && item.reasoningDuration > 0) {
          itemEndTimes.push(item.startedAt + item.reasoningDuration * 1000);
        }
      }
    } else {
      if (typeof item.activity.startedAt === "number" && item.activity.startedAt > 0) {
        itemStartTimes.push(item.activity.startedAt);
      }
      if (typeof item.activity.endedAt === "number" && item.activity.endedAt > 0) {
        itemEndTimes.push(item.activity.endedAt);
      }
    }
  }

  // 历史静态耗时秒数（历史会话加载时使用，严格隔离当前时钟）
  const historySeconds = (() => {
    if (typeof durationMs === "number" && durationMs > 0) {
      return Math.max(1, Math.floor(durationMs / 1000));
    }
    if (itemStartTimes.length > 0 && itemEndTimes.length > 0) {
      const minStart = Math.min(...itemStartTimes);
      const maxEnd = Math.max(...itemEndTimes);
      if (maxEnd >= minStart) {
        return Math.max(1, Math.floor((maxEnd - minStart) / 1000));
      }
    }
    return 1;
  })();

  // 记录本轮组件是否是以已完成状态初次挂载（历史会话）
  const isHistoryMountRef = useRef<boolean>(!isActive && settled);

  // 严格按 1 秒稳步累加的秒数计数器（实时运行时从 1 秒起步单调累加）
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(() => {
    return isHistoryMountRef.current ? historySeconds : 1;
  });

  // 分析完成时锁定的最终秒数（杜绝正文输出或整轮结束时被外部总耗时覆盖跳变！）
  const lockedSecondsRef = useRef<number | undefined>(undefined);

  // 仅在正在分析中（!isComplete）启动 1 秒步进累加定时器：严禁任何跳秒或回退
  useEffect(() => {
    if (isComplete) {
      if (lockedSecondsRef.current === undefined) {
        lockedSecondsRef.current = isHistoryMountRef.current ? historySeconds : elapsedSeconds;
      }
      return;
    }

    // 重新进入分析时重置锁定
    lockedSecondsRef.current = undefined;

    const timer = window.setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [isComplete, historySeconds, elapsedSeconds]);

  // 最终显示的秒数：分析完成态优先取定格秒数，否则取实时按秒累加值
  const displaySeconds = isComplete
    ? (lockedSecondsRef.current ?? (isHistoryMountRef.current ? historySeconds : elapsedSeconds))
    : elapsedSeconds;

  const displayDurationText = `${Math.floor(displaySeconds / 60)}分${displaySeconds % 60}秒`;

  if (items.length === 0 && !isActive) return null;

  return (
    <section className="process-group my-3 w-full text-[var(--color-text-primary)]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setManualExpanded(!expanded)}
        className="flex w-full items-center gap-2 border-b border-[var(--color-border-subtle)] py-2.5 text-left text-[15px] text-[var(--color-text-secondary)] transition-colors"
      >
        {!isComplete ? (
          <span className="text-[13px]">
            <span className="shimmer shimmer-color-blue-500/60 font-medium">{`${statusLabel}，用时 ${displayDurationText}`}</span>
          </span>
        ) : (
          <span className="text-[13px] font-medium">{statusLabel}，用时 {displayDurationText}</span>
        )}
        {failedCount > 0 && <span className="text-xs text-[var(--color-state-error)]">（{failedCount} 项失败）</span>}
        {expanded ? (
          <ChevronDownIcon className="ml-0.5 size-3.5 -rotate-180 transition-transform" />
        ) : (
          <ChevronDownIcon className="ml-0.5 size-3.5 transition-transform" />
        )}
      </button>

      {expanded && (
        <div className="flex flex-col gap-4 pt-4">
          {items.map((item, index) => {
            const staggerStyle = { animationDelay: `${Math.min(index, 8) * 45}ms` };
            if (item.kind === "assistant") {
              if (item.section === "reasoning") {
                 return <div key={item.id} style={staggerStyle}><ReasoningActivity item={item} /></div>;
              }
              return (
                <article key={item.id} className="process-activity-enter" style={staggerStyle}>
                  <div className="flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
                    {item.streaming ? (
                      <BrainCircuitIcon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
                    ) : (
                      <CheckCircle2Icon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
                    )}
                    {item.streaming ? (
                      <span className="shimmer shimmer-color-blue-500/60 font-medium">{item.label.replace(/^已完成/, "正在")}</span>
                    ) : (
                      <span>{item.label}</span>
                    )}
                  </div>
                  <p className={`mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--color-text-secondary)]${item.streaming ? " streaming-caret" : ""}`}>
                    {item.content}
                  </p>
                </article>
              );
            }

            const activity = item.activity;
            if (activity.kind === "subagent") {
              const detail = activity.detail as { name?: string; goal?: string; resultSummary?: string } | undefined;
              const label = activity.status === "completed"
                ? "完成了子任务"
                : activity.status === "failed"
                  ? "子任务执行失败"
                  : "正在执行子任务";
              const description = detail?.goal ?? detail?.name ?? activity.title;
              return (
                <div key={item.id} className="process-activity-enter text-[13px] text-[var(--color-text-secondary)]" style={staggerStyle}>
                  <div className="flex items-center gap-2.5">
                    <BrainCircuitIcon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
                    {activity.status === "running" || activity.status === "pending" ? (
                      <span className="shimmer shimmer-color-blue-500/60 font-medium">{label}</span>
                    ) : (
                      <span>{label}</span>
                    )}
                    {description && <span className="truncate">{description}</span>}
                  </div>
                  {detail?.resultSummary && (
                    <p className="ml-[26px] mt-1.5 whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--color-text-primary)]">
                      {detail.resultSummary}
                    </p>
                  )}
                </div>
              );
            }

            return <ToolActivityRow key={item.id} itemId={item.id} activity={activity} style={staggerStyle} />;
          })}
        </div>
      )}
    </section>
  );
}
