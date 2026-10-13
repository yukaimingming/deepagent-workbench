# DeepAgent 工作台

本地运行的 Deep Agent 智能体应用：Deep Agents SDK 提供 Agent 运行时，AG-UI 协议负责前后端通信，React + AI SDK Elements 构成聊天与活动时间线界面。

模型 API 需要联网调用（除非你配置了本地兼容接口），但 Agent 本身、文件工作区、配置存储都在本机，不依赖任何托管 Agent 云服务。

---

## 1. 快速开始

### 前置条件

- Node.js 20.11 或更高（开发与验证使用 Node 24.14.0）
- pnpm 10（`packageManager` 已固定为 10.33.2）

### 安装依赖

```bash
pnpm install
```

### 启动

需要两个终端，分别启动服务端与前端：

```bash
pnpm dev:server
```

```bash
pnpm dev:web
```

- 前端：http://127.0.0.1:5173
- 服务端：http://127.0.0.1:8787

前端通过 Vite 代理把 `/api/*` 和 `/agent` 转发到服务端，所以浏览器里只需要访问前端一个地址。

### 配置模型

启动后打开前端，点右上角「模型设置」：

1. 选提供商类型（StepFun / OpenAI / Anthropic / OpenAI 兼容）。
2. 填 API Base URL 与 API Key。StepFun 默认预填 `https://api.stepfun.com/step_plan/v1`，可改。
3. 点「获取模型列表」自动拉取；拉不到就手动输入模型 ID 添加。
4. 选中默认模型，保存。
5. 可以先点「测试连接」确认密钥和模型可用。

密钥只写进服务端的 `.data/providers.json`（已在 `.gitignore`，权限设为仅属主可读写），前端拿到的只有掩码摘要。

---

## 2. 目录结构

```text
/
├─ AGENTS.md                      开发规范
├─ package.json                   根脚本（dev/build/typecheck/lint/test/verify）
├─ pnpm-workspace.yaml
├─ apps/
│  ├─ web/                        React + Vite + AI SDK Elements
│  │  └─ src/
│  │     ├─ components/           弹窗、可折叠容器等通用组件
│  │     ├─ components/ai-elements/   AI SDK Elements 官方组件
│  │     ├─ features/chat/        聊天、活动时间线、AG-UI 客户端
│  │     ├─ features/settings/    模型设置弹窗与状态管理
│  │     └─ lib/                  类名合并工具
│  └─ server/                     本地 Agent 服务
│     └─ src/
│        ├─ api/                  HTTP 路由与 AG-UI SSE 端点
│        ├─ agent/                DeepAgent 创建、AG-UI 适配层、错误翻译
│        ├─ config/               配置存储（密钥保护）
│        └─ providers/            模型适配、模型列表获取
├─ packages/
│  └─ shared/                     前后端共用类型、Zod schema、推理强度规则
└─ tests/                         跨端验证（构建产物与源码安全约束）
```

---

## 3. 核心实现说明

### 3.1 Agent 运行时

用 `createDeepAgent` 创建 Agent，启用内置能力：

- `write_todos` 任务规划（前端 Todo 卡片实时反映状态）
- 文件系统工具（读 / 写 / 编辑 / 列目录 / glob / grep）
- 两个子 Agent：`researcher`（只读检索）与 `file-worker`（文件整理）
- 人工审批：`write_file`、`edit_file`、`delete_file`、`execute` 需批准后执行

文件系统具备**跨文件夹访问**能力：`FilesystemBackend` / `LocalShellBackend` 以 `virtualMode: false` 运行，绝对路径按原样使用，因此 Agent 可以读写工作区根目录以外的任意目录（用户明确要求的能力）。工作区根目录（默认仓库下的 `workspace/`，可用 `--workspace` 或 `DEEPAGENT_WORKSPACE` 改）只作为相对路径与 Shell 命令的默认基准目录，**不再是访问边界**。

因为不再有路径围栏，写 / 改 / 删 / 执行命令全部走人工审批；如需恢复「只能访问工作区」的旧行为，把 `createAgentBundle` 的 `crossFolderAccess` 设为 `false` 即可（此时回退为虚拟根模式，越界路径会被拒绝）。

