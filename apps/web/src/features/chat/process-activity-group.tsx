import { useEffect, useState, type SyntheticEvent } from "react";
import { MessageResponse } from "../../components/ai-elements/message.js";
import {
  BrainCircuitIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  FileSearchIcon,
  ListTodoIcon,
  PencilLineIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type { Activity } from "@deepagent/shared";
import { Shimmer } from "../../components/ai-elements/shimmer.js";

export type ProcessTimelineItem =
  | {
      id: string;
      kind: "assistant";
      label: string;
      content: string;
      startedAt: number;
      streaming?: boolean;
      section?: "reasoning";
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

/** 执行中强制展开，结束后保持当前开合，方便继续查看刚流式出现的内容。 */
function useLiveDetailsOpen(live: boolean): [boolean, (event: SyntheticEvent<HTMLDetailsElement>) => void] {
  const [open, setOpen] = useState(live);
  const [trackedLive, setTrackedLive] = useState(live);
  if (live !== trackedLive) {
    setTrackedLive(live);
    if (live) setOpen(true);
  }
  return [open, (event) => setOpen(event.currentTarget.open)];
}

function ActionGlyph({ name, className }: { name: string; className?: string }) {
  if (name === "execute") return <TerminalIcon className={className} />;
  if (name === "write_todos") return <PencilLineIcon className={className} />;
  if (name === "read_file" || name === "ls" || name === "grep" || name === "glob") return <FileSearchIcon className={className} />;
  if (name === "task") return <BrainCircuitIcon className={className} />;
  if (name === "delete_file") return <TriangleAlertIcon className={className} />;
  return <ListTodoIcon className={className} />;
}

function StreamingText({ content, streaming }: { content: string; streaming?: boolean }) {
  return (
    <MessageResponse mode="static" isAnimating={Boolean(streaming)}>
      {content}
    </MessageResponse>
  );
}

function ReasoningActivity({ item }: { item: Extract<ProcessTimelineItem, { kind: "assistant" }> }) {
  const [open, onToggle] = useLiveDetailsOpen(Boolean(item.streaming));
  return (
    <details className="process-activity-enter group" open={open} onToggle={onToggle}>
      <summary className="flex w-full cursor-pointer list-none items-center gap-2 text-[13px] text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
        <BrainCircuitIcon className="size-[18px] w-[18px] shrink-0 text-[var(--color-text-muted)]" />
        {item.streaming ? <Shimmer as="span" duration={2} spread={3} className="shrink-0 font-medium">思考</Shimmer> : <span className="shrink-0">思考</span>}
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
  const [open, onToggle] = useLiveDetailsOpen(live);
  const name = toolName(activity);
  const summaryText = toolInputSummary(activity);
  const sections = detailSections(activity);
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
        <details className="group" open={open} onToggle={onToggle}>
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 [&::-webkit-details-marker]:hidden">
            {live ? <Shimmer as="span" duration={2} spread={3} className="font-medium">{activityLabel(activity)}</Shimmer> : <span>{activityLabel(activity)}</span>}
            {summaryText && <code className="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--color-text-primary)]">{summaryText}</code>}
            <ChevronDownIcon className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" />
          </summary>
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
  runCompleted = true,
  durationMs,
}: ProcessActivityGroupProps) {
  const [manualExpanded, setManualExpanded] = useState<boolean | undefined>(undefined);
  const expanded = manualExpanded ?? true;
  const [now, setNow] = useState(() => Date.now());

  const activities = items.flatMap((item) => item.kind === "activity" ? [item.activity] : []);
  const activeCount = activities.filter((activity) =>
    activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval",
  ).length;
  const failedCount = activities.filter((activity) => activity.status === "failed").length;
  const hasStreamingMessage = items.some((item) => item.kind === "assistant" && item.streaming);
  const isComplete = finalAnswerComplete || finalAnswerStreaming || (
    runCompleted && activeCount === 0 && !hasStreamingMessage
  );
  const startedAt = items.length > 0
    ? Math.min(...items.map((item) => item.kind === "assistant" ? item.startedAt : item.activity.startedAt))
    : runStartedAt ?? now;
  const endedAt = Math.max(startedAt, ...activities.map((activity) => activity.endedAt ?? activity.startedAt));
  const elapsedMs = isComplete
    ? durationMs ?? (finalAnswerComplete || finalAnswerStreaming ? now - startedAt : endedAt - startedAt)
    : Math.max(durationMs ?? 0, now - startedAt);
  const statusLabel = isComplete ? "已完成分析" : "正在分析";

  useEffect(() => {
    if (isComplete) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isComplete]);
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
            <Shimmer as="span" duration={2} spread={3} className="font-medium">{`${statusLabel}，用时 ${formatElapsedDuration(elapsedMs)}`}</Shimmer>
          </span>
        ) : (
          <span className="text-[13px] font-medium">{statusLabel}，用时 {formatElapsedDuration(elapsedMs)}</span>
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
                    {item.streaming ? <Shimmer as="span" duration={2} spread={3} className="font-medium">{item.label.replace(/^已完成/, "正在")}</Shimmer> : <span>{item.label}</span>}
                  </div>
                  <div className="mt-1.5 break-words text-[15px] leading-relaxed text-[var(--color-text-primary)]">
                    <StreamingText content={item.content} streaming={item.streaming} />
                  </div>
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
                    {activity.status === "running" || activity.status === "pending" ? <Shimmer as="span" duration={2} spread={3} className="font-medium">{label}</Shimmer> : <span>{label}</span>}
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
