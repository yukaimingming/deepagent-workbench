import { useCallback, useEffect, useState } from "react";
import type { GitDiffResponse, GitFileItem, GitStatusResponse } from "./review-types.js";

export function useGitReview(workspaceRoot: string | null) {
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedCommit, setSelectedCommit] = useState<string>("uncommitted");
  const [selectedFile, setSelectedFile] = useState<GitFileItem | null>(null);
  const [currentDiff, setCurrentDiff] = useState<GitDiffResponse | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");

  /** 拉取 Git 状态 */
  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (workspaceRoot) {
        params.set("root", workspaceRoot);
      }
      const res = await fetch(`/api/git/status?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`获取 Git 状态失败 (${res.status})`);
      }
      const data = (await res.json()) as GitStatusResponse;
      setStatus(data);

      setSelectedFile((prev) => {
        const allChanges = [...(data.changes || []), ...(data.staged || [])];
        if (allChanges.length === 0) return null;
        if (prev && allChanges.some((f) => f.path === prev.path)) {
          return prev;
        }
        const firstCodeFile = allChanges.find((f) => !f.isImage);
        return firstCodeFile ?? allChanges[0] ?? null;
      });
    } catch (err) {
      // 容错降级
      setStatus({
        isGitRepo: false,
        branch: "main",
        repoRoot: workspaceRoot || "",
        changes: [],
        staged: [],
        commits: [],
      });
    } finally {
      setLoading(false);
    }
  }, [workspaceRoot]);

  /** 拉取指定文件的 Diff */
  const fetchDiff = useCallback(
    async (file: GitFileItem, commit = selectedCommit) => {
      try {
        setDiffLoading(true);
        const params = new URLSearchParams();
        params.set("path", file.path);
        if (workspaceRoot) {
          params.set("root", workspaceRoot);
        }
        params.set("staged", String(file.staged));
        if (commit && commit !== "uncommitted") {
          params.set("commit", commit);
        }

        const res = await fetch(`/api/git/diff?${params.toString()}`);
        if (!res.ok) {
          throw new Error(`获取文件 Diff 失败 (${res.status})`);
        }
        const data = (await res.json()) as GitDiffResponse;
        setCurrentDiff(data);
      } catch (err) {
        setCurrentDiff({
          path: file.path,
          isImage: file.isImage,
          error: String(err),
        });
      } finally {
        setDiffLoading(false);
      }
    },
    [workspaceRoot, selectedCommit],
  );

  useEffect(() => {
    if (selectedFile) {
      void fetchDiff(selectedFile, selectedCommit);
    } else {
      setCurrentDiff(null);
    }
  }, [selectedFile, selectedCommit, fetchDiff]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  /** 提交变更 */
  const handleCommit = useCallback(
    async (message: string, filePaths?: string[]) => {
      if (!message.trim()) {
        throw new Error("提交说明不能为空");
      }
      try {
        setCommitLoading(true);
        const res = await fetch("/api/git/commit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: message.trim(),
            root: workspaceRoot,
            paths: filePaths,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data.error || "提交失败");
        }
        setCommitMessage("");
        await fetchStatus();
        return data;
      } finally {
        setCommitLoading(false);
      }
    },
    [workspaceRoot, fetchStatus],
  );

  return {
    status,
    loading,
    selectedCommit,
    setSelectedCommit,
    selectedFile,
    setSelectedFile,
    currentDiff,
    diffLoading,
    commitLoading,
    commitMessage,
    setCommitMessage,
    refresh: fetchStatus,
    commit: handleCommit,
  };
}
