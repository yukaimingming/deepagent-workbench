import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Activity } from "@deepagent/shared";
import { ChatMessages } from "../src/features/chat/chat-messages.js";
import {
      buildTurnProcessTimeline,
      findPromotedMessageId,
  shouldHideIntermediateAssistantText,
} from "../src/features/chat/chat-messages.js";
import type { ChatMessage } from "../src/features/chat/chat-types.js";

function assistant(id: string, runId: string, content: string): ChatMessage {
  return { id, runId, role: "assistant", content, streaming: false };
}

describe("空状态建议提示词", () => {
  it("使用 67d917f 的四条建议", () => {
    const html = renderToStaticMarkup(createElement(ChatMessages, {
      messages: [],
      activities: [],
      error: null,
    }));
    expect(html).toContain("查看工作区文件");
    expect(html).toContain("规划待办开发任务");
    expect(html).toContain("创建项目说明文档");
    expect(html).toContain("检查系统运行环境");
    expect(html).not.toContain("分析项目结构");
    expect(html).not.toContain("检查环境与 Git 状态");
  });
});

describe("findPromotedMessageId", () => {
  it("只检查最新运行，避免旧轮次的自然答复阻止审批后的总结提升", () => {
    const messages = [
      assistant("old-final", "run-1", "上一轮正常答复"),
      assistant("resumed-summary", "run-2", "审批完成后的最终总结"),
    ];
    const toolsByMessage = new Map<string, Activity[]>([
      ["old-final", []],
      ["resumed-summary", [{ kind: "tool" } as Activity]],
    ]);

    expect(findPromotedMessageId(messages, toolsByMessage)).toBe("resumed-summary");
  });

  it("当前运行已有独立最终答复时不提升工具阶段消息", () => {
    const messages = [
      assistant("tool-step", "run-2", "正在写文件"),
      assistant("final", "run-2", "文件已创建，下面是总结"),
    ];
    const toolsByMessage = new Map<string, Activity[]>([
      ["tool-step", [{ kind: "tool" } as Activity]],
      ["final", []],
    ]);

    expect(findPromotedMessageId(messages, toolsByMessage)).toBeNull();
  });

  it("运行期间也把带工具活动的流式正文放到时间线末尾", () => {
    const streaming = { ...assistant("a", "run-1", "正在逐段生成的总结"), streaming: true };
    const toolsByMessage = new Map<string, Activity[]>([
      ["a", [{ kind: "tool" } as Activity]],
    ]);
    const promotedId = findPromotedMessageId([streaming], toolsByMessage);

    expect(promotedId).toBe("a");
    expect(
      shouldHideIntermediateAssistantText(
        streaming,
        toolsByMessage.get("a") ?? [],
        promotedId,
      ),
    ).toBe(false);
  });
});

describe("buildTurnProcessTimeline", () => {
  it("按消息与工具时间戳交替排列过程说明和工具动作", () => {
    const messages = [
      { id: "user", role: "user" as const, content: "检查工程", streaming: false, createdAt: 100 },
      { id: "analysis", role: "assistant" as const, content: "我先查看目录结构。", streaming: false, runId: "run-1", createdAt: 200 },
      {
        id: "final", role: "assistant" as const, content: "检查完成。", reasoning: "现在整理最终答复。",
        streaming: false, reasoningStreaming: false, runId: "run-1", createdAt: 500,
      },
    ];
    const activities: Activity[] = [
      { id: "tool-1", kind: "tool", status: "completed", title: "ls", startedAt: 300, runId: "run-1" },
      { id: "tool-2", kind: "tool", status: "completed", title: "read_file", startedAt: 400, runId: "run-1" },
    ];

    const timeline = buildTurnProcessTimeline(messages, activities);
    const entries = timeline.byFinalMessage.get("final") ?? [];
    expect(entries.map((item) => item.kind === "assistant" ? item.id : item.activity.id)).toEqual([
      "message:analysis",
      "tool-1",
      "tool-2",
      "reasoning:final",
    ]);
    expect(timeline.ownedMessageIds.has("analysis")).toBe(true);
    expect(timeline.ownedMessageIds.has("final")).toBe(false);
    expect(entries.some((item) => item.kind === "assistant" && item.id === "reasoning:final")).toBe(true);
  });

  it("正文后续收到推理增量时仍将正文保留在折叠时间线之外", () => {
    const messages = [
      { id: "user", role: "user" as const, content: "查看目录", streaming: false, createdAt: 100 },
      { id: "answer", role: "assistant" as const, content: "最终正文应始终可见。", streaming: false, runId: "run-1", createdAt: 300 },
      { id: "reasoning", role: "assistant" as const, content: "", reasoning: "补充的模型推理原文。", streaming: false, reasoningStreaming: false, runId: "run-1", createdAt: 400 },
    ];
    const timeline = buildTurnProcessTimeline(messages, [
      { id: "tool-1", kind: "tool", status: "completed", title: "ls", startedAt: 200, runId: "run-1" },
    ]);
    const entries = timeline.byFinalMessage.get("answer") ?? [];

    expect(timeline.ownedMessageIds.has("answer")).toBe(false);
    expect(timeline.ownedMessageIds.has("reasoning")).toBe(true);
    expect(entries.some((item) => item.kind === "assistant" && item.id === "reasoning:reasoning")).toBe(true);
  });

  it("把原始模型推理放进过程顺序中，并保留原文", () => {
    const messages = [
      { id: "user", role: "user" as const, content: "读取文件", streaming: false, createdAt: 100 },
      {
        id: "analysis",
        role: "assistant" as const,
        content: "先读取入口文件。",
        reasoning: "检查目录后，定位入口。",
        streaming: false,
        reasoningStreaming: false,
        runId: "run-1",
        createdAt: 200,
        reasoningStartedAt: 150,
      },
      { id: "final", role: "assistant" as const, content: "完成。", streaming: false, runId: "run-1", createdAt: 500 },
    ];
    const timeline = buildTurnProcessTimeline(messages, [
      { id: "tool-1", kind: "tool", status: "completed", title: "read_file", startedAt: 300, runId: "run-1" },
    ]);
    const entries = timeline.byFinalMessage.get("final") ?? [];

    expect(entries.filter((item) => item.kind === "assistant").map((item) => item.content)).toEqual([
      "检查目录后，定位入口。",
      "先读取入口文件。",
    ]);
  });
});

describe("shouldHideIntermediateAssistantText", () => {
  it("工具运行期间保留正文增量，避免只显示过程说明", () => {
    const message = { ...assistant("streaming-answer", "run-1", "正在逐段生成的正文"), streaming: true };
    const tools = [{ kind: "tool" } as Activity];

    expect(shouldHideIntermediateAssistantText(message, tools, null)).toBe(false);
  });

  it("工具步骤结束后仍隐藏未提升的中间文本", () => {
    const message = assistant("tool-step", "run-1", "工具前的说明");
    const tools = [{ kind: "tool" } as Activity];

    expect(shouldHideIntermediateAssistantText(message, tools, null)).toBe(true);
  });
});
