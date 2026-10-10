/**
 * 跨文件夹访问能力测试。
 *
 * 用户明确要求 Agent 不能只能访问工作区，而要能跨文件夹访问任意目录。
 * 这条能力由 `createAgentBackend` 的 `virtualMode` 开关控制：
 * - crossFolderAccess: true  → virtualMode: false，绝对路径可访问 rootDir 之外；
 * - crossFolderAccess: false → virtualMode: true，越界路径被拒绝（旧行为）。
 *
 * 这里直接对生产代码里的 backend 工厂做验证，确保开关确实生效。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentBackend, APPROVAL_TOOLS } from "../src/agent/create-agent.js";

let root: string;
let workspaceRoot: string;
let outsideDir: string;
let outsideFile: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "deepagent-cross-"));
  workspaceRoot = join(root, "workspace");
  outsideDir = join(root, "outside");
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(outsideDir, { recursive: true });
  outsideFile = join(outsideDir, "outside-note.txt");
  await writeFile(outsideFile, "工作区之外的内容", "utf8");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("跨文件夹访问", () => {
  it("开启后可以读取工作区之外的绝对路径文件", async () => {
    const backend = createAgentBackend({
      workspaceRoot,
      shellEnabled: false,
      crossFolderAccess: true,
    });
    const result = await backend.read(outsideFile);
    expect(result.error).toBeUndefined();
    expect(String(result.content)).toContain("工作区之外的内容");
  });

  it("开启后可以写入工作区之外的绝对路径文件", async () => {
    const backend = createAgentBackend({
      workspaceRoot,
      shellEnabled: false,
      crossFolderAccess: true,
    });
    const target = join(outsideDir, "created-by-agent.txt");
    const result = await backend.write(target, "跨目录写入成功");
    expect(result.error).toBeUndefined();
    // 真的落到了磁盘上。
    expect(await readFile(target, "utf8")).toContain("跨目录写入成功");
  });

  it("关闭时同样的绝对路径会被拒绝（对照旧行为）", async () => {
    const backend = createAgentBackend({
      workspaceRoot,
      shellEnabled: false,
      crossFolderAccess: false,
    });
    // 旧行为：virtualMode=true，越界路径由 backend 报错拒绝，不会读到内容。
    const result = await backend.read(outsideFile);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("outside root directory");
    expect(result.content).toBeUndefined();
  });

  it("关闭时仍可正常访问工作区内的文件", async () => {
    const insideFile = join(workspaceRoot, "inside.txt");
    await writeFile(insideFile, "工作区内的内容", "utf8");
    const backend = createAgentBackend({
      workspaceRoot,
      shellEnabled: false,
      crossFolderAccess: false,
    });
    const result = await backend.read("inside.txt");
    expect(result.error).toBeUndefined();
    expect(String(result.content)).toContain("工作区内的内容");
  });

  it("开启 Shell 时同样使用跨文件夹模式的后端", async () => {
    const backend = createAgentBackend({
      workspaceRoot,
      shellEnabled: true,
      crossFolderAccess: true,
    });
    // LocalShellBackend 继承自 FilesystemBackend，具备同样的读写能力。
    const result = await backend.read(outsideFile);
    expect(result.error).toBeUndefined();
    expect(String(result.content)).toContain("工作区之外的内容");
  });

  it("审批工具名与 deepagents 内置名称一致（删掉路径围栏后这是唯一防线）", () => {
    // deepagents 内置的删除工具名是 delete，不是 delete_file；
    // 名字写错等于该工具没有审批保护。
    expect(APPROVAL_TOOLS).toContain("delete");
    expect(APPROVAL_TOOLS).toContain("write_file");
    expect(APPROVAL_TOOLS).toContain("edit_file");
    expect(APPROVAL_TOOLS).toContain("execute");
  });
});
