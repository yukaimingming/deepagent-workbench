import { createAgentBundle } from "./agent/create-agent.js";
import { MemorySaver } from "@langchain/langgraph";
import fs from "fs";
import { resolve } from "path";

const cfg = JSON.parse(fs.readFileSync(resolve("../../.data/providers.json"), "utf8")).providers[0];

const checkpointer = new MemorySaver();
const bundle = createAgentBundle(
  {
    provider: cfg,
    workspaceRoot: resolve("d:/temp/langchain/workspace"),
    effort: "medium",
    shellEnabled: true,
    approvalRequired: false,
  },
  checkpointer
);

console.log("正在调用 agent.streamEvents(..., { version: 'v3' })...");
const start = Date.now();
const run = await bundle.agent.streamEvents(
  { messages: [{ role: "user", content: "请用 50 字以内思考并回答：你是什么模型？" }] },
  { version: "v3", configurable: { thread_id: "test-v3-" + Date.now() } }
);

console.log("v3 stream 获取成功，遍历 run.messages...");

for await (const message of run.messages) {
  console.log(`[message] role=${message.role}`);
  let reasoningCount = 0;
  for await (const rChunk of message.reasoning) {
    reasoningCount++;
    const t = Date.now() - start;
    console.log(`[+${t}ms reasoning #${reasoningCount}] ${JSON.stringify(rChunk)}`);
  }
  let textCount = 0;
  for await (const tChunk of message.text) {
    textCount++;
    const t = Date.now() - start;
    console.log(`[+${t}ms text #${textCount}] ${JSON.stringify(tChunk)}`);
  }
}

console.log("总耗时: " + (Date.now() - start) + "ms");
