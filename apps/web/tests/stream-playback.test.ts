import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";
import { takeRevealStep } from "../src/features/chat/stream-playback.js";

describe("过程与正文按拍揭示", () => {
  it("长正文拆成连续的小段，剩余部分保持原事件顺序", () => {
    const event = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "一二三四五六七八" } as BaseEvent;
    const first = takeRevealStep(event);
    const second = takeRevealStep(first.rest!);
    expect((first.emit as unknown as { delta: string }).delta).toBe("一二三四");
    expect((second.emit as unknown as { delta: string }).delta).toBe("五六七八");
    expect(second.rest).toBeNull();
  });

  it("思考增量同样逐拍揭示", () => {
    const event = { type: EventType.REASONING_MESSAGE_CONTENT, messageId: "r1", delta: "先看目录再读文件" } as BaseEvent;
    const step = takeRevealStep(event);
    expect((step.emit as unknown as { delta: string }).delta).toBe("先看目录");
    expect((step.rest as unknown as { delta: string }).delta).toBe("再读文件");
  });

  it("工具事件整条保留，并且排在已经拆开的正文后面", () => {
    const text = { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "一二三四五" } as BaseEvent;
    const tool = { type: EventType.CUSTOM, name: "activity", value: { id: "tool-1" } } as BaseEvent;
    const queue = [text, tool];
    const revealed: string[] = [];
    while (queue.length > 0) {
      const step = takeRevealStep(queue[0]!);
      queue.shift();
      if (step.rest) queue.unshift(step.rest);
      revealed.push(step.emit.type === EventType.TEXT_MESSAGE_CONTENT
        ? (step.emit as unknown as { delta: string }).delta
        : "tool");
    }
    expect(revealed).toEqual(["一二三四", "五", "tool"]);
  });
});
