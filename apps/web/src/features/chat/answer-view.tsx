/**
 * 最终答复的 Markdown 渲染。
 *
 * 复用 AI SDK Elements 的 `MessageResponse`（基于 streamdown），
 * 而不是自己再写一套 Markdown 渲染（AGENTS.md 第 7.4 节）。
 *
 * 安全说明：streamdown/react-markdown 默认不执行原始 HTML，
 * 不可信内容不会被渲染为可执行标记（AGENTS.md 第 13 节）。
 */

import { memo } from "react";
import { MessageResponse } from "../../components/ai-elements/message.js";
import { Shimmer } from "../../components/ai-elements/shimmer.js";

interface AnswerViewProps {
  content: string;
  streaming: boolean;
}

export const AnswerView = memo(function AnswerView({ content, streaming }: AnswerViewProps) {
  if (content.length === 0) {
    if (!streaming) return null;
    return (
      <Shimmer className="text-[13px]" duration={1.8}>
        正在生成…
      </Shimmer>
    );
  }
  return (
    <div
      className={`text-[13.5px] leading-relaxed text-text-primary ${streaming ? "streaming-caret" : ""}`}
    >
      <MessageResponse
        // streamdown 在流式模式下会解析未闭合的 Markdown，避免闪烁。
        mode={streaming ? "streaming" : "static"}
        isAnimating={streaming}
        shikiTheme={["github-light", "github-dark"]}
        controls
      >
        {content}
      </MessageResponse>
    </div>
  );
});
