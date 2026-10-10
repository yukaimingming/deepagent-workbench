/**
 * 任务列表组件（基于 AI SDK Elements 官方 Queue 组件重构）。
 *
 * 参考官网规范：https://elements.ai-sdk.dev/components/queue
 * 包含：
 * - Queue 队列容器
 * - QueueSection 可折叠区块
 * - QueueSectionTrigger 触发栏
 * - QueueSectionLabel 状态统计标签
 * - QueueSectionContent 任务内容区
 * - QueueList 任务条目列表
 * - QueueItem 独立任务项
 * - QueueItemIndicator 状态圆环指示器（待办/进行中/完成）
 * - QueueItemContent 任务标题内容（已完成划线）
 */

import {
  Queue,
  QueueSection,
  QueueSectionTrigger,
  QueueSectionLabel,
  QueueSectionContent,
  QueueList,
  QueueItem,
  QueueItemIndicator,
  QueueItemContent,
} from "../../components/ai-elements/queue.js";
import { ListTodoIcon, CheckCircle2Icon } from "lucide-react";
import type { Activity, TodoDetail } from "@deepagent/shared";

interface TodoCardProps {
  activity: Activity;
}

export function TodoCard({ activity }: TodoCardProps) {
  const detail = activity.detail as TodoDetail | undefined;
  if (!detail?.items?.length) return null;

  const isAllDone = detail.completed >= detail.total && detail.total > 0;

  return (
    <Queue className="my-2 border-zinc-800/80 bg-zinc-950/60">
      <QueueSection defaultOpen>
        <QueueSectionTrigger className="bg-zinc-900/60 hover:bg-zinc-900 text-zinc-300">
          <QueueSectionLabel
            count={detail.total}
            label={`项待办任务 (${detail.completed}/${detail.total} 已完成)`}
            icon={
              isAllDone ? (
                <CheckCircle2Icon className="size-4 text-emerald-400 shrink-0" />
              ) : (
                <ListTodoIcon className="size-4 text-amber-400 shrink-0" />
              )
            }
          />
        </QueueSectionTrigger>

        <QueueSectionContent>
          <QueueList className="mt-1">
            {detail.items.map((item, index) => {
              const isCompleted = item.status === "completed";

              return (
                <QueueItem key={`${index}-${item.content}`}>
                  <div className="flex items-center gap-2.5 py-0.5">
                    <QueueItemIndicator completed={isCompleted} />
                    <QueueItemContent completed={isCompleted}>
                      {item.content}
                    </QueueItemContent>
                  </div>
                </QueueItem>
              );
            })}
          </QueueList>
        </QueueSectionContent>
      </QueueSection>
    </Queue>
  );
}
