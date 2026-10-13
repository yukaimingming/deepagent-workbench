import { EventType, type BaseEvent } from "@ag-ui/client";

/** 每次揭示的字符数。中文按 UTF-16 码元计，大约四个字一拍。 */
export const REVEAL_CHARS = 4;
/** 两拍之间的间隔，让浏览器有机会把这一拍画出来。 */
export const REVEAL_MS = 18;

export interface RevealStep {
  emit: BaseEvent;
  rest: BaseEvent | null;
  waitMs: number;
}

function contentDelta(event: BaseEvent): string | null {
  if (event.type !== EventType.TEXT_MESSAGE_CONTENT && event.type !== EventType.REASONING_MESSAGE_CONTENT) {
    return null;
  }
  const delta = (event as { delta?: unknown }).delta;
  return typeof delta === "string" ? delta : null;
}

/**
 * 把一条事件拆成「现在画出来的一拍」和「还留在队列里的剩余部分」。
 * 思考和正文按到达顺序逐拍揭示；工具、状态等事件整条通过，但仍排在已经到达的文本后面。
 */
export function takeRevealStep(event: BaseEvent): RevealStep {
  const delta = contentDelta(event);
  if (delta === null) return { emit: event, rest: null, waitMs: 0 };
  if (delta.length <= REVEAL_CHARS) return { emit: event, rest: null, waitMs: REVEAL_MS };
  return {
    emit: { ...event, delta: delta.slice(0, REVEAL_CHARS) } as BaseEvent,
    rest: { ...event, delta: delta.slice(REVEAL_CHARS) } as BaseEvent,
    waitMs: REVEAL_MS,
  };
}
