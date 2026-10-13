import { describe, expect, it } from "vitest";
import { buildTurnProcessTimeline } from "../src/features/chat/chat-messages.js";

describe("助手过程时间线顺序", () => {
  it("同一时间戳下按推理、模型中间文本、工具活动排序，最终答复留在正文", () => {
    const timeline = buildTurnProcessTimeline(
      [
        {
          id: "node-one",
          role: "assistant",
          content: "我先检查目录，再汇报结果。",
          streaming: false,
          runId: "run-one",
          reasoning: "先确认工作区内容。",
          reasoningStreaming: false,
          reasoningStartedAt: 100,
          createdAt: 100,
        },
        {
          id: "final",
          role: "assistant",
          content: "工作区包含项目文件。",
          streaming: false,
          runId: "run-one",
          createdAt: 300,
        },
      ],
      [
        {
          id: "tool-one",
          kind: "tool",
          status: "completed",
          title: "查看目录",
          runId: "run-one",
          startedAt: 100,
        },
      ],
    );

    const items = timeline.byFinalMessage.get("final") ?? [];
    expect(items.map((item) => item.kind === "assistant" ? item.content : item.activity.title)).toEqual([
      "先确认工作区内容。",
      "我先检查目录，再汇报结果。",
      "查看目录",
    ]);
    expect(timeline.ownedMessageIds.has("node-one")).toBe(true);
    expect(timeline.ownedMessageIds.has("final")).toBe(false);
  });
});
