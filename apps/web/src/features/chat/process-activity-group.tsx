import { useState } from "react";
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
import { MessageResponse } from "../../components/ai-elements/message.js";
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

interface ProcessActivityGroupProps {
  items: ProcessTimelineItem[];
  finalAnswerStarted: boolean;
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

function actionIcon(name: string) {
  if (name === "execute") return TerminalIcon;
  if (name === "write_todos") return PencilLineIcon;
  if (name === "read_file" || name === "ls" || name === "grep" || name === "glob") return FileSearchIcon;
  if (name === "task") return BrainCircuitIcon;
  if (name === "delete_file") return TriangleAlertIcon;
  return ListTodoIcon;
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
  finalAnswerStarted,
  runCompleted = true,
  durationMs,
}: ProcessActivityGroupProps) {
  const [expanded, setExpanded] = useState(!finalAnswerStarted);
  if (items.length === 0) return null;

  const activities = items.flatMap((item) => item.kind === "activity" ? [item.activity] : []);
  const activeCount = activities.filter((activity) =>
    activity.status === "running" || activity.status === "pending" || activity.status === "waiting_approval",
  ).length;
  const failedCount = activities.filter((activity) => activity.status === "failed").length;
  const hasStreamingMessage = items.some((item) => item.kind === "assistant" && item.streaming);
  const isComplete = runCompleted && activeCount === 0 && !hasStreamingMessage;
  const summary = isComplete
    ? `已完成${typeof durationMs === "number" ? `，用时 ${formatElapsedDuration(durationMs)}` : ""}`
    : activeCount > 0
      ? "正在执行"
      : "执行过程";

  return (
    <section className="process-group my-3 w-full text-[var(--color-text-primary)]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 border-b border-[var(--color-border-subtle)] py-2.5 text-left text-[15px] text-[var(--color-text-secondary)] transition-colors"
      >
        {activeCount > 0 ? (
          <Shimmer className="font-medium text-[var(--color-state-running)] [--color-foreground:var(--color-state-running)] [--color-muted-foreground:var(--color-state-running)]">
            {summary}
          </Shimmer>
        ) : (
          <span className="font-medium">{summary}</span>
        )}
        {failedCount > 0 && <span className="text-sm text-[var(--color-state-error)]">（{failedCount} 项失败）</span>}
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
                return (
                  <details key={item.id} className="process-activity-enter group" style={staggerStyle}>
                    <summary className="flex cursor-pointer list-none items-center gap-2.5 text-[15px] text-[var(--color-text-secondary)] [&::-webkit-details-marker]:hidden">
                      <ChevronDownIcon className="size-4 shrink-0 transition-transform group-open:rotate-180" />
                      <BrainCircuitIcon className="size-[18px] shrink-0 text-[var(--color-text-muted)]" />
                      <span>{item.streaming ? "正在思考" : "思考"}</span>
                      <span className="min-w-0 truncate text-[13px] text-[var(--color-text-muted)]">{reasoningPreview(item.content)}</span>
                    </summary>
                    <div className="ml-[30px] mt-2 border-l border-[var(--color-border-subtle)] pl-4 text-[14px] leading-[1.7] text-[var(--color-text-secondary)]">
                      <MessageResponse mode={item.streaming ? "streaming" : "static"}>{item.content}</MessageResponse>
                    </div>
                  </details>
                );
              }
              return (
                <article key={item.id} className="process-activity-enter" style={staggerStyle}>
                  <div className="flex items-center gap-2.5 text-[15px] text-[var(--color-text-secondary)]">
                    {item.streaming ? (
                      <BrainCircuitIcon className="size-[18px] shrink-0 text-[var(--color-text-muted)]" />
                    ) : (
                      <CheckCircle2Icon className="size-[18px] shrink-0 text-[var(--color-text-muted)]" />
                    )}
                    <span>{item.streaming ? item.label.replace(/^已完成/, "正在") : item.label}</span>
                  </div>
                  <div className="mt-3 whitespace-pre-wrap break-words text-[16px] font-medium leading-[1.65] text-[var(--color-text-primary)]">
                    <MessageResponse mode={item.streaming ? "streaming" : "static"}>
                      {item.content}
                    </MessageResponse>
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
                <div key={item.id} className="process-activity-enter text-[15px] text-[var(--color-text-secondary)]" style={staggerStyle}>
                  <div className="flex items-center gap-2.5">
                    <BrainCircuitIcon className="size-[18px] shrink-0 text-[var(--color-text-muted)]" />
                    <span>{label}</span>
                    {description && <span className="truncate">{description}</span>}
                  </div>
                  {detail?.resultSummary && (
                    <p className="ml-[30px] mt-2 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--color-text-primary)]">
                      {detail.resultSummary}
                    </p>
                  )}
                </div>
              );
            }

            const name = toolName(activity);
            const Icon = actionIcon(name);
            const summaryText = toolInputSummary(activity);
            const sections = detailSections(activity);
            const detail = activity.detail as { truncated?: unknown } | undefined;
            const tone = activity.status === "failed"
              ? "text-[var(--color-state-error)]"
              : activity.status === "waiting_approval"
                ? "text-[var(--color-state-warn)]"
                : "text-[var(--color-text-secondary)]";
            return (
              <div key={item.id} className={`process-activity-enter flex min-w-0 items-start gap-2.5 text-[15px] ${tone}`} style={staggerStyle}>
                <Icon className="mt-0.5 size-[18px] shrink-0 text-[var(--color-text-muted)]" />
                <div className="min-w-0 flex-1">
                  <details className="group">
                    <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 gap-y-1 [&::-webkit-details-marker]:hidden">
                      <ChevronDownIcon className="size-3.5 shrink-0 self-center transition-transform group-open:rotate-180" />
                      <span>{activityLabel(activity)}</span>
                      {summaryText && <code className="rounded-md bg-[var(--color-surface-3)] px-1.5 py-0.5 font-mono text-[12px] text-[var(--color-text-primary)]">{summaryText}</code>}
                    </summary>
                    <div className="mt-2 space-y-3 pl-5">
                      {sections.map((section) => (
                        <section key={section.label}>
                          <h4 className="mb-1 text-[12px] font-medium text-[var(--color-text-muted)]">{section.label}</h4>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--color-surface-2)] p-3 font-mono text-[12px] leading-relaxed text-[var(--color-text-primary)]">{section.value}</pre>
                        </section>
                      ))}
                      {detail?.truncated === true && <p className="text-[12px] text-[var(--color-text-muted)]">服务端返回的结果已截断</p>}
                      {sections.length === 0 && <p className="text-[13px] text-[var(--color-text-muted)]">此工具调用没有提供可展示的参数或结果。</p>}
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
