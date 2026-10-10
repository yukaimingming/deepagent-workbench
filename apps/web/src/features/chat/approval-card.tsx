import { useState } from "react";
import { safeStringify, type Activity, type ApprovalDetail } from "@deepagent/shared";
import { CodeBlock } from "../../components/ai-elements/code-block.js";
import { ChevronDownIcon, CheckCircle2Icon, XCircleIcon } from "lucide-react";
import { cn } from "../../lib/utils.js";

export function ApprovalCard({
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
  const [isExpanded, setIsExpanded] = useState(false);

  const toolName = detail?.toolName ?? activity.title;

  // 1. 已决态（批准或拒绝）：默认自动收缩为紧凑的单行条目，极度省空间
  if (decision) {
    const isApproved = decision === "approve";
    return (
      <div className="w-full rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs transition-all my-1">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {isApproved ? (
              <CheckCircle2Icon className="size-3.5 text-emerald-400 shrink-0" />
            ) : (
              <XCircleIcon className="size-3.5 text-red-400 shrink-0" />
            )}
            <span className="font-medium text-zinc-200 truncate">
              {toolName}
            </span>
            <span className={cn("text-[11.5px]", isApproved ? "text-emerald-400/90" : "text-red-400/90")}>
              已{isApproved ? "批准执行" : "拒绝操作"}
            </span>
          </div>

          {(detail?.impact || args.text) && (
            <button
              type="button"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors ml-2 shrink-0"
            >
              <span>{isExpanded ? "收起详情" : "查看参数"}</span>
              <ChevronDownIcon
                className={cn("size-3 transition-transform", isExpanded ? "rotate-180" : "rotate-0")}
              />
            </button>
          )}
        </div>

        {/* 仅在用户主动点击时才展开参数详情 */}
        {isExpanded && (
          <div className="mt-2.5 pt-2 border-t border-zinc-800/80 space-y-2 animate-in fade-in duration-150">
            {detail?.impact && (
              <p className="rounded border border-zinc-800 bg-zinc-950/60 px-2 py-1 text-[11px] text-zinc-400">
                {detail.impact}
              </p>
            )}
            {args.text && (
              <div className="max-h-48 overflow-auto rounded border border-zinc-800/80">
                <CodeBlock code={args.text} language="json" />
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // 2. 待审批态：展示醒目的操作卡片
  return (
    <article className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 my-1">
      <header className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full bg-amber-400 animate-pulse" aria-hidden="true" />
        <h4 className="truncate text-[13px] font-medium text-zinc-100">
          待审批 · {toolName}
        </h4>
      </header>

      {detail?.impact ? (
        <p className="mt-2 rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-[11.5px] text-amber-300">
          {detail.impact}
        </p>
      ) : null}

      {args.text ? (
        <div className="mt-2 max-h-56 overflow-auto rounded border border-zinc-800">
          <CodeBlock code={args.text} language="json" />
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecide?.(activity.id, "approve")}
          className="rounded-md bg-emerald-500/15 border border-emerald-500/30 px-3 py-1 text-[12px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          批准执行
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onDecide?.(activity.id, "reject")}
          className="rounded-md bg-red-500/15 border border-red-500/30 px-3 py-1 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/25 disabled:cursor-not-allowed disabled:opacity-40"
        >
          拒绝
        </button>
      </div>
    </article>
  );
}
