import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatElapsedDuration,
  getToolActionLabel,
  ProcessActivityGroup,
} from "../src/features/chat/process-activity-group.js";

describe("过程摘要格式", () => {
  it("显示具体工具动作名称", () => {
    expect(getToolActionLabel("execute")).toBe("执行了命令");
    expect(getToolActionLabel("read_file")).toBe("分析了文件");
    expect(getToolActionLabel("edit_file")).toBe("编辑了文件");
    expect(getToolActionLabel("write_file")).toBe("写入了文件");
  });

  it("用分钟和秒显示耗时", () => {
    expect(formatElapsedDuration(0)).toBe("0分0秒");
    expect(formatElapsedDuration(125_999)).toBe("2分5秒");
  });
});

describe("ProcessActivityGroup 状态展示", () => {
  const reasoningItem = {
    id: "reasoning:answer",
    kind: "assistant" as const,
    section: "reasoning" as const,
    label: "正在思考",
    content: "模型返回的原始推理内容。",
    startedAt: Date.now(),
    streaming: false,
  };

  it("正文流式结束后立即汇总为完成，即使运行状态事件尚未结束", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [reasoningItem],
      finalAnswerStarted: true,
      finalAnswerComplete: true,
      runCompleted: false,
      durationMs: 83_000,
    }));

    expect(html).toContain("已完成分析，用时 1分23秒");
    expect(html).not.toContain("正在分析");
    expect(html).not.toContain("正在思考");
    expect(html).toContain('aria-expanded="false"');
  });

  it("运行中将分析状态和用时放在同一个 Shimmer 文本中", () => {
    const html = renderToStaticMarkup(createElement(ProcessActivityGroup, {
      items: [reasoningItem],
      finalAnswerStarted: false,
      finalAnswerComplete: false,
      runCompleted: false,
      durationMs: 0,
    }));

    expect(html).toContain("正在分析，用时 0分0秒");
    expect(html).toContain("bg-clip-text");
    expect(html).not.toContain("正在思考");
    expect(html).toContain("模型返回的原始推理内容。");
  });
});
