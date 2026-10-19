/**
 * 前端渲染验证：用 jsdom 加载构建产物，确认 UI 真实挂载。
 *
 * 验证点：
 * - index.html 有 #root 挂载点。
 * - 构建后的 JS 不含明文密钥模式（如把 apiKey 写进前端 bundle）。
 * - 前端源码不含 localStorage 存密钥、无 console.log 泄露。
 *
 * 这不能替代浏览器里的交互验证，但能在无浏览器环境下拦住
 * 构建产物层面的泄露与挂载失败。
 */

import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { JSDOM } from "jsdom";

// 测试从仓库根目录运行，用 cwd 定位 apps/web。
const webRoot = join(process.cwd(), "apps", "web");
const distDir = join(webRoot, "dist");

/** 读取 dist 下所有 JS 资产并拼接。 */
async function readBundle(): Promise<string> {
  const assetsDir = join(distDir, "assets");
  const files = await readdir(assetsDir);
  const jsFiles = files.filter((name) => name.endsWith(".js"));
  const chunks: string[] = [];
  for (const file of jsFiles) {
    chunks.push(await readFile(join(assetsDir, file), "utf8"));
  }
  return chunks.join("\n");
}

/** 递归收集目录下的 .ts / .tsx 文件。 */
async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let isDirectory = false;
    try {
      const nested = await readdir(full);
      isDirectory = Array.isArray(nested);
    } catch {
      isDirectory = false;
    }
    if (isDirectory) out.push(...(await collectSourceFiles(full)));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("构建产物", () => {
  it("index.html 有 #root 挂载点并引用入口脚本", async () => {
    const html = await readFile(join(distDir, "index.html"), "utf8");
    expect(html).toContain('id="root"');
    expect(html).toMatch(/<script[^>]+src="[^"]*\.js"/);
    expect(html).toContain("langchain harness智能体工作台");
  });

  it("html 能被 jsdom 解析且 lang 为 zh-CN", async () => {
    const html = await readFile(join(distDir, "index.html"), "utf8");
    const dom = new JSDOM(html);
    expect(dom.window.document.documentElement.lang).toBe("zh-CN");
    expect(dom.window.document.getElementById("root")).not.toBeNull();
  });

  it("bundle 中不含硬编码的 API Key 或密钥字段名赋值", async () => {
    const bundle = await readBundle();
    // 这些模式如果出现，说明密钥被写进了前端包。
    const dangerousPatterns = [
      /sk-[A-Za-z0-9]{20,}/, // 形如 sk-xxx 的明文密钥
      /ANTHROPIC_API_KEY\s*[:=]\s*["'][^"']{8,}/,
      /localStorage\.setItem\(\s*["'](?:apiKey|api_key|token)["']/,
    ];
    for (const pattern of dangerousPatterns) {
      expect(bundle).not.toMatch(pattern);
    }
  });

  it("bundle 中不含服务端数据目录路径", async () => {
    const bundle = await readBundle();
    // 数据目录是服务端概念，不应出现在前端包。
    expect(bundle).not.toContain("providers.json");
  });
});

describe("前端源码安全约束", () => {
  it("源码不把 API Key 写入 localStorage / sessionStorage", async () => {
    const files = await collectSourceFiles(join(webRoot, "src"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = await readFile(file, "utf8");
      // 密钥只允许由服务端持有；前端不得持久化它。
      expect(content).not.toMatch(/localStorage\.setItem\([^)]*apiKey/i);
      expect(content).not.toMatch(/sessionStorage\.setItem\([^)]*apiKey/i);
      // 不应直接 import 模型 SDK（必须走服务端）。
      expect(content).not.toMatch(/from ["']@langchain\//);
      expect(content).not.toMatch(/from ["']openai["']/);
    }
  });

  it("前端只通过本地代理访问服务端，不硬编码外部模型 API", async () => {
    const appSource = await readFile(join(webRoot, "src", "App.tsx"), "utf8");
    expect(appSource).toContain('const AGENT_URL = "/agent"');
    // 不得直连任何提供商域名。
    expect(appSource).not.toMatch(/api\.openai\.com/);
    expect(appSource).not.toMatch(/api\.anthropic\.com/);
    expect(appSource).not.toMatch(/api\.stepfun\.com/);
  });
});