Shell 执行默认关闭。要用必须显式开启：

```bash
pnpm --filter @deepagent/server start -- --shell
```

开启后仍受 60 秒超时、100 KB 输出上限约束，且每条命令都要人工审批。注意 Shell 本身不受路径限制。

### 3.2 AG-UI 适配层

Deep Agents 的内部事件不直接透传为 AG-UI 事件。适配层（`apps/server/src/agent/agui-adapter.ts`）显式定义映射：

| DeepAgent 流 | AG-UI 输出 |
| --- | --- |
| 运行生命周期 | `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` |
| 模型文本增量 | `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` |
| Todo 状态变化 | `CUSTOM` `deepagent:activity`（kind=todo） |
| 工具调用 | `CUSTOM` `deepagent:activity`（kind=tool / file） |
| 子 Agent | `CUSTOM` `deepagent:activity`（kind=subagent） |
| 人工审批中断 | `CUSTOM` `deepagent:activity`（kind=approval）+ `RUN_FINISHED` outcome=interrupt |
| 运行状态 | `CUSTOM` `deepagent:run-snapshot` |

原始隐藏思维链一律不外发。`run.messages` 的 `.reasoning` 只用来生成「正在整理思路」这样一句公开进度摘要。

事件流以标准事件为骨架，终止事件之后不再发任何事件（AG-UI 规范要求），所以最终状态快照都排在 `RUN_FINISHED` 之前。

### 3.3 推理强度

前端提供 `low` / `medium` / `high` 三档，默认 `medium`。档位经 `resolveEffortForModel` 按模型能力校验后，由服务端适配器转成各提供商真实字段：

| 提供商 | 下发字段 |
| --- | --- |
| OpenAI | `reasoning.effort` |
| Anthropic | `outputConfig.effort` |
| StepFun / OpenAI 兼容 | `reasoning.effort`（仅在值合法时下发） |

`step-3.5-flash-2603` 只支持 `low` 和 `high`。选中该模型时前端会禁用 `medium`；万一传了 `medium`，服务端回落到 `low` 并在 UI 上提示「已按模型能力自动调整」。提供商若不支持推理强度，设置里勾选后 UI 会明确说明该设置被忽略。

### 3.4 前端状态管理

AG-UI 事件经纯函数归约器（`apps/web/src/features/chat/client-reducer.ts`）转成客户端状态：

- 同一 `activity.id` 只更新同一张卡片，字段级合并，保留最早 `startedAt`，时间线不抖不重复。
- 消息文本与运行活动分开存储，工具事件不会污染最终答复。
- 每次运行有唯一 `runId`；中断后进入 `waiting_approval`。
- 重放事件不会插出幽灵消息（未知 `messageId` 的增量被忽略）。

界面复用 AI SDK Elements 官方组件：

| 组件 | 用途 |
| --- | --- |
| `MessageResponse` | Markdown 渲染 |
| `Conversation` | 智能滚动（贴底） |
| `CodeBlock` | 语法高亮 + 复制 |
| `Reasoning` / `ReasoningTrigger` / `ReasoningContent` | 思考面板 |
| `Checkpoint` / `CheckpointIcon` / `CheckpointTrigger` | 会话检查点回退 |
| `FileTree` / `FileTreeFolder` / `FileTreeFile` | 工作区文件树 |
| `Shimmer` | 「正在思考」微光文字 |

Todo、工具、子 Agent、审批卡片按项目数据模型自己封装——Elements 的 `Task` / `Tool` 那套是 AI SDK `UIMessage` part 格式专用的，硬套会丢信息。输入框用原生 `textarea`（原因见「浏览器端验证」一节）。

#### 思考与正文的流式时序

服务端刻意给思考内容和正文用不同的 AG-UI messageId，前端把它们归并到同一条气泡里。顺序是：

1. `REASONING_START` → 思考面板展开，显示 `Shimmer` 的「正在思考…」，摘要按增量流式追加。
2. `REASONING_END` → 面板自动收起，触发器改成「已思考 N 秒」。
3. 之后才发 `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` → 正文开始流式输出。

所以用户先看到思考过程，思考结束后才看到正式答复。

