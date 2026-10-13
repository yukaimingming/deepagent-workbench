import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { FileCheckpointSaver } from "../src/config/file-checkpoint-saver.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("FileCheckpointSaver", () => {
  it("跨实例恢复线程检查点", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deepagent-checkpoint-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "checkpoints.json");
    const config = { configurable: { thread_id: "thread-persist-test" } };
    const saver = new FileCheckpointSaver(path);
    const checkpoint = emptyCheckpoint();
    checkpoint.channel_values = { messages: [{ type: "human", content: "恢复测试" }] };

    await saver.put(config, checkpoint, { source: "input", step: 1, parents: {} });
    await saver.flush();

    const markdown = await readFile(path, "utf8");
    expect(markdown).toContain("# Agent 检查点");
    expect(markdown).toContain("```json");
    const restored = await new FileCheckpointSaver(path).getTuple(config);
    expect(restored?.checkpoint.channel_values.messages).toEqual(checkpoint.channel_values.messages);
  });
});
