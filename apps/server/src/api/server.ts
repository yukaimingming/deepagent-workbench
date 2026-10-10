/**
 * 本地 HTTP 服务。
 *
 * 路由：
 *   GET  /api/health                 健康检查
 *   POST /agent                      AG-UI 运行端点（SSE）
 *   POST /agent/cancel              取消指定线程的运行
 *   GET  /api/providers             已配置提供商的非敏感信息
 *   POST /api/providers             新增提供商配置
 *   PUT  /api/providers/:id         更新提供商配置
 *   DELETE /api/providers/:id       删除配置
 *   POST /api/providers/:id/models  通过服务端获取模型列表
 *   POST /api/providers/:id/test    验证模型连接与简单响应
 *
 * 安全约束：
 * - 默认只监听 127.0.0.1。
 * - 任何响应体都不包含明文 API Key。
 * - 请求体经 Zod 校验。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { EventEncoder } from "@ag-ui/encoder";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { z } from "zod";
import { ConfigStore } from "../config/store.js";
import { DeepAgentAgui } from "../agent/deep-agent-agui.js";
import { fetchModels } from "../providers/model-list.js";
import { createModel } from "../providers/adapter.js";
import {
  providerInputSchema,
  providerUpdateSchema,
  toPublicProvider,
  type PublicProvider,
  type ProviderUpdate,
} from "@deepagent/shared";
import { resolveEffortForModel } from "@deepagent/shared";

/** 服务配置。 */
export interface ServerOptions {
  host?: string;
  port?: number;
  /** 数据目录（配置文件位置）。 */
  dataDir: string;
  /** Agent 工作区根目录。 */
  workspaceRoot: string;
  shellEnabled?: boolean;
  approvalRequired?: boolean;
  defaultEffort?: "low" | "medium" | "high";
  /** 注入 fetch 实现，便于测试时不发真实网络请求。 */
  fetchImpl?: typeof fetch;
}

const MAX_BODY_BYTES = 1_000_000;
/**
 * 本地开发/预览前端的来源端口白名单。
 * Vite dev 用 5173，vite preview 用 5175；端口被占用时 Vite 会自动顺延，
 * 所以放行整个 517x 段，避免换端口就被 403 挡掉。
 */
const DEV_WEB_ORIGIN_PORT_RANGE = [5173, 5174, 5175, 5176, 4173] as const;

/** AG-UI 消息的最小校验。 */
const messageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system", "tool", "developer"]),
  content: z.string(),
  name: z.string().optional(),
  toolCallId: z.string().optional(),
});

/** RunAgentInput 的校验 schema。 */
const runAgentInputSchema = z.object({
  threadId: z.string().min(1),
  runId: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  tools: z.array(z.unknown()).default([]),
  context: z.array(z.unknown()).default([]),
  state: z.unknown().optional(),
  forwardedProps: z.unknown().optional(),
  resume: z
    .array(
      z.object({
        interruptId: z.string(),
        status: z.enum(["resolved", "cancelled"]),
        payload: z.unknown().optional(),
      }),
    )
    .optional(),
});

