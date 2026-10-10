import { ChatOpenAI } from "@langchain/openai";
import fs from "fs";
import { resolve } from "path";

const cfg = JSON.parse(fs.readFileSync(resolve("../../.data/providers.json"), "utf8")).providers[0];

const model = new ChatOpenAI({
  model: cfg.defaultModel,
  apiKey: cfg.apiKey,
  configuration: {
    baseURL: cfg.baseUrl,
  },
  streaming: true,
});

console.log("正在发起 StepFun 流式调用: model=" + cfg.defaultModel);
const start = Date.now();
const stream = await model.stream("请用 50 字以内思考并回答：你是什么模型？");

for await (const chunk of stream) {
  const elapsed = Date.now() - start;
  const content = chunk.content;
  const reasoning = chunk.additional_kwargs?.reasoning_content ?? chunk.reasoning_content;
  console.log(`[+${elapsed}ms] content: ${JSON.stringify(content)} | reasoning: ${JSON.stringify(reasoning)}`);
}

console.log(`[完成] 总耗时: ${Date.now() - start}ms`);
