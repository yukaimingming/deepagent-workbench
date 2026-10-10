/**
 * 运行错误翻译的单元测试。
 *
 * 保证底层英文错误不会原样透到用户界面上，
 * 且各类常见失败都有对应的中文说明。
 */

import { describe, expect, it } from "vitest";
import { describeRunError } from "../src/agent/errors.js";

describe("describeRunError", () => {
  it("401 鉴权失败转成中文", () => {
    const message = describeRunError(
      new Error("401 Incorrect API key provided\n\nTroubleshooting URL: https://docs.langchain.com/..."),
    );
    expect(message).toContain("模型鉴权失败");
    expect(message).not.toContain("Troubleshooting URL");
    expect(message).not.toContain("docs.langchain.com");
  });

  it("429 限流转成中文", () => {
    expect(describeRunError(new Error("429 Too Many Requests"))).toBe("请求被模型服务限流，请稍后重试。");
    expect(describeRunError(new Error("rate limit exceeded"))).toBe("请求被模型服务限流，请稍后重试。");
  });

  it("超时转成中文", () => {
    expect(describeRunError(new Error("Request timeout after 30000ms"))).toBe(
      "模型请求超时，请检查网络或稍后重试。",
    );
  });

  it("连接失败转成中文", () => {
    expect(describeRunError(new Error("fetch failed"))).toBe(
      "无法连接到模型服务，请检查 Base URL 是否可访问。",
    );
    expect(describeRunError(new Error("connect ECONNREFUSED 127.0.0.1:11434"))).toBe(
      "无法连接到模型服务，请检查 Base URL 是否可访问。",
    );
  });

  it("模型不存在转成中文", () => {
    expect(describeRunError(new Error("The model `gpt-99` does not exist"))).toBe(
      "模型不存在，请确认模型 ID 是否正确。",
    );
  });

  it("递归超限转成中文", () => {
    expect(describeRunError(new Error("Graph recursion limit reached"))).toBe(
      "任务步骤过多被中止，请把任务拆小后重试。",
    );
  });

  it("未知错误只保留第一行，不带堆栈", () => {
    const message = describeRunError(new Error("Something odd happened\n    at foo (bar.ts:1:1)\n    at baz"));
    expect(message).toBe("Something odd happened");
    expect(message).not.toContain("at foo");
  });

  it("非 Error 输入也能处理", () => {
    expect(describeRunError("plain string error")).toBe("plain string error");
    expect(describeRunError(undefined)).toBe("运行失败，请查看服务端日志。");
  });

  it("空错误有兜底说明", () => {
    expect(describeRunError(new Error(""))).toBe("运行失败，请查看服务端日志。");
  });
});
