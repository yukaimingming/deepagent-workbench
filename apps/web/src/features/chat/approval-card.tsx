/**
 * 人工审批卡片。
 *
 * 渲染在聊天流里（右侧活动面板已移除，审批不能因此丢掉）。
 * 展示待批准的操作、影响范围与参数，提供批准 / 拒绝。
 */

import { safeStringify, type Activity, type ApprovalDetail } from "@deepagent/shared";
import { CodeBlock } from "../../components/ai-elements/code-block.js";

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
