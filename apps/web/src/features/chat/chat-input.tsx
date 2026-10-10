/**
 * 聊天输入区。
 *
 * 严格对齐 AI SDK Elements 官网规范 (https://elements.ai-sdk.dev/components/prompt-input)：
 * 1. 采用官方 PromptInput / PromptInputBody / PromptInputFooter / PromptInputTools / PromptInputSubmit 架构。
 * 2. 初始绝无白色边框：采用深邃无高亮白边的暗色系边框（border-zinc-800/80 bg-zinc-950/70）。
 * 3. 发送按钮采用官网示例：PromptInputSubmit（流式生成时自动变为停止方块，就绪时为 CornerDownLeft 回车发送图标）。
 * 4. 思考等级与推理强度升级为标准下拉选择（Dropdown / Select）样式，严格遵守模型能力约束（如 step-3.5-flash-2603 仅限 low / high）。
 */

import { useState, useRef, useEffect } from "react";
import {
  ChevronDownIcon,
  CheckIcon,
  SettingsIcon,
  BrainIcon,
  FolderIcon,
  FolderPlusIcon,
  MessageSquareIcon,
} from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputTextarea,
  PromptInputTools,
  PromptInputSubmit,
  type PromptInputMessage,
} from "../../components/ai-elements/prompt-input.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "@deepagent/shared";
import { cn } from "../../lib/utils.js";
import { extractFolderName } from "./use-sessions.js";

interface ChatInputProps {
  onSend: (content: string) => void;
  onStop: () => void;
  isRunning: boolean;
  effort: ReasoningEffort;
  onEffortChange: (effort: ReasoningEffort) => void;
  supportedEfforts: readonly ReasoningEffort[];
  reasoningUnsupported: boolean;
  fallbackApplied: boolean;
  modelStatus: string;
  modelStatusKind: "ok" | "warn" | "error";
  disabled?: boolean;
  /** 可供下拉切换的模型列表 */
  availableModels?: string[];
  /** 当前选中的模型 ID */
  currentModel?: string | null;
  /** 切换模型回调 */
  onSelectModel?: (model: string) => void;
  /** 打开模型设置模态框 */
  onOpenSettings?: () => void;
  /** 当前工作区根目录（若为空或 null 则为直接聊天模式） */
  workspaceRoot?: string | null;
  /** 已添加的工作区列表 */
  customWorkspaces?: string[];
  /** 选择工作区或切换至直接聊天模式（传 null） */
  onSelectWorkspace?: (path: string | null) => void;
  /** 打开系统文件夹选择器弹窗 */
  onOpenFolderPicker?: () => void;
}

