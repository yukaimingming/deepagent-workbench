/**
 * 活动时间线卡片。
 *
 * 每张卡片由稳定 ID 关联更新，不闪烁、不重复。
 * 大型输入/输出默认折叠；未完成的工具调用显示「进行中」。
 */

import type {
  Activity,
  ApprovalDetail,
  FileDetail,
  SubagentDetail,
  TodoDetail,
  ToolDetail,
} from "@deepagent/shared";
import { safeStringify } from "@deepagent/shared";
import type { BundledLanguage } from "shiki";
import { CodeBlock } from "../../components/ai-elements/code-block.js";
import { Collapsible } from "../../components/collapsible.js";

/**
 * 推断展示语言。
 *
 * shiki 的 BundledLanguage 里没有纯文本标识，工具输出通常是 JSON，
 * 因此优先判 json，其余回落 json（等宽显示即可，不做语法高亮）。
 */
function guessLanguage(text: string): BundledLanguage {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "json";
  return "json";
}
import {
  STATUS_COLOR,
  STATUS_DOT,
  STATUS_ICON,
  STATUS_LABEL,
  formatDuration,
} from "./activity-meta.js";

interface ActivityCardProps {
  activity: Activity;
  /** 审批操作回调。 */
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  /** 当前已选决策（用于高亮）。 */
  selectedDecision?: "approve" | "reject";
}

export function ActivityCard({ activity, onDecide, selectedDecision }: ActivityCardProps) {
  const color = STATUS_COLOR[activity.status];
  const dot = STATUS_DOT[activity.status];

  return (
    <article className="rounded-lg border border-border-subtle bg-surface-1 p-3 transition-colors hover:border-border-strong">
      <header className="flex items-start gap-2">
        <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h4 className="truncate text-[13px] font-medium text-text-primary" title={activity.title}>
              {activity.title}
            </h4>
            <span className={`shrink-0 text-[11px] ${color}`}>
              {STATUS_ICON[activity.status]} {STATUS_LABEL[activity.status]}
            </span>
            {activity.durationMs !== undefined && activity.status !== "running" ? (
              <span className="shrink-0 text-[11px] text-text-muted">
                {formatDuration(activity.durationMs)}
              </span>
            ) : null}
          </div>
          {activity.subtitle ? (
            <p className="mt-0.5 truncate text-[11.5px] text-text-muted" title={activity.subtitle}>
              {activity.subtitle}
            </p>
          ) : null}
        </div>
      </header>

      <div className="mt-2">
        {activity.kind === "todo" ? <TodoBody detail={activity.detail as TodoDetail} /> : null}
        {activity.kind === "tool" ? <ToolBody detail={activity.detail as ToolDetail} /> : null}
        {activity.kind === "subagent" ? <SubagentBody detail={activity.detail as SubagentDetail} /> : null}
        {activity.kind === "file" ? <FileBody detail={activity.detail as FileDetail} /> : null}
        {activity.kind === "approval" ? (
          <ApprovalBody
            detail={activity.detail as ApprovalDetail}
            onDecide={onDecide}
            activityId={activity.id}
            selectedDecision={selectedDecision}
          />
        ) : null}
      </div>

      {activity.error ? (
        <p className="mt-2 rounded border border-state-error/30 bg-state-error/10 px-2 py-1.5 text-[11.5px] text-state-error">
          {activity.error}
        </p>
      ) : null}
    </article>
  );
}