外发的内容是 `sanitizeReasoning` 过滤后的**公开进度摘要**，不是模型原始隐藏思维链：命中敏感模式（密钥、密码、token、系统提示词、提示词注入）的片段整段丢弃，其余按意图关键词映射成「正在规划任务步骤」「正在检索工作区文件」这类固定短语，未命中给中性占位。输出长度恒 ≤ 10 字，原文里的路径、邮箱等具体信息不会出现。

#### 工作区文件树

右侧面板下半部分是文件树。数据来源是 Agent 在本次会话里真实操作过的文件路径（读 / 写 / 改 / 删 / 列目录 / 检索），由活动卡片推导，不是凭空列目录——树里只有与当前任务相关的内容。默认只展开还含有子目录的节点（纯文件目录展开只有一个空箭头）。Agent 操作过的文件旁边有一个蓝点标记。

---

## 4. 服务端接口

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `POST /agent` | AG-UI 运行端点（SSE） |
| `POST /agent/cancel` | 取消指定线程的运行 |
| `GET /api/providers` | 已配置提供商的非敏感信息 |
| `POST /api/providers` | 新增提供商 |
| `PUT /api/providers/:id` | 更新提供商（`apiKey` 留空则保留原值） |
| `DELETE /api/providers/:id` | 删除提供商 |
| `POST /api/providers/:id/models` | 服务端获取模型列表 |
| `POST /api/providers/:id/test` | 验证连接与简单响应 |

所有输入经 Zod 校验。任何响应体都不含明文密钥。

模型列表获取会区分失败原因：`auth`（鉴权失败）、`network`（网络错误或超时）、`http`（其他 HTTP 错误）、`unsupported`（接口不返回 JSON 或 404/405）、`empty`（成功但列表为空）。空列表不会被误判成密钥无效。

---

## 5. 安全设计

- API Key 只存服务端 `.data/providers.json`，文件权限 0600，已在 `.gitignore`。前端只拿掩码摘要，不落 localStorage / sessionStorage。
- 服务端默认只监听 `127.0.0.1`。要开放局域网必须显式传 `--host 0.0.0.0`，且当前版本**没有**认证机制，请不要在不信任的网络里这么用。
- 文件工具默认具备跨文件夹访问能力（见第 3 节）。写文件、改文件、删文件、执行命令默认都要人工审批，这是目前唯一的高风险操作防线；如果要收紧为「只能访问工作区」，把 `crossFolderAccess` 设为 `false`。
- 文件内容、网页内容、工具结果都视为不可信数据，不能覆盖系统规则。
- Markdown 渲染不执行原始 HTML（react-markdown / streamdown 默认行为）。
- 日志只记必要元数据，不透出密钥。模型运行的原始英文错误（含内部文档链接和堆栈）会先转成中文说明再给前端。
- 有 Origin 头的请求会校验来源，拒绝非本地跨站请求。

---

## 6. 已验证能力

以下命令在交付前实际执行并通过：

```bash
pnpm install              # 安装依赖
pnpm typecheck            # TypeScript strict 类型检查（3 个包全过）
pnpm lint                 # ESLint（3 个包全过，0 error 0 warning）
pnpm test                 # 测试（见下）
pnpm build                # 生产构建（server + web）
```

测试结果：**167 个用例全部通过**（另有 46 项浏览器端断言，见「浏览器端验证」）。

| 范围 | 用例数 | 覆盖内容 |
| --- | --- | --- |
| `packages/shared` | 24 | 推理强度三档/两档映射与回落、密钥掩码、配置 schema 校验 |
| `apps/server` | 83 | 模型列表 URL 拼接与错误分类、AG-UI 适配器（事件顺序、卡片幂等、思维链不外发、审批）、推理摘要安全过滤（密钥/密码/注入全丢弃）、错误翻译、HTTP 接口集成、端到端 SSE 协议 |
| `apps/web` | 54 | 客户端状态归约（消息流、卡片幂等、中断、事件映射、完整运行序列）、reasoning 与正文流式时序及归并、检查点回退、工作区路径组装与展开策略 |
| `tests/` | 6 | 构建产物无明文密钥、源码不落 localStorage、前端不直连模型 API |

