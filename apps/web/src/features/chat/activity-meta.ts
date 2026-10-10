/** 活动卡片共用的工具函数与常量。 */

import type { ActivityStatus } from "@deepagent/shared";

/** 状态 → 中文标签。 */
export const STATUS_LABEL: Record<ActivityStatus, string> = {
  pending: "待处理",
  running: "进行中",
  waiting_approval: "等待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** 状态 → 颜色类名。 */
export const STATUS_COLOR: Record<ActivityStatus, string> = {
  pending: "text-text-muted",
  running: "text-state-running",
  waiting_approval: "text-state-warn",
  completed: "text-state-done",
  failed: "text-state-error",
  cancelled: "text-text-muted",
};

/** 状态 → 圆点颜色。 */
export const STATUS_DOT: Record<ActivityStatus, string> = {
  pending: "bg-text-muted",
  running: "bg-state-running pulse-dot",
  waiting_approval: "bg-state-warn pulse-dot",
  completed: "bg-state-done",
  failed: "bg-state-error",
  cancelled: "bg-text-muted",
};

/** 格式化耗时。 */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} 分 ${seconds} 秒`;
}

/** 状态图标（用简单字符，避免额外依赖）。 */
export const STATUS_ICON: Record<ActivityStatus, string> = {
  pending: "○",
  running: "◐",
  waiting_approval: "⏸",
  completed: "●",
  failed: "✕",
  cancelled: "−",
};