/** Todo 卡片：进度条 + 条目列表。 */
function TodoBody({ detail }: { detail: TodoDetail }) {
  if (!detail?.items?.length) return null;
  const percent = detail.total > 0 ? Math.round((detail.completed / detail.total) * 100) : 0;
  return (
    <div>
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
        <span className="shrink-0 text-[11px] text-text-muted">
          {detail.completed}/{detail.total}
        </span>
      </div>
      <ol className="space-y-1">
        {detail.items.map((item, index) => (
          <li key={`${index}-${item.content}`} className="flex items-start gap-2 text-[12px]">
            <span className={todoIconClass(item.status)} aria-hidden="true">
              {todoIcon(item.status)}
            </span>
            <span className={item.status === "completed" ? "text-text-muted line-through" : "text-text-secondary"}>
              {item.content}
            </span>
          </li>
        ))}
      </ol>
    </div>
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

/** 工具调用卡片：输入/输出默认折叠。 */
function ToolBody({ detail }: { detail: ToolDetail }) {
  if (!detail) return null;
  const input = safeStringify(detail.input);
  const output = detail.output === undefined ? null : safeStringify(detail.output);
  return (
    <div>
      {input.text ? (
        <Collapsible summary="输入参数" truncated={input.truncated}>
          <CodeBlock code={input.text} language={guessLanguage(input.text)} />
        </Collapsible>
      ) : null}
      {output?.text ? (
        <Collapsible summary="执行结果" truncated={output.truncated}>
          <CodeBlock code={output.text} language={guessLanguage(output.text)} />
        </Collapsible>
      ) : null}
      {!input.text && !output?.text ? (
        <p className="text-[11.5px] text-text-muted">无输入输出</p>
      ) : null}
    </div>
  );
}

/** 子 Agent 卡片。 */
function SubagentBody({ detail }: { detail: SubagentDetail }) {
  if (!detail) return null;
  return (
    <div className="space-y-1 text-[12px] text-text-secondary">
      {detail.goal ? <p>{detail.goal}</p> : null}
      {detail.resultSummary ? (
        <Collapsible summary="结果摘要">
          <CodeBlock code={detail.resultSummary} language={guessLanguage(detail.resultSummary)} />
        </Collapsible>
      ) : null}
    </div>
  );
}

/** 文件活动卡片：安全显示路径。 */
function FileBody({ detail }: { detail: FileDetail }) {
  if (!detail) return null;
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
    <div className="flex items-center gap-2 text-[12px]">
      <span className="rounded border border-border-subtle bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary">
        {operationLabel[detail.operation] ?? detail.operation}
      </span>
      <code className="truncate font-mono text-[11.5px] text-text-secondary" title={detail.path}>
        {detail.path || "（未提供路径）"}
      </code>
    </div>
  );
}

/** 人工审批卡片：展示操作内容、影响范围与批准/拒绝按钮。 */
function ApprovalBody({
  detail,
  onDecide,
  activityId,
  selectedDecision,
}: {
  detail: ApprovalDetail;
  onDecide?: (activityId: string, decision: "approve" | "reject") => void;
  activityId: string;
  selectedDecision?: "approve" | "reject";
}) {
  if (!detail) return null;
  const args = safeStringify(detail.args);
  const disabled = onDecide === undefined || selectedDecision !== undefined;

  return (
    <div className="space-y-2">
      {detail.impact ? (
        <p className="rounded border border-state-warn/30 bg-state-warn/10 px-2 py-1.5 text-[11.5px] text-state-warn">
          {detail.impact}
        </p>
      ) : null}
      {args.text ? (
        <Collapsible summary="操作参数">
          <CodeBlock code={args.text} language={guessLanguage(args.text)} />
        </Collapsible>
      ) : null}
      {selectedDecision ? (
        <p className="text-[11.5px] text-text-muted">
          已选择：{selectedDecision === "approve" ? "批准" : "拒绝"}
        </p>
      ) : (
        <div className="flex gap-2">
          {detail.allowedDecisions.includes("approve") ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDecide?.(activityId, "approve")}
              className="rounded-md bg-state-done/15 px-3 py-1 text-[12px] font-medium text-state-done transition-colors hover:bg-state-done/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              批准
            </button>
          ) : null}
          {detail.allowedDecisions.includes("reject") ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDecide?.(activityId, "reject")}
              className="rounded-md bg-state-error/15 px-3 py-1 text-[12px] font-medium text-state-error transition-colors hover:bg-state-error/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              拒绝
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
