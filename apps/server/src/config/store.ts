/**
 * 服务端配置存储。
 *
 * 约束（来自 AGENTS.md 第 9.3 / 13 节）：
 * - API Key 只存服务端，落盘到 `.data/providers.json`（已在 .gitignore）。
 * - 文件权限限制为仅当前用户可读写。
 * - 任何返回路径都不包含明文密钥。
 */

import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ProviderConfig, ProviderInput, ProviderType, ProviderUpdate } from "@deepagent/shared";
import { DEFAULT_BASE_URLS } from "@deepagent/shared";

/** 磁盘上的配置结构。 */
interface StoreShape {
  version: 1;
  providers: ProviderConfig[];
}

const EMPTY_STORE: StoreShape = { version: 1, providers: [] };

export class ConfigStore {
  private readonly filePath: string;
  private providers: ProviderConfig[] = [];
  private loaded = false;
  /** 串行化写入，避免并发写覆盖。 */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = join(dataDir, "providers.json");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as StoreShape;
      this.providers = Array.isArray(parsed.providers) ? parsed.providers : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 文件不存在是首次启动的正常情况；其他错误必须抛出而不是静默吞掉。
      if (code !== "ENOENT") {
        throw new Error(`读取配置文件失败：${(error as Error).message}`, { cause: error });
      }
      this.providers = [];
    }
    this.loaded = true;
  }

  list(): ProviderConfig[] {
    return this.providers.map((provider) => ({ ...provider }));
  }

  get(id: string): ProviderConfig | undefined {
    const found = this.providers.find((provider) => provider.id === id);
    return found ? { ...found } : undefined;
  }

  /** 取当前默认启用的提供商；优先使用 activeId 指定的那个。 */
  getActive(activeId?: string | null): ProviderConfig | null {
    if (activeId) {
      const target = this.get(activeId);
      if (target && target.enabled) return target;
    }
    const enabled = this.providers.filter((provider) => provider.enabled);
    if (enabled.length === 0) return null;
    const withDefault = enabled.find((provider) => provider.defaultModel);
    return withDefault ?? enabled[0] ?? null;
  }

  create(input: ProviderInput): ProviderConfig {
    const now = new Date().toISOString();
    const config: ProviderConfig = {
      id: randomUUID(),
      type: input.type,
      label: input.label,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      models: input.models,
      defaultModel: input.defaultModel,
      enabled: input.enabled,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),
      createdAt: now,
      updatedAt: now,
    };
    this.providers.push(config);
    this.schedulePersist();
    return { ...config };
  }

  /**
   * 更新提供商配置。
   *
   * `apiKey` 可省略或传空串，表示保留原有密钥，
   * 这样前端保存其他字段时不必重新输入密钥。
   */
  update(id: string, patch: ProviderUpdate): ProviderConfig | undefined {
    const index = this.providers.findIndex((provider) => provider.id === id);
    if (index === -1) return undefined;
    const current = this.providers[index];
    if (!current) return undefined;
    const next: ProviderConfig = {
      ...current,
      type: patch.type ?? current.type,
      label: patch.label ?? current.label,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      models: patch.models ?? current.models,
      defaultModel:
        patch.defaultModel === undefined ? current.defaultModel : patch.defaultModel,
      enabled: patch.enabled ?? current.enabled,
      ...(patch.reasoning
        ? { reasoning: patch.reasoning }
        : patch.reasoning === null
          ? { reasoning: undefined }
          : {}),
      apiKey: patch.apiKey && patch.apiKey.length > 0 ? patch.apiKey : current.apiKey,
      updatedAt: new Date().toISOString(),
    };
    this.providers[index] = next;
    this.schedulePersist();
    return { ...next };
  }

  remove(id: string): boolean {
    const before = this.providers.length;
    this.providers = this.providers.filter((provider) => provider.id !== id);
    const changed = this.providers.length !== before;
    if (changed) this.schedulePersist();
    return changed;
  }

  /** 用测试/种子数据初始化（仅在数据目录为空时使用）。 */
  seed(configs: Array<Omit<ProviderConfig, "id" | "createdAt" | "updatedAt">>): void {
    if (this.providers.length > 0) return;
    const now = new Date().toISOString();
    this.providers = configs.map((config) => ({
      ...config,
      id: randomUUID(),
      createdAt: now,
      updatedAt: now,
    }));
    this.schedulePersist();
  }

  /**
   * 等待所有排队中的写入落盘。
   *
   * 写操作本身是「排队 + 后台执行」，请求可以在落盘完成前就返回；
   * 但对「保存配置」这类用户会立刻去检查结果的操作，等待落盘能避免
   * 进程在写盘前退出导致配置看似保存成功、重启后却丢失。
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  private schedulePersist(): void {
    this.writeChain = this.writeChain
      .then(() => this.persist())
      .catch((error: unknown) => {
        // 落盘失败不能中断请求流程，但必须在服务端日志留下痕迹。
        console.error("[config] 持久化失败:", error);
      });
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const payload: StoreShape = { version: 1, providers: this.providers };
    await writeFile(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    try {
      // 限制文件权限：仅属主可读写（Windows 上此调用会被忽略）。
      await chmod(this.filePath, 0o600);
    } catch {
      // 平台不支持时忽略。
    }
  }
}

/** 构造一个提供商类型的默认配置草稿，供前端表单预填。 */
export function draftProvider(type: ProviderType, label: string): Omit<ProviderConfig, "id" | "createdAt" | "updatedAt"> {
  return {
    type,
    label,
    baseUrl: DEFAULT_BASE_URLS[type],
    apiKey: "",
    models: [],
    defaultModel: null,
    enabled: true,
  };
}

export function emptyStore(): StoreShape {
  return EMPTY_STORE;
}
