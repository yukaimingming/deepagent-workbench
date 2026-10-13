import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
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

type EncodedBytes = string | number[];
type StoredCheckpoints = Record<string, Record<string, Record<string, [EncodedBytes, EncodedBytes, string?]>>>;
type StoredWrites = Record<string, Record<string, [string, string, EncodedBytes]>>;
interface StoredSnapshot { storage: StoredCheckpoints; writes: StoredWrites }

/** 每个线程每个命名空间最多保留的最近检查点数，防止文件无限膨胀。 */
const MAX_CHECKPOINTS_PER_NAMESPACE = 2;
/** 最多保留最近活跃的线程数。 */
const MAX_STORED_THREADS = 30;
/** 历史未裁剪的超大检查点文件上限（超过则跳过加载并重建，避免主线程卡死）。 */
const MAX_SNAPSHOT_FILE_BYTES = 15 * 1024 * 1024;
/** 防抖落盘间隔（毫秒），将一次运行中的多次节点写入合并为一次磁盘写入。 */
const PERSIST_DEBOUNCE_MS = 60;

function encodeBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function decodeBytes(encoded: EncodedBytes): Uint8Array {
  if (typeof encoded === "string") {
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }
  return Uint8Array.from(encoded);
}

/** 将 LangGraph 检查点写入本机文件，采用 Base64 编码、自动裁剪与非阻塞防抖落盘。 */
export class FileCheckpointSaver extends MemorySaver {
  private readonly ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(private readonly filePath: string) {
    super();
    this.ready = this.load();
  }

  async flush(): Promise<void> {
    await this.ready;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.dirty) {
      this.enqueuePersist();
    }
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
    this.pruneInMemory();
    this.schedulePersist();
    return result;
  }

  override async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    await this.ready;
    await super.putWrites(config, writes, taskId);
    this.schedulePersist();
  }

  override async deleteThread(threadId: string): Promise<void> {
    await this.ready;
    await super.deleteThread(threadId);
    this.schedulePersist();
  }

  /** 裁剪内存中多余的历史检查点与孤儿 writes，保持极小内存与磁盘占用。 */
  private pruneInMemory(): void {
    const threadIds = Object.keys(this.storage);
    if (threadIds.length > MAX_STORED_THREADS) {
      const toRemove = threadIds.slice(0, threadIds.length - MAX_STORED_THREADS);
      for (const tid of toRemove) {
        delete this.storage[tid];
      }
    }

    const validWriteKeys = new Set<string>();
    for (const [threadId, namespaces] of Object.entries(this.storage)) {
      for (const [namespace, checkpoints] of Object.entries(namespaces)) {
        const ids = Object.keys(checkpoints);
        if (ids.length > MAX_CHECKPOINTS_PER_NAMESPACE) {
          const dropIds = ids.slice(0, ids.length - MAX_CHECKPOINTS_PER_NAMESPACE);
          for (const dropId of dropIds) {
            delete checkpoints[dropId];
          }
        }
        for (const keptId of Object.keys(checkpoints)) {
          validWriteKeys.add( JSON.stringify([threadId, namespace, keptId]) );
        }
      }
    }

    for (const writeKey of Object.keys(this.writes)) {
      if (!validWriteKeys.has(writeKey)) {
        delete this.writes[writeKey];
      }
    }
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.debounceTimer) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.dirty) {
        this.enqueuePersist();
      }
    }, PERSIST_DEBOUNCE_MS);
    this.debounceTimer.unref?.();
  }

  private enqueuePersist(): void {
    this.dirty = false;
    this.writeQueue = this.writeQueue
      .then(async () => {
        this.pruneInMemory();
        const snapshot: StoredSnapshot = {
          storage: Object.fromEntries(
            Object.entries(this.storage).map(([threadId, namespaces]) => [
              threadId,
              Object.fromEntries(
                Object.entries(namespaces).map(([namespace, checkpoints]) => [
                  namespace,
                  Object.fromEntries(
                    Object.entries(checkpoints).map(([id, [checkpoint, metadata, parent]]) => [
                      id,
                      [encodeBytes(checkpoint), encodeBytes(metadata), parent] as [string, string, string?],
                    ]),
                  ),
                ]),
              ),
            ]),
          ),
          writes: Object.fromEntries(
            Object.entries(this.writes).map(([key, writes]) => [
              key,
              Object.fromEntries(
                Object.entries(writes).map(([writeId, [taskId, channel, value]]) => [
                  writeId,
                  [taskId, channel, encodeBytes(value)] as [string, string, string],
                ]),
              ),
            ]),
          ),
        };
        await mkdir(dirname(this.filePath), { recursive: true });
        const temporaryPath = `${this.filePath}.tmp`;
        const markdown = `# Agent 检查点\n\n> LangGraph 会话运行状态的本地持久化数据。\n\n\`\`\`json\n${JSON.stringify(snapshot)}\n\`\`\`\n`;
        await writeFile(temporaryPath, markdown, { encoding: "utf8", mode: 0o600 });
        await rename(temporaryPath, this.filePath);
      })
      .catch(() => {
        // 后台落盘异常不阻塞运行主流程。
      });
  }

  private async load(): Promise<void> {
    try {
      const info = await stat(this.filePath);
      if (info.size > MAX_SNAPSHOT_FILE_BYTES) {
        // 历史未裁剪的超大文件不再阻塞主线程解析，直接以空状态启动并在下次写入时覆盖为轻量文件。
        this.schedulePersist();
        return;
      }
      const snapshot = parseSnapshot(await readFile(this.filePath, "utf8"));
      for (const [threadId, namespaces] of Object.entries(snapshot.storage ?? {})) {
        this.storage[threadId] = Object.fromEntries(
          Object.entries(namespaces).map(([namespace, checkpoints]) => [
            namespace,
            Object.fromEntries(
              Object.entries(checkpoints).map(([id, [checkpoint, metadata, parent]]) => [
                id,
                [decodeBytes(checkpoint), decodeBytes(metadata), parent] as [
                  Uint8Array,
                  Uint8Array,
                  string | undefined,
                ],
              ]),
            ),
          ]),
        );
      }
      for (const [key, writes] of Object.entries(snapshot.writes ?? {})) {
        this.writes[key] = Object.fromEntries(
          Object.entries(writes).map(([writeId, [taskId, channel, value]]) => [
            writeId,
            [taskId, channel, decodeBytes(value)] as [string, string, Uint8Array],
          ]),
        );
      }
      this.pruneInMemory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function parseSnapshot(markdown: string): StoredSnapshot {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (!match?.[1]) throw new SyntaxError("检查点 Markdown 中缺少 JSON 数据块");
  return JSON.parse(match[1]) as StoredSnapshot;
}
