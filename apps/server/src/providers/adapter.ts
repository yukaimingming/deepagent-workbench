/**
 * 模型提供商适配层。
 *
 * 职责：把 `ProviderConfig` 转成 LangChain 模型实例，并把规范化的推理强度
 * 转成各提供商真实的参数字段。
 *
 * 关键约束（AGENTS.md 第 10 节）：
 * - 不能假设所有厂商都用同一个字段名。
 * - StepFun 走 OpenAI-compatible 通道，但 `step-3.5-flash-2603` 只允许
 *   low / high，绝不能把 medium 透传下去。
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  isTwoTierModel,
  resolveEffortForModel,
  type ProviderConfig,
  type ReasoningEffort,
} from "@deepagent/shared";

/**
 * OpenAI 兼容服务的 tool_calls 补全 fetch。
 *
 * 为什么需要：DeepAgent 多轮工具调用时，LangChain 会把上一轮 assistant
 * 消息里的 tool_calls 回传给提供商。部分 OpenAI-compatible 服务（实测
 * StepFun 的 step-3.5-flash-2603）在历史里出现缺字段的 tool_calls 时会
 * 直接返回 400：`tool_calls.id and tool_calls.type are required`。
 *
 * 为什么在 fetch 层修而不是中间件：`createDeepAgent` 的 `middleware` 参数
 * 经实测不会把自定义 `wrapModelCall` 织进模型调用链（加日志验证过，
 * 零调用）。fetch 层是唯一确定能拦到每一次请求的位置。
 *
 * 只补缺失字段，不覆盖已有值；非聊天请求原样放行。
 */
/** 导出供单元测试直接验证补全逻辑。 */
export function createToolCallCompatFetch(): typeof fetch {
  return async (input, init) => {
    if (!init?.body || typeof init.body !== "string") {
      return fetch(input, init);
    }
    let patched: string | undefined;
    try {
      const payload = JSON.parse(init.body) as {
        messages?: Array<{ role?: string; tool_calls?: unknown[] }>;
        tools?: unknown[];
      };
      const messages = payload.messages;
      if (Array.isArray(messages)) {
        let changed = false;
        for (const [index, message] of messages.entries()) {
          if (message?.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
          message.tool_calls = message.tool_calls.map((raw, callIndex) => {
            if (!raw || typeof raw !== "object") return raw;
            const record = raw as Record<string, unknown>;
            const fn = (record.function ?? {}) as Record<string, unknown>;
            // 一律用长度判断：StepFun 实测会返回 id/name 为空串的 tool_call，
            // typeof 检查拦不住，但空值回传后 StepFun 会报 400。
            const hasId = typeof record.id === "string" && record.id.length > 0;
            const hasType = record.type === "function";
            const fnNameStr = typeof fn.name === "string" ? fn.name : "";
            const hasFnName = fnNameStr.length > 0;
            const hasFnArgs = typeof fn.arguments === "string";
            if (hasId && hasType && hasFnName && hasFnArgs) return raw;
            changed = true;
            // name 可能被拍平到顶层（部分兼容服务这样返回），此时搬进 function。
            const flatName = typeof record.name === "string" && record.name.length > 0 ? record.name : "";
            const resolvedName = hasFnName ? fnNameStr : flatName;
            const resolvedArgs = hasFnArgs
              ? (fn.arguments as string)
              : typeof record.arguments === "string"
                ? (record.arguments as string)
                : "{}";
            return {
              ...record,
              ...(hasId ? {} : { id: `call_compat_${index}_${callIndex}` }),
              ...(hasType ? {} : { type: "function" }),
              function: {
                name: resolvedName || "unknown_tool",
                arguments: resolvedArgs,
              },
            };
          });
        }
        if (changed) patched = JSON.stringify(payload);
      }
    } catch {
      // 请求体不是 JSON（不应发生），原样放行。
    }

    const response = await fetch(input, patched === undefined ? init : { ...init, body: patched });

    // 响应侧也要修：StepFun 实测会返回 name 为空串的 tool_call，
    // LangChain 原样透传给 Agent，导致 Agent 不知道该调什么工具
    // （界面表现为「工具名无效」的反复重试）。这里按 index 从请求的
    // tools 列表反推出真实工具名补回去。
    // 响应侧修补：StepFun 实测会返回 name 为空串的 tool_call，
    // LangChain 原样透传给 Agent，导致 Agent 不知道该调什么工具
    // （界面表现为「工具名无效」的反复重试）。
    //
    // 流式与非流式都要修，但方式不同：
    // - 流式（text/event-stream）：逐块解析 SSE，只补含 tool_calls 的块，
    //   其余原样转发，保持逐字输出。
    // - 非流式（application/json）：整体解析后修补。
    const contentType = response.headers.get("content-type") ?? "";
    const toolNames = extractToolNames(init?.body);
    if (toolNames.length === 0 || !response.body) return response;

    if (contentType.includes("text/event-stream")) {
      return patchSseToolCallNames(response);
    }
    if (!contentType.includes("application/json")) return response;

    try {
      const text = await response.text();
      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { tool_calls?: unknown[] } }>;
      };
      const toolCalls = parsed.choices?.[0]?.message?.tool_calls;
      if (!Array.isArray(toolCalls)) {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      let changed = false;
      const fixed = toolCalls.map((raw, position) => {
        const patched = patchToolCallName(raw, toolNames, position);
        if (patched !== raw) changed = true;
        return patched;
      });

      const bodyText = changed
        ? JSON.stringify({
            ...parsed,
            choices: [
              {
                ...(parsed.choices?.[0] ?? {}),
                message: { ...(parsed.choices?.[0]?.message ?? {}), tool_calls: fixed },
              },
            ],
          })
        : text;

      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      // 响应体解析失败时原样返回。
      return response;
    }
  };
}

