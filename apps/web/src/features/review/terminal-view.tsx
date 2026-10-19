import { useState, useRef, useEffect } from "react";
import { TerminalIcon, Trash2Icon } from "lucide-react";

interface TerminalViewProps {
  workspaceRoot: string | null;
}

interface OutputEntry {
  type: "banner" | "command" | "output" | "error";
  text: string;
}

export function TerminalView({ workspaceRoot }: TerminalViewProps) {
  const currentCwd = workspaceRoot || "d:\\temp\\langchain";
  const [outputLines, setOutputLines] = useState<OutputEntry[]>([
    {
      type: "banner",
      text: "Windows PowerShell\n版权所有 (C) Microsoft Corporation。保留所有权利。\n",
    },
  ]);
  const [inputVal, setInputVal] = useState("");
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [outputLines]);

  const handleRunCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    const cmd = inputVal.trim();
    if (!cmd) {
      setOutputLines((prev) => [
        ...prev,
        { type: "command", text: `PS ${currentCwd}> ` },
      ]);
      return;
    }

    if (cmd.toLowerCase() === "cls" || cmd.toLowerCase() === "clear") {
      setOutputLines([]);
      setInputVal("");
      return;
    }

    setHistory((prev) => [...prev, cmd]);
    setHistoryIdx(-1);

    setOutputLines((prev) => [
      ...prev,
      { type: "command", text: `PS ${currentCwd}> ${cmd}` },
    ]);
    setInputVal("");
    setRunning(true);

    try {
      const res = await fetch("/api/terminal/exec", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, cwd: currentCwd }),
      });
      const data = await res.json();
      if (data.output) {
        setOutputLines((prev) => [
          ...prev,
          { type: "output", text: data.output },
        ]);
      }
      if (data.error) {
        setOutputLines((prev) => [
          ...prev,
          { type: "error", text: data.error },
        ]);
      }
    } catch (err: unknown) {
      setOutputLines((prev) => [
        ...prev,
        { type: "error", text: err instanceof Error ? err.message : String(err) },
      ]);
    } finally {
      setRunning(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length > 0) {
        const nextIdx = historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
        setHistoryIdx(nextIdx);
        setInputVal(history[nextIdx] ?? "");
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (historyIdx >= 0) {
        const nextIdx = historyIdx + 1;
        if (nextIdx >= history.length) {
          setHistoryIdx(-1);
          setInputVal("");
        } else {
          setHistoryIdx(nextIdx);
          setInputVal(history[nextIdx] ?? "");
        }
      }
    }
  };

  return (
    <div
      className="flex flex-1 flex-col h-full bg-black text-zinc-200 font-mono text-xs overflow-hidden"
      onClick={() => inputRef.current?.focus()}
    >
      {/* 终端顶部状态栏 */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3 select-none">
        <div className="flex items-center gap-2">
          <TerminalIcon className="size-4 text-emerald-400" />
          <span className="font-semibold text-zinc-300">Terminal</span>
          <span className="text-[10px] text-zinc-500 truncate max-w-[200px]">
            {currentCwd}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setOutputLines([])}
          title="清空输出"
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>

      {/* 终端输出内容 */}
      <div className="flex-1 overflow-auto p-3 space-y-1 select-text">
        {outputLines.map((line, idx) => {
          if (line.type === "banner") {
            return (
              <div key={idx} className="whitespace-pre-wrap text-zinc-500 mb-2">
                {line.text}
              </div>
            );
          }
          if (line.type === "command") {
            return (
              <div key={idx} className="font-bold text-zinc-200">
                {line.text}
              </div>
            );
          }
          if (line.type === "error") {
            return (
              <div key={idx} className="whitespace-pre-wrap text-rose-400">
                {line.text}
              </div>
            );
          }
          return (
            <div key={idx} className="whitespace-pre-wrap text-zinc-300">
              {line.text}
            </div>
          );
        })}

        {/* 当前活动提示符与输入行 */}
        <form onSubmit={handleRunCommand} className="flex items-center gap-1.5 pt-1">
          <span className="text-emerald-400 shrink-0">PS {currentCwd}&gt;</span>
          <input
            ref={inputRef}
            type="text"
            value={inputVal}
            onChange={(e) => setInputVal(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={running}
            className="flex-1 bg-transparent text-zinc-100 outline-none border-none p-0 focus:ring-0"
            autoFocus
          />
        </form>

        <div ref={terminalEndRef} />
      </div>
    </div>
  );
}
