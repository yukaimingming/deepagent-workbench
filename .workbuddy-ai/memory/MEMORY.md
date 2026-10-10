# MEMORY.md — deepagent-workbench 项目长期约定

## 项目性质
本地 DeepAgent 工作台：`deepagents`(Deep Agents JS) + AG-UI 协议 + React/AI SDK Elements。
pnpm workspace：`apps/server`（本地 HTTP 服务，tsx 运行）、`apps/web`（Vite + React）、`packages/shared`（类型与 Zod schema）。

## 必须遵守的架构约束（来自 AGENTS.md）
- API Key 只存服务端 `.data/providers.json`，前端只拿掩码；不写 localStorage / 日志 / bundle。
- 不把模型原始隐藏思维链发给前端；只传 `sanitizeReasoning` 过滤后的公开进度摘要。
- 高风险工具（`write_file` / `edit_file` / `delete` / `execute`）一律走 `interruptOn` 人工审批。
- 多线程并发是硬需求：**任何跨 run 的模块级共享状态都是 bug**。
  已踩过的坑：`client-reducer.ts` 里 `reasoningToAssistant` / `textToAssistant` 两个 Map 曾是全局的，
  并发会话会互相覆盖绑定，表现为「正文流到一半消失」。现已改为 `<threadId>::<messageId>` 作为 key。

## 前端运行时设计（勿回退）
- `use-agent-client.ts` 是**多会话运行时**：`threads: Record<threadId, ClientState>` + `runningMap` +
  `agentsRef: Map<threadId, HttpAgent>`。每个会话有独立状态与独立 HttpAgent。
- `threadsRef` / `runningRef` / `activeThreadIdRef` 是权威副本。事件回调是异步的，**不要读 React state 快照**，
  否则并发会话会读到过期状态。
- `newThread()` 只创建并切换新线程，绝不触碰其它运行中的会话；删除会话走 `disposeThread()`。
- 会话状态持久化在 localStorage（`use-sessions.ts`），自动保存遍历 `allStates`，后台会话也能落盘。

## 访问边界（2026-10-10 变更）
- 用户明确要求**跨文件夹访问**：`createAgentBackend()` 以 `virtualMode: !crossFolderAccess` 构造，
  默认 `crossFolderAccess = true` → `virtualMode: false`，绝对路径可访问工作区之外。
- `workspaceRoot` 只作为相对路径与 Shell 的默认基准目录，**不再是安全边界**。
- 唯一防线是写/改/删/执行的人工审批。若要收紧，把 `createAgentBundle` 的 `crossFolderAccess` 设为 `false`。

## 已知未对齐项
- `apps/web/tests/reasoning-stream.test.ts` 有 4 个用例与实现设计冲突（改动前即失败，已用对照实验证明）：
  期望 `REASONING_MESSAGE_END` 后立刻关流式标记、期望第二轮 reasoning 另起一条消息；
  而实现是「一个用户轮次只对应一条助手气泡」+「等待工具期间保持思考流式」。**动之前先问用户。**
- 仓库仍有 7 个既有 ESLint 错误（`App.tsx` set-state-in-effect、`chat-input.tsx` / `chat-messages.tsx` 未使用变量、
  `folder-picker-modal.tsx` 同类）。`pnpm lint` 目前不是干净的。

## 验证脚本（可复用）
- `scripts/verify-provider-save.mjs`：真实浏览器走「添加厂商 → 保存 → 落盘」全流程，自动清理测试数据。
- `scripts/verify-concurrent-sessions.mjs`：本地假模型 SSE 服务 + 浏览器，验证「运行中新建对话不打断后台执行」，
  不消耗真实 API。两个脚本都要求服务端 8787 + 前端在跑（默认 5175，可用 `VERIFY_APP_URL` 覆盖）。
- `scripts/verify-rate-limit-resilience.mjs`：假模型返回 429，验证服务端进程不被限流打崩。

## ⚠️ 并行编辑风险（2026-10-10 实测）
- 这个仓库会被**其它会话/其它 agent 同时修改**。实测我加的改动被回退过（`deep-agent-agui.ts` 的 `handle` 守卫、
  放开 `forwardedProps.workspaceRoot` 的校验）。
- **动手前先看 mtime**（`ls -la --time-style=+%H:%M:%S`），确认目标文件近期是否被别人改过；
  编辑前先 `Read` 最新内容，不要凭上一轮的记忆去 Edit。
- 用户自己跑着 `pnpm dev`：前端 Vite **dev** 在 5173（有 HMR），后端在 8787（`tsx watch`）。
  沙箱内再起后端会 `EADDRINUSE`。判断后端是否已加载最新代码：看 `GET /api/health` 的 `startedAt`。
- `vite preview` 端口被占会自动顺延（5175 → 5176），排查端口问题时注意。

## 服务端健壮性约束
- **常驻本地服务不能因为一次模型报错就退出**：`index.ts` 已加 `unhandledRejection` / `uncaughtException` 兜底。
  实测 StepFun 的 `429 concurrency reached` 曾以未处理 rejection 逃逸，直接把进程打崩。
- 模型限流的中文文案在 `agent/errors.ts` 的 `describeRunError`，并发超限会带上 current/limit 数字。

