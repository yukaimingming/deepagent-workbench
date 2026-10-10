/**
 * 工作区文件树的路径组装测试。
 *
 * 验证：从活动卡片提取路径 → 组装成树 → 默认展开策略。
 */

import { describe, expect, it } from "vitest";
import type { Activity } from "@deepagent/shared";
import {
  buildTree,
  collectDefaultExpanded,
  extractTouchedPaths,
} from "../src/features/chat/workspace-tree.js";

function fileActivity(path: string, id: string): Activity {
  return {
    id,
    kind: "file",
    status: "completed",
    title: `文件 · ${path}`,
    detail: { path, operation: "read" },
    startedAt: 1,
  };
}

function toolActivity(id: string): Activity {
  return {
    id,
    kind: "tool",
    status: "completed",
    title: "某个工具",
    startedAt: 1,
  };
}

describe("extractTouchedPaths", () => {
  it("只提取文件类活动的路径", () => {
    const paths = extractTouchedPaths([fileActivity("/a/b.md", "f1"), toolActivity("t1"), fileActivity("/c.txt", "f2")]);
    expect(paths).toEqual(["/a/b.md", "/c.txt"]);
  });

  it("没有文件活动时返回空数组", () => {
    expect(extractTouchedPaths([toolActivity("t1")])).toEqual([]);
    expect(extractTouchedPaths([])).toEqual([]);
  });

  it("忽略没有 path 的文件活动", () => {
    const activity: Activity = {
      id: "f1",
      kind: "file",
      status: "completed",
      title: "文件",
      detail: { operation: "read" } as never,
      startedAt: 1,
    };
    expect(extractTouchedPaths([activity])).toEqual([]);
  });
});

describe("buildTree", () => {
  it("把扁平路径组装成嵌套树", () => {
    const tree = buildTree(["/src/utils/helper.ts", "/src/index.ts", "/README.md"]);
    const names = [...tree.children.keys()].sort();
    expect(names).toEqual(["README.md", "src"]);

    const src = tree.children.get("src");
    expect(src).toBeDefined();
    expect([...(src?.children.keys() ?? [])].sort()).toEqual(["index.ts", "utils"]);

    const utils = src?.children.get("utils");
    expect([...(utils?.children.keys() ?? [])]).toEqual(["helper.ts"]);
  });

  it("标记被 Agent 直接操作过的文件", () => {
    const tree = buildTree(["/a/b.txt"]);
    const a = tree.children.get("a");
    const file = a?.children.get("b.txt");
    expect(file?.touched).toBe(true);
    // 目录节点不算 touched
    expect(a?.touched).toBeUndefined();
  });

  it("处理 Windows 反斜杠路径（嵌套结构）", () => {
    const tree = buildTree(["D:\\temp\\workspace\\notes.md"]);
    // 反斜杠统一成正斜杠后按 / 切分，D: 作为盘符段保留。
    expect([...tree.children.keys()]).toEqual(["D:"]);
    const workspace = tree.children.get("D:")?.children.get("temp")?.children.get("workspace");
    expect(workspace?.children.get("notes.md")?.touched).toBe(true);
  });

  it("忽略空路径与根斜杠", () => {
    const tree = buildTree(["", "/", "///"]);
    expect([...tree.children.keys()]).toEqual([]);
  });

  it("同一目录的多个文件合并到一个文件夹", () => {
    const tree = buildTree(["/docs/a.md", "/docs/b.md", "/docs/c.md"]);
    const docs = tree.children.get("docs");
    expect(docs?.children.size).toBe(3);
  });

  it("路径段里没有空段", () => {
    const tree = buildTree(["//a//b//c.txt"]);
    const a = tree.children.get("a");
    expect(a).toBeDefined();
    expect([...(a?.children.keys() ?? [])]).toEqual(["b"]);
  });
});

describe("collectDefaultExpanded", () => {
  it("默认展开前两层目录", () => {
    const tree = buildTree(["/a/b/c/d.txt"]);
    const expanded = collectDefaultExpanded(tree);
    expect(expanded.has("a")).toBe(true);
    expect(expanded.has("a/b")).toBe(true);
    // 第三层不展开
    expect(expanded.has("a/b/c")).toBe(false);
  });

  it("只展开含子目录的节点，纯文件目录不展开", () => {
    const tree = buildTree(["/x/file.txt", "/y/sub/deep.txt"]);
    const expanded = collectDefaultExpanded(tree);
    // y 含子目录 sub，展开
    expect(expanded.has("y")).toBe(true);
    // x 只有文件，没有子目录，不展开
    expect(expanded.has("x")).toBe(false);
    // y/sub 只有文件，不展开（展开后是空箭头）
    expect(expanded.has("y/sub")).toBe(false);
  });

  it("深层嵌套只展开前两层", () => {
    const tree = buildTree(["/l1/l2/l3/l4/file.txt"]);
    const expanded = collectDefaultExpanded(tree);
    expect(expanded.has("l1")).toBe(true);
    expect(expanded.has("l1/l2")).toBe(true);
    expect(expanded.has("l1/l2/l3")).toBe(false);
  });

  it("空树不产生展开项", () => {
    expect(collectDefaultExpanded(buildTree([])).size).toBe(0);
  });
});