/**
 * 补全非流式单个 tool_call 的 function.name。
 *
 * 只在非流式整包响应且 name 为空串时动作；用 tool_call 自带的 index
 * 从请求的 tools 列表反推真实工具名。
 */
function patchToolCallName(raw: unknown, toolNames: string[], position: number): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const record = raw as Record<string, unknown>;
  const fn = (record.function ?? {}) as Record<string, unknown>;
  const fnName = typeof fn.name === "string" ? fn.name : "";
  if (fnName.length > 0) return raw;

  const rawIndex = record.index;
  const slot =
    typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : position;
  const fallback = toolNames[slot];
  if (!fallback) return raw;
  return { ...record, function: { ...fn, name: fallback } };
}

/**
 * 清洗流式 SSE 增量中的 tool_call。
 *
 * 核心修复：StepFun 等 OpenAI-compatible 服务在流式后续 chunk 中会返回
 * `id: ""`, `type: ""`, `function: { name: "", arguments: "..." }`。
 * 若保留这些空字符串，LangChain 在合并 chunk 时会用空字符串或错误默认值覆盖
 * 第一块中真正返回的真实 tool name（如 execute、write_todos）和真实 ID！
 * 因此必须删除空字段，只保留合法的增量 arguments。
 */
function cleanSseToolCallDelta(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const record = { ...(raw as Record<string, unknown>) };
  let modified = false;

  // 如果 id 是空串，清理掉，避免覆盖第一块真实的 id
  if (record.id === "") {
    delete record.id;
    modified = true;
  }
  // 如果 type 是空串，清理掉
  if (record.type === "") {
    delete record.type;
    modified = true;
  }
  if (record.function && typeof record.function === "object") {
    const fn = { ...(record.function as Record<string, unknown>) };
    // 如果 name 是空串，清理掉，绝不能篡改第一块真实的 name！
    if (fn.name === "") {
      delete fn.name;
      modified = true;
    }
    record.function = fn;
  }
  return modified ? record : raw;
}

/**
 * 逐块清洗 SSE 流里的 tool_call。
 */
function patchSseToolCallNames(response: Response): Response {
  const body = response.body;
  if (!body) return response;
  const reader = body.getReader();

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(patchSseBlock(buffer)));
          buffer = "";
        }
        controller.close();
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        controller.enqueue(encoder.encode(`${patchSseBlock(block)}\n\n`));
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** 清洗单个 SSE data 块（不含分隔空行）。 */
function patchSseBlock(block: string): string {
  if (!block.includes("tool_calls")) return block;
  const lines = block.split("\n");
  let patched = false;
  const out = lines.map((line) => {
    if (!line.startsWith("data: ")) return line;
    const json = line.slice("data: ".length).trim();
    if (!json.startsWith("{")) return line;
    try {
      const parsed = JSON.parse(json) as {
        choices?: Array<{ delta?: { tool_calls?: unknown[] }; message?: { tool_calls?: unknown[] } }>;
      };
      const choice = parsed.choices?.[0];
      if (!choice) return line;
      const container = choice.delta ?? choice.message;
      const calls = container?.tool_calls;
      if (!Array.isArray(calls)) return line;
      const fixed = calls.map((raw) => cleanSseToolCallDelta(raw));
      if (fixed.every((value, index) => value === calls[index])) return line;
      patched = true;
      return `data: ${JSON.stringify({ ...parsed, choices: [{ ...choice, ...(choice.delta ? { delta: { ...choice.delta, tool_calls: fixed } } : { message: { ...choice.message, tool_calls: fixed } }) }] })}`;
    } catch {
      return line;
    }
  });
  return patched ? out.join("\n") : block;
}

