/**
 * 运行活动卡片集合。
 *
 * 用 AI Elements 官方组件承载各类型活动：
 * - Todo / 计划 → `Task`（可折叠任务清单，带进度）
 * - 子 Agent → `Agent`（子智能体卡片）
 * - 文件操作 → `Plan`（步骤列表）之外的轻量展示
 * - 人工审批 → `Confirmation` 样式的批准/拒绝操作区
 * - 工具调用 → 交给 `Tool`（见 chat-messages.tsx，挂在回复下方）
 *
 * 这里只负责右侧时间线里「非工具类」的卡片。
 */

import { Task, TaskContent, TaskItem, TaskTrigger } from "../../components/ai-elements/task.js";
import { Badge } from "../../components/ui/badge.js";
import { safeStringify, type Activity, type ApprovalDetail, type FileDetail, type SubagentDetail, type TodoDetail } from "@deepagent/shared";
import { CodeBlock } from "../../components/ai-elements/code-block.js";
import { STATUS_LABEL, STATUS_DOT, formatDuration } from "./activity-meta.js";

interface ActivityTimelineProps {
  activities: Activity[];
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  decisions?: Record<string, { type: "approve" | "edit" | "reject" }>;
}

const KIND_LABEL: Record<Activity["kind"], string> = {
  todo: "任务计划",
  tool: "工具调用",
  subagent: "子 Agent",
  file: "文件活动",
  approval: "人工审批",
  answer: "最终答复",
  error: "错误",
};

/** 时间线展示顺序。 */
const KIND_ORDER: Array<Activity["kind"]> = [
  "error",
  "approval",
  "todo",
  "subagent",
  "file",
  "tool",
  "answer",
];

