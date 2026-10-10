/**
 * 运行错误的用户可读化。
 *
 * 底层模型/LangGraph 的原始错误常带英文堆栈和排错文档链接，
 * 直接透到界面上既不可读，也暴露内部实现细节。
 * 这里统一转成中文说明，只保留第一行关键信息。
 */

/** 把任意运行错误转成用户可读的中文说明。 */
export function describeRunError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : error === undefined || error === null
          ? ""
          : String(error);
  // 只保留第一行，丢掉堆栈和文档链接。
  const firstLine = raw.split("\n")[0]?.trim() ?? "";

  if (/\b401\b|incorrect api key|invalid.*api.*key|unauthoriz/i.test(raw)) {
    return `模型鉴权失败：${firstLine || "API Key 无效或没有该模型的访问权限。"}`;
  }
  if (/\b429\b|rate limit|concurrency reached/i.test(raw)) {
    // 并发上限是同时跑多个会话时最容易撞到的限制，单独给出可操作的建议。
    if (/concurrency reached/i.test(raw)) {
      const detail = /current:\s*(\d+).*?limit:\s*(\d+)/i.exec(raw);
      const counts = detail ? `（当前 ${detail[1]} 个并发请求，上限 ${detail[2]}）` : "";
      return `模型服务并发超限${counts}：请稍后重试，或减少同时运行的会话数量。`;
    }
    return "请求被模型服务限流，请稍后重试。";
  }
  if (/timeout|etimedout|aborted/i.test(raw)) {
    return "模型请求超时，请检查网络或稍后重试。";
  }
  if (/econnrefused|enotfound|fetch failed/i.test(raw)) {
    return "无法连接到模型服务，请检查 Base URL 是否可访问。";
  }
  if (/model.*not.*found|does not exist|unknown model/i.test(raw)) {
    return "模型不存在，请确认模型 ID 是否正确。";
  }
  if (/recursion|graph recursion/i.test(raw)) {
    return "任务步骤过多被中止，请把任务拆小后重试。";
  }
  return firstLine || "运行失败，请查看服务端日志。";
}
