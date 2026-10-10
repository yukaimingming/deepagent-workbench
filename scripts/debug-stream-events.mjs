// 使用 Node 20+ 原生 fetch 读取 SSE 流

const url = "http://127.0.0.1:8787/agent";
const body = {
  threadId: `debug_thread_${Date.now()}`,
  runId: `run_${Date.now()}`,
  messages: [
    {
      id: `msg_${Date.now()}`,
      role: "user",
      content: "介绍一下agentscope java构架",
    },
  ],
  forwardedProps: {
    effort: "medium",
  },
};

console.log("正在请求 /agent 端点...");
const startTime = Date.now();

const res = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log("响应状态码：", res.status);
if (!res.body) {
  console.error("响应没有 body");
  process.exit(1);
}

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n\n");
  buffer = lines.pop() || "";
  for (const block of lines) {
    const elapsed = Date.now() - startTime;
    const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
    if (dataLine) {
      try {
        const event = JSON.parse(dataLine.slice(6));
        console.log(`[+${elapsed}ms] [${event.type}]`, JSON.stringify(event).slice(0, 160));
      } catch {
        console.log(`[+${elapsed}ms] 原始文本:`, dataLine.slice(0, 100));
      }
    }
  }
}

console.log("事件流结束，总耗时：", Date.now() - startTime, "ms");