真实服务验证（本地启动前后端后执行）：

- 健康检查、提供商增删改查、密钥掩码正常。
- 用无效密钥调 StepFun `/models`，返回 `auth` 分类与中文说明。
- `POST /agent` 走通完整 SSE 流：`RUN_STARTED` → 状态快照 → 错误卡片 → `RUN_ERROR`。
- 前端所有组件经 Vite 编译返回 200，`/api` 代理到服务端正常。

### 浏览器端验证

三个 CDP 脚本驱动 headless Chrome 检查真实渲染结果和控制台错误：

```bash
pnpm test:e2e                                    # 基础 UI 与消息链路，23 项
node scripts/e2e-new-ui-check.mjs                # 文件树 + 检查点回退，13 项
node scripts/e2e-reasoning-check.mjs             # 思考/正文流式时序，10 项
```

`e2e-browser-check.mjs` 覆盖：root 挂载（白屏检测）、顶栏按钮、活动时间线、推理强度三档、设置弹窗开合与四种提供商类型、StepFun 默认 URL 预填、输入 onChange、配置后输入框启用、两档模型上 `medium` 被禁用、发送消息后用户消息上屏、SSE 错误渲染成卡片、运行结束后 UI 状态恢复、控制台零错误。

`e2e-reasoning-check.mjs` 用一个仅开发模式挂载的测试钩子（`window.__deepagentTestHooks`，生产构建不含）直接往状态机派发事件序列，从而在不调用真实模型的情况下验证：思考面板先渲染且正文为空 → 思考流式中 → 结束后面板收起、显示耗时 → 正文开始渲染 → 两者在同一条气泡 → state 里思考内容保留 → 展开后面板内容恢复 → 思考内容是 ≤10 字的固定公开短语。

这些脚本是补上的。第一轮验证只看了「HTTP 200 + 模块能编译」，结果漏了运行时才爆炸的问题，前后踩了两次：

1. AI Elements 的 `PromptInputTextarea` 强依赖 `PromptInputProvider` 上下文，单独用会让整个 React 树崩掉、页面全白，而所有模块请求照样返回 200。现在输入框用原生 `textarea`，Enter 发送 / Shift+Enter 换行 / 输入法组合期保护自己实现。
2. `CheckpointTrigger` 内部用 shadcn `Tooltip`，需要在 `main.tsx` 包一层 `TooltipProvider`，否则同样白屏。

现在每次引入 AI Elements 组件前会先查它的上下文依赖（`throw new Error(... must be used within ...)`）和 Provider 要求。

三个脚本都不破坏你的配置：`e2e-browser-check.mjs` 会先备份服务端所有提供商，临时停用它们并创建自己的测试提供商，跑完再把服务端恢复成与备份完全一致（删掉测试创建的、写回原有的，`enabled` 等字段原样还原）。早前这个脚本直接 DELETE 全部提供商，把用户的真实 API Key 配置清掉过——那是破坏性行为，已修正。

#### 真实模型踩到并修掉的问题

用真实 StepFun Key 跑通完整对话的过程中，修了四个只有真机才暴露的问题：

1. **`REASONING_START` 用错了事件层**。AG-UI 客户端把 reasoning 分成 span 层和 message 层，`REASONING_MESSAGE_CONTENT` 归属后者，必须由 `REASONING_MESSAGE_START` 开启。用 `REASONING_START` 会抛 `No active reasoning message found`。已改为 `REASONING_MESSAGE_START` / `REASONING_MESSAGE_END`。
2. **`role` 传错导致 ZodError**。`REASONING_MESSAGE_START` 的 `role` 只接受 `"reasoning"`，传 `"assistant"` 会让客户端 schema 校验失败、中断整条流。
3. **多轮 reasoning 共用一个 messageId**。DeepAgent 多轮工具调用会产生多条模型消息，共用一个 ID 会让第二轮的 CONTENT 找不到 START。改为每条消息独立 ID，START/CONTENT/END 严格配对。
4. **第二轮运行 400**。HttpAgent 的 `defaultApplyEvents` 会把 reasoning 事件也物化成消息，`agent.messages` 里因此混入 `role: "reasoning"` 的条目，而服务端 schema 只认 user/assistant/system/tool/developer。发送前过滤掉非法 role。