export async function createApp(options: ServerOptions) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const dataDir = resolve(options.dataDir);
  let currentWorkspaceRoot = resolve(options.workspaceRoot);
  const processStartedAt = new Date().toISOString();

  await mkdir(dataDir, { recursive: true });
  await mkdir(currentWorkspaceRoot, { recursive: true });

  const store = new ConfigStore(dataDir);
  await store.load();

  const agent = new DeepAgentAgui({
    store,
    workspaceRoot: currentWorkspaceRoot,
    shellEnabled: options.shellEnabled ?? false,
    approvalRequired: options.approvalRequired ?? true,
    defaultEffort: options.defaultEffort ?? "medium",
  });

  const encoder = new EventEncoder({ accept: "text/event-stream" });
  const fetchImpl = options.fetchImpl;

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "服务端内部错误";
      // 异常详情只进服务端日志，不回给客户端。
      console.error("[server] 请求处理失败:", error);
      if (!res.headersSent) {
        sendJson(res, status, { error: status >= 500 ? "服务端内部错误" : message });
      } else {
        res.end();
      }
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
    if (origin && !isAllowedOrigin(origin)) {
      sendJson(res, 403, { error: "来源不被允许" });
      return;
    }
    setCors(res, origin);

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "GET" && path === "/api/workspace/tree") {
      const requestedRoot = url.searchParams.get("root");
      const targetRoot = requestedRoot ? resolve(requestedRoot) : currentWorkspaceRoot;
      const maxDepth = Number(url.searchParams.get("depth") ?? "3");
      try {
        const tree = await listWorkspaceTree(targetRoot, maxDepth);
        sendJson(res, 200, { ok: true, root: targetRoot, nodes: tree });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          root: targetRoot,
          nodes: [{ name: basename(targetRoot), path: targetRoot, type: "directory", children: [] }],
          message: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/workspace/select") {
      const body = await readJsonBody(req);
      const customPath = typeof body?.path === "string" ? body.path.trim() : "";
      if (!customPath) {
        sendJson(res, 400, { error: "缺少文件夹路径" });
        return;
      }
      const targetPath = resolve(customPath);
      try {
        await mkdir(targetPath, { recursive: true });
        currentWorkspaceRoot = targetPath;
        agent.setWorkspaceRoot(targetPath);
        const tree = await listWorkspaceTree(targetPath, 3);
        sendJson(res, 200, { ok: true, root: targetPath, nodes: tree });
      } catch (error) {
        sendJson(res, 500, {
          error: "无法创建或访问指定文件夹: " + (error instanceof Error ? error.message : String(error)),
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/workspace/mkdir") {
      const body = await readJsonBody(req);
      const parentDir = typeof body?.parentDir === "string" && body.parentDir.trim() ? resolve(body.parentDir.trim()) : currentWorkspaceRoot;
      const dirName = typeof body?.dirName === "string" ? body.dirName.trim() : "";
      if (!dirName) {
        sendJson(res, 400, { error: "缺少新建文件夹名称" });
        return;
      }
      const newDirPath = join(parentDir, dirName);
      try {
        await mkdir(newDirPath, { recursive: true });
        const tree = await listWorkspaceTree(currentWorkspaceRoot, 3);
        sendJson(res, 200, { ok: true, createdPath: newDirPath, nodes: tree });
      } catch (error) {
        sendJson(res, 500, {
          error: "创建文件夹失败: " + (error instanceof Error ? error.message : String(error)),
        });
      }
      return;
    }

    if (method === "GET" && path === "/api/workspace/browse") {
      const requestedPath = url.searchParams.get("path");
      const userProfile = process.env.USERPROFILE || process.env.HOME || "";
      const quickPaths: Array<{ name: string; path: string }> = [
        { name: "当前工作区", path: currentWorkspaceRoot },
        { name: "项目默认目录", path: resolve("d:/temp/langchain/workspace") },
      ];
      if (userProfile) {
        quickPaths.push({ name: "用户主目录", path: userProfile });
        quickPaths.push({ name: "桌面", path: join(userProfile, "Desktop") });
      }
      if (process.platform === "win32") {
        quickPaths.push({ name: "C 盘", path: "C:\\" });
        quickPaths.push({ name: "D 盘", path: "D:\\" });
      }

      const targetPath = requestedPath && requestedPath.trim() ? resolve(requestedPath.trim()) : currentWorkspaceRoot;
      try {
        const entries = await readdir(targetPath, { withFileTypes: true });
        const folders = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
          .map((e) => ({
            name: e.name,
            path: join(targetPath, e.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        const parent = dirname(targetPath) === targetPath ? null : dirname(targetPath);
        sendJson(res, 200, {
          ok: true,
          current: targetPath,
          parent,
          folders,
          quickPaths,
        });
      } catch (error) {
        sendJson(res, 200, {
          ok: false,
          current: targetPath,
          parent: dirname(targetPath) === targetPath ? null : dirname(targetPath),
          folders: [],
          quickPaths,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (method === "POST" && path === "/api/workspace/delete") {
      const body = await readJsonBody(req);
      const targetPath = typeof body?.path === "string" ? body.path.trim() : "";
      // 永久安全规范：工作区移除只允许解除关联，绝对禁止删除物理磁盘上的任何文件夹！
      sendJson(res, 200, {
        ok: true,
        message: "工作区已解除关联（保留物理磁盘所有文件）",
        path: targetPath,
      });
      return;
    }

    if (method === "GET" && path === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "deepagent-server",
        time: new Date().toISOString(),
        // 进程启动时间：用来确认当前在跑的是不是最新代码
        // （开发模式下 `tsx watch` 会在文件变更后自动重启）。
        startedAt: processStartedAt,
        workspaceRoot: currentWorkspaceRoot,
        shellEnabled: options.shellEnabled ?? false,
        approvalRequired: options.approvalRequired ?? true,
        providerCount: store.list().length,
      });
      return;
    }

    if (method === "POST" && path === "/agent") {
      await handleAgentRun(req, res);
      return;
    }

    if (method === "POST" && path === "/agent/cancel") {
      const body = await readJsonBody(req);
      const threadId = typeof body?.threadId === "string" ? body.threadId : null;
      if (!threadId) {
        sendJson(res, 400, { error: "缺少 threadId" });
        return;
      }
      const cancelled = agent.cancelThread(threadId);
      sendJson(res, 200, { ok: true, cancelled });
      return;
    }

    if (method === "GET" && path === "/api/providers") {
      const providers: PublicProvider[] = store.list().map(toPublicProvider);
      sendJson(res, 200, { providers });
      return;
    }

    if (method === "POST" && path === "/api/providers") {
      const body = await readJsonBody(req);
      const parsed = providerInputSchema.safeParse(body);
      if (!parsed.success) {
        sendJson(res, 400, { error: "配置校验失败", issues: formatZodIssues(parsed.error) });
        return;
      }
      const created = store.create(parsed.data);
      // 等待落盘再返回：避免用户看到「保存成功」但进程退出后配置丢失。
      await store.flush();
      sendJson(res, 201, { provider: toPublicProvider(created) });
      return;
    }

    const providerMatch = /^\/api\/providers\/([^/]+)(\/models|\/test)?$/.exec(path);
    if (providerMatch) {
      const id = decodeURIComponent(providerMatch[1] ?? "");
      const action = providerMatch[2];
      const existing = store.get(id);
      if (!existing) {
        sendJson(res, 404, { error: "提供商不存在" });
        return;
      }

      if (method === "PUT" && action === undefined) {
        const body = await readJsonBody(req);
        const parsed = providerUpdateSchema.safeParse(body);
        if (!parsed.success) {
          sendJson(res, 400, { error: "配置校验失败", issues: formatZodIssues(parsed.error) });
          return;
        }
        const updated = store.update(id, parsed.data);
        if (!updated) {
          sendJson(res, 404, { error: "提供商不存在" });
          return;
        }
        await store.flush();
        sendJson(res, 200, { provider: toPublicProvider(updated) });
        return;
      }

      if (method === "DELETE" && action === undefined) {
        const removed = store.remove(id);
        await store.flush();
        sendJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: "提供商不存在" });
        return;
      }

      if (method === "POST" && action === "/models") {
        const result = await fetchModels({
          type: existing.type,
          baseUrl: existing.baseUrl,
          apiKey: existing.apiKey,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (!result.ok) {
          // 失败时明确区分原因，不修改现有配置。
          sendJson(res, 200, {
            ok: false,
            errorKind: result.errorKind,
            message: result.message,
            hint: result.hint,
            models: [],
          });
          return;
        }
        // 获取成功时合并进配置，保留用户手动添加过的模型。
        const merged = [...new Set([...existing.models, ...result.models])];
        const updated = store.update(id, {
          ...toInput(existing),
          models: merged,
        });
        await store.flush();
        sendJson(res, 200, { ok: true, models: updated?.models ?? merged });
        return;
      }

      if (method === "POST" && action === "/test") {
        const body = await readJsonBody(req);
        const requestedModel = typeof body?.modelId === "string" ? body.modelId : undefined;
        const modelId = requestedModel ?? existing.defaultModel ?? existing.models[0];
        if (!modelId) {
          sendJson(res, 400, { error: "没有可测试的模型，请先设置默认模型或手动添加模型" });
          return;
        }
        const effort = resolveEffortForModel(modelId, "medium").effort;
        const resolution = createModel(existing, effort, modelId);
        const startedAt = Date.now();
        try {
          const response = await resolution.model.invoke("回复一个字：好", { timeout: 30_000 });
          const text =
            typeof response.content === "string"
              ? response.content
              : JSON.stringify(response.content);
          sendJson(res, 200, {
            ok: true,
            modelId,
            latencyMs: Date.now() - startedAt,
            reply: text.slice(0, 500),
            effortApplied: resolution.effort,
            effortField: resolution.appliedField,
            fallbackApplied: resolution.fallbackApplied,
            supportedEfforts: resolution.supported,
            reasoningUnsupported: resolution.reasoningUnsupported,
          });
        } catch (error) {
          sendJson(res, 200, {
            ok: false,
            modelId,
            latencyMs: Date.now() - startedAt,
            message: describeModelError(error),
          });
        }
        return;
      }
    }

    sendJson(res, 404, { error: "接口不存在" });
  }

  /** AG-UI 运行端点：把 Agent 事件以 SSE 写出。 */
  async function handleAgentRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody(req);
    const parsed = runAgentInputSchema.safeParse(body);
    if (!parsed.success) {
      sendJson(res, 400, { error: "请求体不是合法 RunAgentInput", issues: formatZodIssues(parsed.error) });
      return;
    }
    const input = parsed.data as RunAgentInput;

    res.writeHead(200, {
      "Content-Type": encoder.getContentType(),
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    let closed = false;
    res.on("close", () => {
      closed = true;
    });

    await new Promise<void>((resolvePromise) => {
      agent.run(input).subscribe({
        next: (event: BaseEvent) => {
          if (closed) return;
          res.write(encoder.encodeSSE(event));
        },
        error: (error: unknown) => {
          if (closed) {
            resolvePromise();
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          res.write(
            encoder.encodeSSE({
              type: EventType.RUN_ERROR,
              message,
            } as BaseEvent),
          );
          res.end();
          resolvePromise();
        },
        complete: () => {
          if (!closed) res.end();
          resolvePromise();
        },
      });
    });
  }

  return {
    server,
    store,
    agent,
    workspaceRoot: currentWorkspaceRoot,
    getWorkspaceRoot: () => currentWorkspaceRoot,
    async listen(): Promise<{ url: string; port: number; host: string }> {
      await new Promise<void>((resolvePromise) => {
        server.listen(port, host, () => resolvePromise());
      });
      return { url: `http://${host}:${port}`, port, host };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
  };

  function isAllowedOrigin(origin: string): boolean {
    try {
      const parsed = new URL(origin);
      const localHosts = ["localhost", "127.0.0.1", "[::1]", "::1"];
      if (!localHosts.includes(parsed.hostname)) return false;
      const originPort = parsed.port === "" ? 80 : Number(parsed.port);
      return (
        originPort === port ||
        (DEV_WEB_ORIGIN_PORT_RANGE as readonly number[]).includes(originPort)
      );
    } catch {
      return false;
    }
  }
}

/** 把内部配置转成可安全写回的输入对象（不含 apiKey，store 会保留原值）。 */
function toInput(config: {
  type: ProviderUpdate["type"];
  label: string;
  baseUrl: string;
  models: string[];
  defaultModel: string | null;
  enabled: boolean;
  reasoning?: ProviderUpdate["reasoning"];
}): ProviderUpdate {
  return {
    type: config.type,
    label: config.label,
    baseUrl: config.baseUrl,
    models: config.models,
    defaultModel: config.defaultModel,
    enabled: config.enabled,
    ...(config.reasoning ? { reasoning: config.reasoning } : {}),
  };
}

function setCors(res: ServerResponse, origin?: string): void {
  const allow = origin ?? "*";
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Accept");
  res.setHeader("Access-Control-Max-Age", "600");
}

/** 工作区目录树节点。 */
interface WorkspaceNode {
  name: string;
  path: string;
  type?: "directory" | "file";
  children?: WorkspaceNode[];
}

/**
 * 列出工作区下的真实目录树（包含目录与文件）。
 *
 * 限制深度，跳过 node_modules 与隐藏文件，目录排在前面。
 */
async function listWorkspaceTree(root: string, maxDepth: number): Promise<WorkspaceNode[]> {
  const walk = async (dir: string, depth: number): Promise<WorkspaceNode[]> => {
    if (depth > maxDepth) return [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: WorkspaceNode[] = [];
    const files: WorkspaceNode[] = [];
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push({
          name: entry.name,
          path: full,
          type: "directory",
          children: await walk(full, depth + 1),
        });
      } else {
        files.push({
          name: entry.name,
          path: full,
          type: "file",
        });
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  };

  return walk(root, 1);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "请求体过大");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function formatZodIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

/** 把模型调用错误转成用户可读的中文说明。 */
export function describeModelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/401|403|invalid.*api.*key|unauthorized/i.test(raw)) {
    return "鉴权失败：API Key 无效或没有该模型的访问权限。";
  }
  if (/429|rate limit/i.test(raw)) {
    return "请求被限流：请稍后重试，或降低请求频率。";
  }
  if (/timeout|ETIMEDOUT|aborted/i.test(raw)) {
    return "请求超时：请检查网络或 Base URL 是否正确。";
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(raw)) {
    return "无法连接到服务：请确认 Base URL 可访问，本地服务是否已启动。";
  }
  if (/model.*not.*found|does not exist|unknown model/i.test(raw)) {
    return "模型不存在：请确认模型 ID 是否正确。";
  }
  return raw.slice(0, 500);
}
