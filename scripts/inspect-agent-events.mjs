import http from "node:http";

const payload = JSON.stringify({
  threadId: "test-thread-" + Date.now(),
  runId: "test-run-" + Date.now(),
  messages: [{ role: "user", content: "你好啊" }],
});

const req = http.request(
  "http://127.0.0.1:8787/agent",
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
  },
  (res) => {
    console.log(`[STATUS] ${res.statusCode}`);
    let buffer = "";
    res.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          console.log(`[EVENT] ${new Date().toISOString()} ${line}`);
        }
      }
    });
    res.on("end", () => {
      console.log("[END]");
      process.exit(0);
    });
  }
);

req.on("error", (err) => {
  console.error("请求失败:", err);
  process.exit(1);
});

req.write(payload);
req.end();
