import { describe, expect, it } from "vitest";
import { extractModelIds, buildModelsUrl } from "../src/providers/model-list.js";

describe("buildModelsUrl", () => {
  it("在 Base URL 后追加 /models", () => {
    expect(buildModelsUrl("https://api.openai.com/v1", "openai")).toBe(
      "https://api.openai.com/v1/models",
    );
  });

  it("Base URL 已含路径前缀时正确拼接，不重复斜杠", () => {
    expect(buildModelsUrl("https://api.stepfun.com/step_plan/v1", "stepfun")).toBe(
      "https://api.stepfun.com/step_plan/v1/models",
    );
  });

  it("Base URL 带尾部斜杠时不产生双斜杠", () => {
    expect(buildModelsUrl("https://api.openai.com/v1/", "openai")).toBe(
      "https://api.openai.com/v1/models",
    );
  });

  it("Base URL 已以 /models 结尾时不重复追加", () => {
    expect(buildModelsUrl("https://api.openai.com/v1/models", "openai")).toBe(
      "https://api.openai.com/v1/models",
    );
  });

  it("本地 OpenAI-compatible 服务同样处理", () => {
    expect(buildModelsUrl("http://127.0.0.1:11434/v1", "openai-compatible")).toBe(
      "http://127.0.0.1:11434/v1/models",
    );
  });

  it("Anthropic 使用其 models 端点", () => {
    expect(buildModelsUrl("https://api.anthropic.com/v1", "anthropic")).toBe(
      "https://api.anthropic.com/v1/models",
    );
  });
});

describe("extractModelIds", () => {
  it("解析 OpenAI 风格的 { data: [{ id }] }", () => {
    const models = extractModelIds({ data: [{ id: "gpt-5" }, { id: "gpt-4o" }] });
    expect(models).toEqual(["gpt-4o", "gpt-5"]);
  });

  it("解析 { models: [...] } 字符串数组", () => {
    expect(extractModelIds({ models: ["a-model", "b-model"] })).toEqual(["a-model", "b-model"]);
  });

  it("解析 Anthropic 风格的 { data: [{ id }] } 并去重", () => {
    const models = extractModelIds({ data: [{ id: "claude-a" }, { id: "claude-a" }, { id: "claude-b" }] });
    expect(models).toEqual(["claude-a", "claude-b"]);
  });

  it("对象含 name 字段时也接受", () => {
    expect(extractModelIds({ data: [{ name: "named-model" }] })).toEqual(["named-model"]);
  });

  it("空结果返回空数组（不代表密钥无效）", () => {
    expect(extractModelIds({ data: [] })).toEqual([]);
    expect(extractModelIds({})).toEqual([]);
  });

  it("忽略非对象输入", () => {
    expect(extractModelIds(null)).toEqual([]);
    expect(extractModelIds("string")).toEqual([]);
  });
});
