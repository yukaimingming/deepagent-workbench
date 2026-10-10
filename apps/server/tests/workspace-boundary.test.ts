/**
 * 工作区路径校验的单元测试。
 *
 * 安全关键：前端通过 forwardedProps.workspaceRoot 指定 Agent 操作目录，
 * 必须确保它落在配置的工作区之内，否则任何人都能让 Agent
 * 读写工作区以外的路径。
 */

import { describe, expect, it } from "vitest";
import { isInside } from "../src/agent/deep-agent-agui.js";

describe("isInside — 工作区路径边界", () => {
  const root = "D:\\temp\\langchain\\workspace";

  it("根目录本身被允许", () => {
    expect(isInside(root, root)).toBe(true);
  });

  it("一级子目录被允许", () => {
    expect(isInside(root, "D:\\temp\\langchain\\workspace\\docs")).toBe(true);
  });

  it("多级子目录被允许", () => {
    expect(isInside(root, "D:\\temp\\langchain\\workspace\\a\\b\\c")).toBe(true);
  });

  it("混合斜杠的路径被允许", () => {
    expect(isInside(root, "D:/temp/langchain/workspace/docs")).toBe(true);
  });

  it("父目录被拒绝", () => {
    expect(isInside(root, "D:\\temp\\langchain")).toBe(false);
  });

  it("兄弟目录被拒绝（前缀相同但不是子目录）", () => {
    // workspace-evil 与 workspace 只差后缀，必须挡掉。
    expect(isInside(root, "D:\\temp\\langchain\\workspace-evil")).toBe(false);
  });

  it(".. 穿越被拒绝", () => {
    expect(isInside(root, "D:\\temp\\langchain\\workspace\\..\\..\\etc")).toBe(false);
    expect(isInside(root, "D:\\temp\\langchain\\workspace\\docs\\..\\..")).toBe(false);
  });

  it("绝对路径逃逸被拒绝", () => {
    expect(isInside(root, "C:\\Windows\\System32")).toBe(false);
    expect(isInside(root, "/etc/passwd")).toBe(false);
  });

  it("深层 .. 折返后被拒绝", () => {
    expect(isInside(root, "D:\\temp\\langchain\\workspace\\a\\..\\..\\..\\outside")).toBe(false);
  });

  it("空字符串被拒绝", () => {
    expect(isInside(root, "")).toBe(false);
  });

  it("Linux 风格路径同样生效", () => {
    expect(isInside("/home/user/ws", "/home/user/ws/sub")).toBe(true);
    expect(isInside("/home/user/ws", "/home/user/ws/../other")).toBe(false);
    expect(isInside("/home/user/ws", "/home/user/wsx")).toBe(false);
  });
});
