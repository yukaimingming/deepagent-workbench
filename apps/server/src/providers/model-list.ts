/**
 * 模型列表获取。
 *
 * 约束（AGENTS.md 第 9.2 节）：
 * - 必须由服务端执行，避免浏览器 CORS 与密钥泄露。
 * - 正确处理 Base URL 已含路径前缀的情况，不能盲目拼 `/models`。
 * - 区分 HTTP 错误、认证错误、网络错误、接口不支持、空结果，
 *   不能把「空列表」误判为「密钥无效」。
 */

import type { ProviderType } from "@deepagent/shared";

/** 获取模型列表的结果。 */
export interface ModelListResult {
  ok: boolean;
  /** 模型 ID 列表；失败时为空数组。 */
  models: string[];
  /** 失败类别，用于前端展示不同提示。 */
  errorKind?: "auth" | "network" | "http" | "unsupported" | "empty" | "unknown";
  /** 面向用户的错误说明。 */
  message?: string;
  /** 建议的兜底动作。 */
  hint?: string;
}

interface FetchModelsOptions {
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  /** 注入 fetch 以便测试。 */
  fetchImpl?: typeof fetch;
  /** 超时毫秒数。 */
  timeoutMs?: number;
}

/** 拼接模型列表端点 URL。 */
export function buildModelsUrl(baseUrl: string, type: ProviderType): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  // 已经显式包含 /models 时不重复追加。
  if (/\/models$/i.test(trimmed)) return trimmed;
  // Anthropic 官方没有列出全部模型的公开端点；使用其 models 端点，
  // 失败时由调用方引导用户手动输入。
  if (type === "anthropic") return `${trimmed}/models`;
  return `${trimmed}/models`;
}

/** 从响应 JSON 中提取模型 ID，兼容 {data:[{id}]} 与 {models:[...]} 等形状。 */
export function extractModelIds(payload: unknown): string[] {
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) seen.add(value.trim());
  };
  const walk = (node: unknown, depth: number): void => {
    if (depth > 4 || node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    // 常见形状：{ data: [{id}] } / { models: [{id}] } / { data: ["id"] }
    for (const key of ["data", "models", "items", "result"]) {
      const list = record[key];
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (typeof entry === "string") push(entry);
          else if (entry && typeof entry === "object") {
            const id = (entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).name;
            push(id);
          }
        }
        return;
      }
    }
    // 兜底：任何数组字段都尝试解析。
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) walk({ data: value }, depth + 1);
    }
  };
  walk(payload, 0);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** 判断是否为 Anthropic 风格的鉴权头。 */
function authHeaders(type: ProviderType, apiKey: string): Record<string, string> {
  if (type === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      Accept: "application/json",
    };
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
  };
}

/** 获取模型列表，错误分类明确。 */
export async function fetchModels(options: FetchModelsOptions): Promise<ModelListResult> {
  const { type, baseUrl, apiKey } = options;
  // 每次调用时读取，便于测试注入；默认用全局 fetch。
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const url = buildModelsUrl(baseUrl, type);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: authHeaders(type, apiKey),
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        models: [],
        errorKind: "auth",
        message: "鉴权失败：API Key 无效或没有访问该接口的权限。",
        hint: "请检查 API Key 是否正确、是否已过期；确认后重试。",
      };
    }
    if (response.status === 404 || response.status === 405) {
      return {
        ok: false,
        models: [],
        errorKind: "unsupported",
        message: `该提供商的 ${url} 不支持列出模型。`,
        hint: "请手动添加模型 ID。",
      };
    }
    if (!response.ok) {
      const body = await safeReadBody(response);
      return {
        ok: false,
        models: [],
        errorKind: "http",
        message: `请求失败（HTTP ${response.status}）。`,
        hint: body ? `服务端返回：${body}` : "请检查 Base URL 与网络状况。",
      };
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return {
        ok: false,
        models: [],
        errorKind: "unsupported",
        message: "响应不是合法 JSON，无法解析模型列表。",
        hint: "该接口可能返回了 HTML 页面；请手动添加模型 ID。",
      };
    }

    const models = extractModelIds(payload);
    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        errorKind: "empty",
        message: "接口返回成功，但模型列表为空。",
        hint: "这不代表密钥无效；请手动添加模型 ID。",
      };
    }
    return { ok: true, models };
  } catch (error) {
    const isAbort = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      models: [],
      errorKind: "network",
      message: isAbort ? `请求超时（${timeoutMs} ms）。` : `网络错误：${(error as Error).message}`,
      hint: "请确认 Base URL 可访问、服务已启动，并且本机网络正常。",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}