export function ChatInput({
  onSend,
  onStop,
  isRunning,
  effort,
  onEffortChange,
  supportedEfforts,
  reasoningUnsupported,
  modelStatus,
  disabled = false,
  availableModels = [],
  currentModel,
  onSelectModel,
  onOpenSettings,
  workspaceRoot,
  customWorkspaces = [],
  onSelectWorkspace,
  onOpenFolderPicker,
}: ChatInputProps) {
  const [text, setText] = useState("");

  // 工作区下拉选择状态
  const [isWorkspaceDropdownOpen, setIsWorkspaceDropdownOpen] = useState(false);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);

  // 模型下拉菜单状态
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // 思考等级下拉菜单状态
  const [isEffortDropdownOpen, setIsEffortDropdownOpen] = useState(false);
  const effortDropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部自动关闭下拉框
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (workspaceDropdownRef.current && !workspaceDropdownRef.current.contains(target)) {
        setIsWorkspaceDropdownOpen(false);
      }
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(target)) {
        setIsModelDropdownOpen(false);
      }
      if (effortDropdownRef.current && !effortDropdownRef.current.contains(target)) {
        setIsEffortDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const hasText = text.trim().length > 0;

  const handleSubmit = (message: PromptInputMessage) => {
    const content = (message.text || text).trim();
    if (content.length > 0 && !isRunning && !disabled) {
      onSend(content);
      setText("");
    }
  };

  const effortLabel = effort === "high" ? "高" : effort === "medium" ? "中" : "低";

  const isDirectChat = !workspaceRoot || workspaceRoot.trim() === "";
  const currentWorkspaceName = isDirectChat ? "直接聊天模式" : extractFolderName(workspaceRoot);
  const currentWorkspacePath = isDirectChat ? "" : workspaceRoot;

  return (
    <div className="shrink-0 bg-black px-4 py-4">
      <div className="mx-auto w-full max-w-3xl">
        {/* ================= 提示词输入框上方工作区选择器（紧凑单色极简风格，消除AI味） ================= */}
        <div className="relative mb-1.5 flex items-center" ref={workspaceDropdownRef}>
          <button
            type="button"
            data-testid="workspace-mode-selector"
            onClick={() => {
              setIsWorkspaceDropdownOpen((v) => !v);
              setIsModelDropdownOpen(false);
              setIsEffortDropdownOpen(false);
            }}
            className="group inline-flex items-center gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-900/80 hover:bg-zinc-800 hover:border-zinc-700 px-2.5 py-1 text-[12px] text-zinc-300 transition-colors select-none max-w-[320px]"
            title={isDirectChat ? "当前为直接聊天模式（无工作区）" : `当前工作区：${currentWorkspacePath}`}
          >
            {isDirectChat ? (
              <MessageSquareIcon className="size-3.5 text-zinc-400 shrink-0" />
            ) : (
              <FolderIcon className="size-3.5 text-zinc-400 shrink-0" />
            )}
            <span className="font-medium text-zinc-200 truncate">
              {isDirectChat ? "直接聊天模式" : `工作区: ${currentWorkspaceName}`}
            </span>
            <ChevronDownIcon
              className={cn(
                "size-3 text-zinc-500 shrink-0 transition-transform duration-200 ml-0.5",
                isWorkspaceDropdownOpen && "rotate-180 text-zinc-300",
              )}
            />
          </button>

          {/* 紧凑弹出式下拉菜单面板 */}
          {isWorkspaceDropdownOpen && (
            <div className="workspace-dropdown-panel absolute left-0 bottom-full mb-1.5 z-50 w-72 rounded-xl border border-zinc-800 bg-[#0c0c0e] p-1 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
              {/* 选项 1：直接聊天模式 */}
              <button
                type="button"
                onClick={() => {
                  onSelectWorkspace?.(null);
                  setIsWorkspaceDropdownOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors",
                  isDirectChat
                    ? "bg-zinc-800/80 text-white font-medium"
                    : "text-zinc-300 hover:bg-zinc-900 hover:text-white",
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <MessageSquareIcon className="size-3.5 text-zinc-400 shrink-0" />
                  <div className="truncate">直接聊天 (无工作区)</div>
                </div>
                {isDirectChat && <CheckIcon className="size-3.5 text-zinc-200 shrink-0 ml-1.5" />}
              </button>

              {/* 分割线 */}
              <div className="my-1 h-px bg-zinc-800/80" />

              {/* 工作区列表标题 */}
              <div className="px-2 py-0.5 text-[10.5px] font-medium text-zinc-500 uppercase tracking-wider">
                工作区列表
              </div>

              {/* 选项 2..N：各工作区文件夹 */}
              <div className="max-h-[160px] overflow-y-auto space-y-0.5 my-0.5 scrollbar-thin scrollbar-thumb-zinc-800">
                {customWorkspaces && customWorkspaces.length > 0 ? (
                  customWorkspaces.map((wsPath) => {
                    const isSelected =
                      !isDirectChat &&
                      (currentWorkspacePath === wsPath ||
                        currentWorkspacePath.toLowerCase() === wsPath.toLowerCase());
                    const name = extractFolderName(wsPath);
                    return (
                      <button
                        key={wsPath}
                        type="button"
                        onClick={() => {
                          onSelectWorkspace?.(wsPath);
                          setIsWorkspaceDropdownOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12px] transition-colors",
                          isSelected
                            ? "bg-zinc-800/80 text-white font-medium"
                            : "text-zinc-300 hover:bg-zinc-900 hover:text-white",
                        )}
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <FolderIcon className="size-3.5 text-zinc-400 shrink-0" />
                          <div className="min-w-0 truncate">
                            <span className="text-[12px] font-medium text-zinc-200">{name}</span>
                            <span className="ml-1 text-[10px] font-mono text-zinc-500 truncate" title={wsPath}>
                              ({wsPath})
                            </span>
                          </div>
                        </div>
                        {isSelected && <CheckIcon className="size-3.5 text-zinc-200 shrink-0 ml-1.5" />}
                      </button>
                    );
                  })
                ) : (
                  <div className="px-2 py-1 text-[11px] text-zinc-500 italic">暂无工作区</div>
                )}
              </div>

              {/* 分割线 */}
              <div className="my-1 h-px bg-zinc-800/80" />

              {/* 选项：打开文件夹新建工作区 */}
              <button
                type="button"
                onClick={() => {
                  setIsWorkspaceDropdownOpen(false);
                  onOpenFolderPicker?.();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12px] text-zinc-300 hover:bg-zinc-900 hover:text-white transition-colors"
              >
                <FolderPlusIcon className="size-3.5 text-zinc-400 shrink-0" />
                <span className="truncate">打开文件夹新建工作区...</span>
              </button>
            </div>
          )}
        </div>

        <PromptInputProvider>
          {/* 纯暗黑极简边框：无任何刺眼白色外框，深邃内敛 */}
          <PromptInput
            onSubmit={handleSubmit}
            className="rounded-2xl border border-zinc-800/80 bg-zinc-950/70 shadow-none focus-within:border-zinc-600 focus-within:ring-0 transition-colors overflow-visible outline-none"
          >
            <PromptInputBody>
              <PromptInputTextarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="输入任务描述...（Enter 发送，Shift+Enter 换行）"
                className="min-h-[50px] max-h-[220px] px-3.5 py-2.5 text-[13.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none border-0 shadow-none focus-visible:ring-0"
              />
            </PromptInputBody>

            {/* 底部工具条与提交按钮 */}
            <PromptInputFooter className="flex items-center justify-between px-3 pb-2.5 pt-1.5 border-t border-zinc-800/40 overflow-visible">
              <PromptInputTools className="flex items-center gap-2.5 text-[12px]">
                {/* 1. 模型选择下拉菜单 */}
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    type="button"
                    onClick={() => {
                      setIsModelDropdownOpen((v) => !v);
                      setIsEffortDropdownOpen(false);
                    }}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800/80 text-zinc-300 hover:text-white transition-colors"
                    title="点击下拉切换当前模型"
                  >
                    <span className="size-1.5 rounded-full bg-emerald-400 shrink-0" />
                    <span className="font-mono truncate max-w-[170px] text-[11.5px]">
                      {currentModel || modelStatus}
                    </span>
                    <ChevronDownIcon className={cn("size-3 text-zinc-500 shrink-0 ml-0.5 transition-transform", isModelDropdownOpen && "rotate-180")} />
                  </button>

                  {/* 弹出式模型下拉列表 */}
                  {isModelDropdownOpen && (
                    <div className="absolute bottom-full mb-2 left-0 z-50 w-64 rounded-xl border border-zinc-800 bg-[#0c0c0e] p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                      <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wider flex items-center justify-between">
                        <span>选择模型</span>
                        {availableModels.length > 0 && <span>({availableModels.length})</span>}
                      </div>

                      <div className="max-h-48 overflow-y-auto space-y-0.5 my-1">
                        {availableModels.length === 0 ? (
                          <div className="px-2 py-2 text-[11.5px] text-zinc-500 text-center">
                            暂无可用模型，请在设置中配置
                          </div>
                        ) : (
                          availableModels.map((m) => {
                            const isSelected = currentModel === m;
                            return (
                              <button
                                key={m}
                                type="button"
                                onClick={() => {
                                  onSelectModel?.(m);
                                  setIsModelDropdownOpen(false);
                                }}
                                className={`flex w-full items-center justify-between px-2 py-1.5 rounded-md text-[12px] font-mono text-left transition-colors ${
                                  isSelected
                                    ? "bg-zinc-800 text-white font-medium"
                                    : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                                }`}
                              >
                                <span className="truncate">{m}</span>
                                {isSelected && <CheckIcon className="size-3 text-emerald-400 shrink-0" />}
                              </button>
                            );
                          })
                        )}
                      </div>

                      {onOpenSettings && (
                        <div className="pt-1 border-t border-zinc-800/80">
                          <button
                            type="button"
                            onClick={() => {
                              setIsModelDropdownOpen(false);
                              onOpenSettings();
                            }}
                            className="flex w-full items-center gap-1.5 px-2 py-1 text-[11.5px] text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900 rounded transition-colors"
                          >
                            <SettingsIcon className="size-3 text-zinc-500" />
                            <span>管理模型与提供商...</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 2. 思考等级下拉选择样式 */}
                <div className="relative" ref={effortDropdownRef}>
                  <button
                    type="button"
                    disabled={reasoningUnsupported}
                    onClick={() => {
                      setIsEffortDropdownOpen((v) => !v);
                      setIsModelDropdownOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-1.5 px-2 py-1 rounded-md bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800/80 transition-colors",
                      reasoningUnsupported ? "opacity-40 cursor-not-allowed text-zinc-600" : "text-zinc-300 hover:text-white"
                    )}
                    title={reasoningUnsupported ? "当前模型不支持调节思考等级" : "点击切换思考等级"}
                  >
                    <BrainIcon className="size-3 text-zinc-400 shrink-0" />
                    <span className="text-[11.5px] font-medium">
                      思考: {reasoningUnsupported ? "无" : effortLabel}
                    </span>
                    <ChevronDownIcon className={cn("size-3 text-zinc-500 shrink-0 ml-0.5 transition-transform", isEffortDropdownOpen && "rotate-180")} />
                  </button>

                  {/* 弹出式思考等级下拉列表 */}
                  {isEffortDropdownOpen && (
                    <div className="absolute bottom-full mb-2 left-0 z-50 w-44 rounded-xl border border-zinc-800 bg-[#0c0c0e] p-1.5 shadow-2xl animate-in fade-in zoom-in-95 duration-100">
                      <div className="px-2 py-1 text-[11px] font-medium text-zinc-500 uppercase tracking-wider">
                        思考等级 / 推理强度
                      </div>

                      <div className="space-y-0.5 my-1">
                        {REASONING_EFFORTS.map((option) => {
                          const supported = supportedEfforts.includes(option);
                          const isSelected = effort === option;
                          const title = option === "high" ? "高 (high)" : option === "medium" ? "中 (medium)" : "低 (low)";
                          const desc = option === "high" ? "深度多步思考" : option === "medium" ? "均衡推理与速度" : "快速响应思考";

                          if (!supported) {
                            return (
                              <div
                                key={option}
                                className="flex items-center justify-between px-2 py-1.5 rounded-md text-[11.5px] text-zinc-600 cursor-not-allowed select-none"
                                title="当前模型不支持此档位（如 step-3.5-flash-2603 仅限低与高）"
                              >
                                <span>{title}</span>
                                <span className="text-[10px] text-zinc-600">不支持</span>
                              </div>
                            );
                          }

                          return (
                            <button
                              key={option}
                              type="button"
                              onClick={() => {
                                onEffortChange(option);
                                setIsEffortDropdownOpen(false);
                              }}
                              className={`flex w-full items-center justify-between px-2 py-1.5 rounded-md text-[12px] text-left transition-colors ${
                                isSelected
                                  ? "bg-zinc-800 text-white font-medium"
                                  : "text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
                              }`}
                            >
                              <div className="flex flex-col">
                                <span>{title}</span>
                                <span className="text-[10.5px] text-zinc-500 font-normal">{desc}</span>
                              </div>
                              {isSelected && <CheckIcon className="size-3 text-emerald-400 shrink-0 ml-1" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </PromptInputTools>

              {/* 右侧：官网标准的 PromptInputSubmit 提交/停止按钮 */}
              <PromptInputSubmit
                disabled={!hasText && !isRunning}
                status={isRunning ? "streaming" : undefined}
                onStop={onStop}
                className="size-8 rounded-lg bg-zinc-100 text-black hover:bg-white disabled:opacity-30 disabled:bg-zinc-800 disabled:text-zinc-500 transition-colors shadow-none"
              />
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </div>
    </div>
  );
}
