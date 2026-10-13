/**
 * 服务端入口。
 *
 * 配置来源（优先级从高到低）：
 *   1. 命令行参数
 *   2. 环境变量
 *   3. 默认值
 *
 * 安全约束：默认只监听 127.0.0.1；要开放局域网必须显式传 --host 0.0.0.0，
 * 并且应当自行补充认证机制（当前版本未实现）。
 */

import { createApp } from "./api/server.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（src 的上一级再上一级）。 */
const repoRoot = resolve(here, "..", "..", "..");

interface CliOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  workspaceRoot?: string;
  shellEnabled?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case "--host":
        options.host = next;
        i += 1;
        break;
      case "--port":
        options.port = next ? Number(next) : undefined;
        i += 1;
        break;
      case "--data-dir":
        options.dataDir = next;
        i += 1;
        break;
      case "--workspace":
        options.workspaceRoot = next;
        i += 1;
        break;
      case "--shell":
        options.shellEnabled = true;
        break;
      default:
        break;
    }
  }
  return options;
}

const cli = parseArgs(process.argv.slice(2));

const app = await createApp({
  host: cli.host ?? process.env.DEEPAGENT_HOST ?? "127.0.0.1",
  port: cli.port ?? (process.env.DEEPAGENT_PORT ? Number(process.env.DEEPAGENT_PORT) : 8788),
  dataDir: cli.dataDir ?? process.env.DEEPAGENT_DATA_DIR ?? resolve(repoRoot, ".data"),
  workspaceRoot:
    cli.workspaceRoot ?? process.env.DEEPAGENT_WORKSPACE ?? resolve(repoRoot, "workspace"),
  shellEnabled: cli.shellEnabled ?? process.env.DEEPAGENT_SHELL !== "0",
  approvalRequired: process.env.DEEPAGENT_APPROVAL !== "0",
  defaultEffort: "medium",
});

const { url, port, host } = await app.listen();

// 启动横幅是给用户看的正常输出，不走 console.*（lint 只允许 warn/error）。
const banner = [
  `[deepagent-server] 已启动：${url}`,
  `[deepagent-server] 监听地址：${host}:${port}（默认仅本机）`,
  `[deepagent-server] Agent 工作区：${app.workspaceRoot}`,
  "[deepagent-server] AG-UI 端点：POST /agent（SSE）",
];
process.stdout.write(`${banner.join("\n")}\n`);
if (process.env.DEEPAGENT_SHELL === "1" || cli.shellEnabled) {
  console.warn("[deepagent-server] 警告：Shell 执行已启用，命令将在工作区内运行并经过人工审批。");
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stdout.write(`\n[deepagent-server] 收到 ${signal}，正在关闭…\n`);
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

/**
 * 进程级异常兜底。
 *
 * 这是一个常驻的本地服务：模型侧限流（429）、网络中断、下游 socket 断开
 * 都属于「预期内的运行失败」，必须转成对用户的错误提示，而不是把整个
 * 服务进程打崩——崩掉之后所有正在进行的会话都会一起丢失。
 *
 * 实测教训：StepFun 返回 `429 concurrency reached, current: 6, limit: 5` 时，
 * LangGraph 内部抛出的异常曾以未处理 rejection 的形式逃逸，直接终止进程。
 */
process.on("unhandledRejection", (reason: unknown) => {
  console.error("[deepagent-server] 未处理的 Promise rejection（已忽略，服务继续运行）:", reason);
});

process.on("uncaughtException", (error: unknown) => {
  // 已收到退出信号时不再兜底，避免影响正常关闭流程。
  console.error("[deepagent-server] 未捕获异常（已忽略，服务继续运行）:", error);
});