export function ActivityTimeline({ activities, onDecide, decisions }: ActivityTimelineProps) {
  if (activities.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div>
          <p className="text-[13px] text-text-muted">暂无活动</p>
          <p className="mt-1 text-[11.5px] text-text-muted">
            发送消息后，这里会显示任务计划、子 Agent 与文件操作
          </p>
        </div>
      </div>
    );
  }

  const grouped = new Map<Activity["kind"], Activity[]>();
  for (const activity of activities) {
    const list = grouped.get(activity.kind);
    if (list) list.push(activity);
    else grouped.set(activity.kind, [activity]);
  }

  return (
    <div className="flex flex-col gap-4">
      {KIND_ORDER.filter((kind) => grouped.has(kind)).map((kind) => {
        const items = grouped.get(kind) ?? [];
        return (
          <section key={kind}>
            <h3 className="mb-2 flex items-center gap-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
              {KIND_LABEL[kind]}
              <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] normal-case tracking-normal">
                {items.length}
              </span>
            </h3>
            <div className="flex flex-col gap-2">
              {items.map((activity) => (
                <ActivityCard
                  key={activity.id}
                  activity={activity}
                  onDecide={onDecide}
                  decision={decisionFor(decisions, activity)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function ActivityCard({
  activity,
  onDecide,
  decision,
}: {
  activity: Activity;
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  decision?: "approve" | "reject";
}) {
  const duration = activity.durationMs !== undefined ? formatDuration(activity.durationMs) : null;

  switch (activity.kind) {
    case "todo":
      return <TodoCard activity={activity} />;
    case "subagent":
      return <SubagentCard activity={activity} />;
    case "file":
      return <FileCard activity={activity} />;
    case "approval":
      return (
        <ApprovalCard activity={activity} onDecide={onDecide} decision={decision} />
      );
    case "error":
      return <ErrorCard activity={activity} />;
    default:
      return <GenericCard activity={activity} duration={duration} />;
  }
}

/** Todo 卡片：用官方 Task 组件。 */
function TodoCard({ activity }: { activity: Activity }) {
  const detail = activity.detail as TodoDetail | undefined;
  if (!detail?.items?.length) return <GenericCard activity={activity} />;
  const percent = detail.total > 0 ? Math.round((detail.completed / detail.total) * 100) : 0;

  return (
    <Task defaultOpen>
      <TaskTrigger title={`任务计划 ${detail.completed}/${detail.total}`} />
      <TaskContent>
        <div className="mb-2 flex items-center gap-2">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="任务进度"
          >
            <div
              className="h-full rounded-full bg-state-done transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className="shrink-0 text-[11px] text-text-muted">{percent}%</span>
        </div>
        <ol className="flex flex-col gap-1.5">
          {detail.items.map((item, index) => (
            <TaskItem key={`${index}-${item.content}`} className="text-[12px]">
              <span className={todoIconClass(item.status)} aria-hidden="true">
                {todoIcon(item.status)}
              </span>
              <span
                className={
                  item.status === "completed"
                    ? "text-text-muted line-through"
                    : "text-text-secondary"
                }
              >
                {item.content}
              </span>
            </TaskItem>
          ))}
        </ol>
      </TaskContent>
    </Task>
  );
}

/** 子 Agent 卡片。 */
function SubagentCard({ activity }: { activity: Activity }) {
  const detail = activity.detail as SubagentDetail | undefined;
  const result = detail?.resultSummary;
  return (
    <article className="rounded-lg border border-border-subtle bg-surface-1 p-3">
      <header className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[activity.status]}`} aria-hidden="true" />
        <h4 className="truncate text-[13px] font-medium text-text-primary">
          子 Agent · {detail?.name ?? activity.title}
        </h4>
        <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
          {STATUS_LABEL[activity.status]}
        </Badge>
      </header>
      {result ? (
        <div className="mt-2">
          <CodeBlock code={result} language="json" />
        </div>
      ) : null}
      {activity.error ? (
        <p className="mt-2 text-[11.5px] text-state-error">{activity.error}</p>
      ) : null}
    </article>
  );
}

/** 文件活动卡片。 */
function FileCard({ activity }: { activity: Activity }) {
  const detail = activity.detail as FileDetail | undefined;
  const operationLabel: Record<FileDetail["operation"], string> = {
    read: "读取",
    write: "写入",
    edit: "修改",
    delete: "删除",
    list: "列出",
    grep: "检索",
    glob: "匹配",
  };
  return (
    <article className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
      <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[activity.status]}`} aria-hidden="true" />
      <Badge variant="outline" className="shrink-0 text-[10px]">
        {detail ? operationLabel[detail.operation] : "文件"}
      </Badge>
      <code className="truncate font-mono text-[11.5px] text-text-secondary" title={detail?.path}>
        {detail?.path || "（未提供路径）"}
      </code>
      <span className="ml-auto shrink-0 text-[10.5px] text-text-muted">
        {STATUS_LABEL[activity.status]}
      </span>
    </article>
  );
}

/** 人工审批卡片。 */
function ApprovalCard({
  activity,
  onDecide,
  decision,
}: {
  activity: Activity;
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  decision?: "approve" | "reject";
}) {
  const detail = activity.detail as ApprovalDetail | undefined;
  const args = safeStringify(detail?.args);
  const disabled = onDecide === undefined;

  return (
    <article className="rounded-lg border border-state-warn/40 bg-state-warn/5 p-3">
      <header className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-state-warn pulse-dot" aria-hidden="true" />
        <h4 className="truncate text-[13px] font-medium text-text-primary">
          待审批 · {detail?.toolName ?? activity.title}
        </h4>
      </header>

      {detail?.impact ? (
        <p className="mt-2 rounded border border-state-warn/30 bg-state-warn/10 px-2 py-1.5 text-[11.5px] text-state-warn">
          {detail.impact}
        </p>
      ) : null}

      {args.text ? (
        <div className="mt-2">
          <CodeBlock code={args.text} language="json" />
        </div>
      ) : null}

      {decision ? (
        <p className="mt-2 text-[11.5px] text-text-muted">
          已选择：{decision === "approve" ? "批准" : "拒绝"}
        </p>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDecide?.(activity.id, "approve")}
            className="rounded-md bg-state-done/15 px-3 py-1 text-[12px] font-medium text-state-done transition-colors hover:bg-state-done/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            批准
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onDecide?.(activity.id, "reject")}
            className="rounded-md bg-state-error/15 px-3 py-1 text-[12px] font-medium text-state-error transition-colors hover:bg-state-error/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            拒绝
          </button>
        </div>
      )}
    </article>
  );
}

/** 错误卡片。 */
function ErrorCard({ activity }: { activity: Activity }) {
  return (
    <article className="rounded-lg border border-state-error/30 bg-state-error/10 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 rounded-full bg-state-error" aria-hidden="true" />
        <h4 className="text-[12.5px] font-medium text-state-error">{activity.title}</h4>
      </div>
      {activity.error ? (
        <p className="mt-1 text-[11.5px] text-text-secondary">{activity.error}</p>
      ) : null}
    </article>
  );
}

/** 通用卡片。 */
function GenericCard({ activity, duration }: { activity: Activity; duration?: string | null }) {
  return (
    <article className="rounded-lg border border-border-subtle bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[activity.status]}`} aria-hidden="true" />
        <h4 className="truncate text-[12.5px] font-medium text-text-primary">{activity.title}</h4>
        <span className="ml-auto shrink-0 text-[10.5px] text-text-muted">
          {duration ?? STATUS_LABEL[activity.status]}
        </span>
      </div>
      {activity.subtitle ? (
        <p className="mt-0.5 truncate text-[11px] text-text-muted">{activity.subtitle}</p>
      ) : null}
    </article>
  );
}

function todoIcon(status: TodoDetail["items"][number]["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "▸";
  return "○";
}

function todoIconClass(status: TodoDetail["items"][number]["status"]): string {
  if (status === "completed") return "text-state-done";
  if (status === "in_progress") return "text-state-running pulse-dot";
  return "text-text-muted";
}

/** 把中断决策映射到审批卡片。 */
function decisionFor(
  decisions: Record<string, { type: "approve" | "edit" | "reject" }> | undefined,
  activity: Activity,
): "approve" | "reject" | undefined {
  if (!decisions) return undefined;
  // activity.id 形如 `approval:{interruptId}:{index}`。
  const interruptId = activity.id.split(":")[1];
  if (!interruptId) return undefined;
  const decision = decisions[interruptId] ?? decisions[activity.id];
  if (!decision) return undefined;
  return decision.type === "approve" ? "approve" : "reject";
}