/** 从请求体里取出工具名列表（顺序对应 tool_call 的 index）。 */
function extractToolNames(body: unknown): string[] {
  if (typeof body !== "string") return [];
  try {
    const payload = JSON.parse(body) as {
      tools?: Array<{ function?: { name?: string }; name?: string }>;
    };
    if (!Array.isArray(payload.tools)) return [];
    return payload.tools
      .map((tool) => tool?.function?.name ?? tool?.name ?? "")
      .filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

/** 模型实例 + 适配器如何设置了推理参数的说明（供 UI 提示）。 */
export interface ModelResolution {
  model: BaseChatModel;
  /** 实际生效的推理强度。 */
  effort: ReasoningEffort;
  /** 是否发生了能力回落（例如两档模型上选了 medium）。 */
  fallbackApplied: boolean;
  /** 该模型支持的档位。 */
  supported: readonly ReasoningEffort[];
  /** 使用的底层字段名，用于 UI 说明；未设置时为 null。 */
  appliedField: "reasoning.effort" | "outputConfig.effort" | null;
  /** 该提供商是否根本不支持推理强度参数。 */
  reasoningUnsupported: boolean;
}

/** OpenAI reasoning effort 合法值。 */
const OPENAI_EFFORTS = ["low", "medium", "high"] as const;

function isOpenAiEffort(value: string): value is (typeof OPENAI_EFFORTS)[number] {
  return (OPENAI_EFFORTS as readonly string[]).includes(value);
}

/**
 * 构造模型实例。
 *
 * @param config 提供商配置
 * @param effort 规范化前的推理强度（会按模型能力校验）
 * @param modelIdOverride 覆盖默认模型（用于「连接测试」时临时指定模型）
 */
export function createModel(
  config: ProviderConfig,
  effort: unknown,
  modelIdOverride?: string,
): ModelResolution {
  const modelId = modelIdOverride ?? config.defaultModel ?? config.models[0] ?? "";
  const resolved = resolveEffortForModel(modelId, effort);
  const unsupported = config.reasoning?.unsupported === true;

  switch (config.type) {
    case "anthropic":
      return buildAnthropic(config, modelId, resolved, unsupported);
    case "openai":
      return buildOpenAi(config, modelId, resolved, unsupported);
    case "stepfun":
    case "openai-compatible":
    default:
      return buildOpenAiCompatible(config, modelId, resolved, unsupported);
  }
}

interface ResolvedEffort {
  effort: ReasoningEffort;
  fallbackApplied: boolean;
  supported: readonly ReasoningEffort[];
}

function buildAnthropic(
  config: ProviderConfig,
  modelId: string,
  resolved: ResolvedEffort,
  unsupported: boolean,
): ModelResolution {
  // Anthropic 用 outputConfig.effort 表达推理强度（部分旧模型用 thinking）。
  // 显式关闭推理强度时不下发该字段，让模型按自己的默认行为运行。
  const outputConfig = unsupported ? undefined : { effort: resolved.effort };
  const model = new ChatAnthropic({
    model: modelId,
    apiKey: config.apiKey,
    anthropicApiUrl: config.baseUrl,
    maxRetries: 2,
    ...(outputConfig ? { outputConfig } : {}),
  });
  return {
    model,
    effort: resolved.effort,
    fallbackApplied: resolved.fallbackApplied,
    supported: resolved.supported,
    appliedField: outputConfig ? "outputConfig.effort" : null,
    reasoningUnsupported: unsupported,
  };
}

function buildOpenAi(
  config: ProviderConfig,
  modelId: string,
  resolved: ResolvedEffort,
  unsupported: boolean,
): ModelResolution {
  const canApply = !unsupported && isOpenAiEffort(resolved.effort);
  const model = new ChatOpenAI({
    model: modelId,
    apiKey: config.apiKey,
    ...(canApply ? { reasoning: { effort: resolved.effort } } : {}),
    maxRetries: 2,
    // 必须显式开启：ChatOpenAI 默认 streaming: false，LangGraph 会退化成
    // invoke，于是整个响应一次性返回，前端看到的就是「蹦出来」而不是流式。
    streaming: true,
    configuration: {
      fetch: createToolCallCompatFetch(),
    },
  });
  return {
    model,
    effort: resolved.effort,
    fallbackApplied: resolved.fallbackApplied,
    supported: resolved.supported,
    appliedField: canApply ? "reasoning.effort" : null,
    reasoningUnsupported: unsupported,
  };
}

function buildOpenAiCompatible(
  config: ProviderConfig,
  modelId: string,
  resolved: ResolvedEffort,
  unsupported: boolean,
): ModelResolution {
  const canApply = !unsupported && isOpenAiEffort(resolved.effort);
  const model = new ChatOpenAI({
    model: modelId,
    apiKey: config.apiKey,
    configuration: {
      baseURL: config.baseUrl,
      fetch: createToolCallCompatFetch(),
    },
    // OpenAI-compatible 接口未必接受 reasoning 字段；仅在确定合法时下发。
    ...(canApply ? { reasoning: { effort: resolved.effort } } : {}),
    maxRetries: 2,
    // 同上：不开 streaming 就没有逐字输出。
    streaming: true,
  });
  return {
    model,
    effort: resolved.effort,
    fallbackApplied: resolved.fallbackApplied,
    supported: resolved.supported,
    appliedField: canApply ? "reasoning.effort" : null,
    reasoningUnsupported: unsupported,
  };
}

/** 判断某个模型是否只支持两档（导出供测试与 UI 复用）。 */
export { isTwoTierModel };
