/**
 * 工作区文件树。
 *
 * 数据来源：Agent 在本次会话里真实操作过的文件路径
 * （读 / 写 / 改 / 删 / 列目录 / 检索），由活动卡片推导出来，
 * 不是凭空列目录——这样树里只有与当前任务相关的内容。
 *
 * 用 AI SDK Elements 的 `FileTree` / `FileTreeFolder` / `FileTreeFile`，
 * 它们自带展开状态、选中态与键盘可达性。
 */

import { useMemo, useState } from "react";
import {
  FileTree,
  FileTreeActions,
  FileTreeFile,
  FileTreeFolder,
  FileTreeIcon,
  FileTreeName,
} from "../../components/ai-elements/file-tree.js";
import { FileIcon, FolderIcon, FolderOpenIcon } from "lucide-react";
import type { Activity, FileDetail } from "@deepagent/shared";

/** 树节点。 */
interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  /** 该路径是否被 Agent 直接操作过（文件节点用）。 */
  touched?: boolean;
}

function newNode(name: string, path: string): TreeNode {
  return { name, path, children: new Map() };
}

/** 把扁平路径列表组装成树。 */
function buildTree(paths: string[]): TreeNode {
  const root = newNode("", "");
  for (const rawPath of paths) {
    const normalized = rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (normalized.length === 0) continue;
    const segments = normalized.split("/").filter((segment) => segment.length > 0);
    let cursor = root;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (!segment) continue;
      const isLeaf = i === segments.length - 1;
      const existing = cursor.children.get(segment);
      if (existing) {
        if (isLeaf) existing.touched = true;
        cursor = existing;
      } else {
        const created = newNode(segment, segments.slice(0, i + 1).join("/"));
        if (isLeaf) created.touched = true;
        cursor.children.set(segment, created);
        cursor = created;
      }
    }
  }
  return root;
}

/** 收集默认展开的目录：只展开「还有子目录」的节点，且最多两层。 */
function collectDefaultExpanded(node: TreeNode, depth = 0): Set<string> {
  const expanded = new Set<string>();
  if (depth >= 2) return expanded;
  for (const child of node.children.values()) {
    // 只展开「还含有子目录」的节点：纯文件节点展开后没有意义，
    // 只会在 UI 上多出一个空转箭头。
    const hasSubdirectories = [...child.children.values()].some(
      (grandchild) => grandchild.children.size > 0,
    );
    if (hasSubdirectories) {
      expanded.add(child.path);
      for (const nested of collectDefaultExpanded(child, depth + 1)) expanded.add(nested);
    }
  }
  return expanded;
}

/** 从活动列表里提取被操作过的文件路径。 */
export function extractTouchedPaths(activities: Activity[]): string[] {
  const paths = new Set<string>();
  for (const activity of activities) {
    if (activity.kind !== "file") continue;
    const detail = activity.detail as FileDetail | undefined;
    if (detail?.path) paths.add(detail.path);
  }
  return [...paths];
}

interface WorkspaceTreeProps {
  activities: Activity[];
  onSelectFile?: (path: string) => void;
}

export function WorkspaceTree({ activities, onSelectFile }: WorkspaceTreeProps) {
  const paths = useMemo(() => extractTouchedPaths(activities), [activities]);
  const tree = useMemo(() => buildTree(paths), [paths]);
  const [expanded, setExpanded] = useState<Set<string>>(() => collectDefaultExpanded(tree));
  const [selected, setSelected] = useState<string | null>(null);

  const handleSelect = (path: string): void => {
    setSelected(path);
    onSelectFile?.(path);
  };

  if (paths.length === 0) {
    return (
      <div className="px-3 py-6 text-center">
        <p className="text-[11.5px] text-text-muted">工作区还没有文件活动</p>
        <p className="mt-1 text-[11px] text-text-muted">
          Agent 读取或修改文件后，会出现在这里
        </p>
      </div>
    );
  }

  return (
    <FileTree
      className="border-border-subtle bg-surface-1"
      expanded={expanded}
      onExpandedChange={setExpanded}
      selectedPath={selected ?? undefined}
      onSelect={handleSelect}
    >
      {[...tree.children.values()]
        .sort((a, b) => sortNodes(a, b))
        .map((node) => (
          <TreeBranch key={node.path} node={node} />
        ))}
    </FileTree>
  );
}

/** 目录排在文件前面，同类按名称排。 */
function sortNodes(a: TreeNode, b: TreeNode): number {
  const aIsDir = a.children.size > 0;
  const bIsDir = b.children.size > 0;
  if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
  return a.name.localeCompare(b.name);
}

function TreeBranch({ node }: { node: TreeNode }) {
  const isDir = node.children.size > 0;

  if (!isDir) {
    return (
      <FileTreeFile path={node.path} name={node.name}>
        <FileTreeIcon>
          <FileIcon className="size-4 text-text-muted" />
        </FileTreeIcon>
        <FileTreeName>{node.name}</FileTreeName>
        {node.touched ? (
          <FileTreeActions>
            <span
              className="size-1.5 rounded-full bg-state-running"
              title="Agent 在本轮操作过此文件"
            />
          </FileTreeActions>
        ) : null}
      </FileTreeFile>
    );
  }

  return (
    <FileTreeFolder path={node.path} name={node.name}>
      {[...node.children.values()]
        .sort((a, b) => sortNodes(a, b))
        .map((child) => (
          <TreeBranch key={child.path} node={child} />
        ))}
    </FileTreeFolder>
  );
}

/** 供测试与文档使用：暴露内部工具。 */
export { buildTree, collectDefaultExpanded, FolderIcon, FolderOpenIcon };