另外 StepFun 的 OpenAI 兼容通道有两个坑，在 fetch 层做了双向修补（`createToolCallCompatFetch`）：出站前补全历史 `tool_calls` 缺失的 `id`/`type`/`function.name`/`function.arguments`（否则 StepFun 返回 `400 tool_calls.id and tool_calls.type are required`）；入站后若响应里的 `function.name` 是空串，按 index 从请求的 `tools` 反推补上（否则 Agent 会反复报「工具名无效」）。

`createDeepAgent` 的 `middleware` 参数经实测不会把自定义 `wrapModelCall` 织进模型调用链（加日志验证过零调用），所以修补放在 fetch 层——那是唯一确定能拦到每次请求的位置。

### 已用真实模型验证

用真实 StepFun Key（`step-5-preview` 与 `step-3.5-flash-2603`）跑通的链路：

- 完整对话：`RUN_STARTED` → 思考流式 → `TEXT_MESSAGE_*` → `RUN_FINISHED`，正文正常渲染成 Markdown。
- 事件量从 9087 降到约 130（运行快照按 800ms 节流 + 摘要整句去重）。
- 工具定义确实下发到模型（日志确认 8 个：`ls`/`read_file`/`write_file`/`edit_file`/`delete`/`glob`/`grep`/`task`）。
- Agent 真实调用过 `ls` 并答出工作区内容。

### 尚未验证

- **工具调用卡片与 Todo 卡片未在真实运行中见到**。Agent 在多轮思考后常选择直接回答而不调工具（`step-5-preview` 尤其如此），因此 `run.values` 里的 `tool_calls` 一直为空。卡片生成逻辑（`extractToolCalls` + `emitToolCall`）有单测覆盖，但没有真实工具调用的端到端证据。
- **人工审批的完整往返**：中断产生和决策提交的代码路径有单测，但没有在真实模型触发 `write_file` 时走过一遍。
- **Shell 执行路径**默认关闭，未实测。
- **视觉呈现细节**（配色、间距、滚动行为）没有人工过目，需要你本地打开确认。

---

## 7. 已知限制

- Agent 检查点使用本地 Markdown 文件 (`.data/checkpoints.md`) 保存；工作台索引和每个会话的消息/附件状态以 Markdown 文件保存在 `.data/workbench/`，不依赖浏览器端口。服务重启、前端刷新或更换端口后都可恢复工作台。这里保存的是对话和运行状态，不会自动生成个人偏好/摘要类长期记忆。
- **多会话并发**：每个对话拥有独立的前端运行时（独立状态 + 独立 `HttpAgent`）与服务端运行句柄，因此运行中新建 / 切换对话不会打断后台执行，侧边栏会显示「执行中」，切回去即可看到实时进度。同一会话内不支持重复触发（需先停止）。
- 前端 bundle 约 1.27 MB（gzip 366 KB），主要来自 shiki 的全语言语法高亮。需要的话可以按需加载语言或拆包。
- 开放局域网访问时没有认证机制，见第 5 节。
- 只实现了四个提供商类型；其他厂商需要自己加适配器。
- `apps/web/tests/reasoning-stream.test.ts` 有 4 个用例与当前实现的设计不一致（期望 reasoning 结束即关闭流式标记、期望第二轮 reasoning 另起一条消息），属于历史遗留，尚未对齐。

---

## 8. 环境变量与命令行参数

| 项 | 默认值 | 说明 |
| --- | --- | --- |
| `--host` / `DEEPAGENT_HOST` | `127.0.0.1` | 监听地址 |
| `--port` / `DEEPAGENT_PORT` | `8787` | 监听端口 |
| `--data-dir` / `DEEPAGENT_DATA_DIR` | `<repo>/.data` | 配置目录 |
| `--workspace` / `DEEPAGENT_WORKSPACE` | `<repo>/workspace` | Agent 工作区 |
| `--shell` / `DEEPAGENT_SHELL=1` | 关闭 | 启用 Shell 执行 |
| `DEEPAGENT_APPROVAL=0` | 开启 | 关闭人工审批（不建议） |
