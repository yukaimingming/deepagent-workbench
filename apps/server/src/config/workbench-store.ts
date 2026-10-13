import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const sessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messageCount: z.number().int().nonnegative(),
  workspaceRoot: z.string(),
  folderName: z.string(),
});

export const workbenchIndexSchema = z.object({
  version: z.literal(1),
  customWorkspaces: z.array(z.string()),
  sessions: z.array(sessionSchema),
  activeSessionId: z.string(),
  currentWorkspace: z.string().nullable(),
});

export type WorkbenchIndex = z.infer<typeof workbenchIndexSchema>;

/** 本地工作台数据存储：会话索引和每个会话状态都保存在服务数据目录。 */
export class WorkbenchStore {
  private readonly root: string;
  private readonly sessionsRoot: string;
  private readonly indexPath: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "workbench");
    this.sessionsRoot = join(this.root, "sessions");
    this.indexPath = join(this.root, "index.md");
  }

  async loadIndex(): Promise<WorkbenchIndex | null> {
    try {
      let contents: string;
      try {
        contents = await readFile(this.indexPath, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        contents = await readFile(join(this.root, "index.json"), "utf8");
      }
      const value: unknown = contents.trimStart().startsWith("{") ? JSON.parse(contents) as unknown : parseMarkdownJson(contents);
      return workbenchIndexSchema.parse(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof z.ZodError || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async saveIndex(index: WorkbenchIndex): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await this.atomicWrite(this.indexPath, toMarkdown("工作台索引", index));
  }

  async loadSessionState(id: string): Promise<unknown | null> {
    const path = this.sessionPath(id);
    try {
      let contents: string;
      try {
        contents = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        contents = await readFile(join(this.sessionsRoot, `${id}.json`), "utf8");
      }
      return contents.trimStart().startsWith("{") ? JSON.parse(contents) as unknown : parseMarkdownJson(contents);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async saveSessionState(id: string, state: unknown): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true });
    await this.atomicWrite(this.sessionPath(id), toMarkdown("会话状态", state));
  }

  async deleteSessionState(id: string): Promise<void> {
    await rm(this.sessionPath(id), { force: true });
  }

  private sessionPath(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
      throw new Error("会话标识格式无效");
    }
    return join(this.sessionsRoot, `${id}.md`);
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  }
}

function toMarkdown(title: string, value: unknown): string {
  return `# ${title}\n\n> 此文件由 DeepAgent 本地工作台自动维护。\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
}

function parseMarkdownJson(markdown: string): unknown {
  const match = markdown.match(/```json\s*\n([\s\S]*?)\n```/i);
  if (!match?.[1]) throw new SyntaxError("Markdown 文件中缺少 JSON 数据块");
  return JSON.parse(match[1]) as unknown;
}
