import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MemorySaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

type StoredCheckpoints = Record<string, Record<string, Record<string, [number[], number[], string?]>>>;
type StoredWrites = Record<string, Record<string, [string, string, number[]]>>;
interface StoredSnapshot { storage: StoredCheckpoints; writes: StoredWrites }

/** 将 LangGraph 检查点写入本机 JSON 文件，避免依赖原生模块编译。 */
export class FileCheckpointSaver extends MemorySaver {
  private readonly ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {
    super();
    this.ready = this.load();
  }

  async flush(): Promise<void> {
    await this.ready;
    await this.writeQueue;
  }

  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    await this.ready;
    return super.getTuple(config);
  }

  override async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    await this.ready;
    yield* super.list(config, options);
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    await this.ready;
    const result = await super.put(config, checkpoint, metadata);
    await this.persist();
    return result;
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.ready;
    await super.putWrites(config, writes, taskId);
    await this.persist();
  }

  override async deleteThread(threadId: string): Promise<void> {
    await this.ready;
    await super.deleteThread(threadId);
    await this.persist();
  }

  private async load(): Promise<void> {
    try {
      const snapshot = parseSnapshot(await readFile(this.filePath, "utf8"));
      for (const [threadId, namespaces] of Object.entries(snapshot.storage ?? {})) {
        this.storage[threadId] = Object.fromEntries(Object.entries(namespaces).map(([namespace, checkpoints]) => [
          namespace,
          Object.fromEntries(Object.entries(checkpoints).map(([id, [checkpoint, metadata, parent]]) => [
            id,
            [Uint8Array.from(checkpoint), Uint8Array.from(metadata), parent] as [Uint8Array, Uint8Array, string | undefined],
          ])),
        ]));
      }
      for (const [key, writes] of Object.entries(snapshot.writes ?? {})) {
        this.writes[key] = Object.fromEntries(Object.entries(writes).map(([writeId, [taskId, channel, value]]) => [
          writeId,
          [taskId, channel, Uint8Array.from(value)] as [string, string, Uint8Array],
        ]));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const snapshot: StoredSnapshot = {
        storage: Object.fromEntries(Object.entries(this.storage).map(([threadId, namespaces]) => [
          threadId,
          Object.fromEntries(Object.entries(namespaces).map(([namespace, checkpoints]) => [
            namespace,
            Object.fromEntries(Object.entries(checkpoints).map(([id, [checkpoint, metadata, parent]]) => [
              id,
              [Array.from(checkpoint), Array.from(metadata), parent] as [number[], number[], string?],
            ])),
          ])),
        ])),
        writes: Object.fromEntries(Object.entries(this.writes).map(([key, writes]) => [
          key,
          Object.fromEntries(Object.entries(writes).map(([writeId, [taskId, channel, value]]) => [
            writeId,
            [taskId, channel, Array.from(value)] as [string, string, number[]],
          ])),
        ])),
      };
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporaryPath = `${this.filePath}.tmp`;
      const markdown = `# Agent 检查点\n\n> LangGraph 会话运行状态的本地持久化数据。\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`;
      await writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }
}

function parseSnapshot(markdown: string): StoredSnapshot {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (!match?.[1]) throw new SyntaxError("检查点 Markdown 中缺少 JSON 数据块");
  return JSON.parse(match[1]) as StoredSnapshot;
}
