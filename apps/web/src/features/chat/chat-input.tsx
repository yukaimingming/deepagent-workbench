/**
 * 聊天输入区。
 *
 * 严格按照用户需求：
 * 1. 思考等级/推理强度嵌入在输入框内部的底部进行排版。
 * 2. 输入框底部支持模型下拉选择（支持随时下拉切换当前模型）。
 * 3. 纯黑极简底色（与主聊天区完全统一）。
 * 4. 支持多行输入、回车发送、Shift+Enter 换行、运行中停止。
 */

import { useState, useRef, useEffect } from "react";
import {
  SquareIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CheckIcon,
  SettingsIcon,
  SparklesIcon,
} from "lucide-react";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputTextarea,
} from "../../components/ai-elements/prompt-input.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "@deepagent/shared";

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
}: ChatInputProps) {
  // 模型下拉菜单展开状态
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // 点击外部自动关闭下拉框
  useEffect(() => {
    if (!isModelDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isModelDropdownOpen]);

  return (
    <div className="shrink-0 bg-black px-4 py-4">
      <div className="mx-auto w-full max-w-3xl">
        <PromptInputProvider>
          <PromptInput
            onSubmit={({ text }) => {
              const trimmed = text.trim();
              if (trimmed.length > 0 && !isRunning) {
                onSend(trimmed);
              }
            }}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/80 shadow-lg focus-within:border-zinc-700 transition-colors overflow-visible"
          >
            <PromptInputBody>
              <PromptInputTextarea
                placeholder="输入任务描述...（Enter 发送，Shift+Enter 换行）"
                className="min-h-[50px] max-h-[220px] px-3.5 py-2.5 text-[13.5px] text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
              />
            </PromptInputBody>

            {/* 思考等级与模型选择内嵌在输入框底部 Footer 排版 */}
            <PromptInputFooter className="flex items-center justify-between px-3 pb-2.5 pt-1.5 border-t border-zinc-800/40 overflow-visible">
              {/* 左侧：可下拉选择模型 + 思考强度切换 */}
              <div className="flex items-center gap-3 text-[12px]">
                {/* 模型下拉菜单容器 */}
                <div className="relative" ref={dropdownRef}>
                  <button
                    type="button"
                    onClick={() => setIsModelDropdownOpen((v) => !v)}
                    className="flex items-center gap-1.5 px-2 py-1 rounded bg-zinc-900/80 hover:bg-zinc-800 border border-zinc-800/80 text-zinc-300 hover:text-white transition-colors"
                    title="点击下拉切换当前模型"
                  >
                    <span className="size-1.5 rounded-full bg-emerald-400 shrink-0" />
                    <span className="font-mono truncate max-w-[170px] text-[11.5px]">
                      {currentModel || modelStatus}
                    </span>
                    <ChevronDownIcon className="size-3 text-zinc-500 shrink-0 ml-0.5" />
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
                            <span>管理模型与厂商...</span>
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* 思考强度选择器 */}
                <div className="flex items-center gap-1.5 border-l border-zinc-800 pl-3">
                  <span className="text-[11px] text-zinc-500">思考</span>
                  <div className="flex items-center gap-0.5 bg-zinc-900 rounded p-0.5 border border-zinc-800">
                    {REASONING_EFFORTS.map((option) => {
                      const supported = supportedEfforts.includes(option);
                      const selected = effort === option;
                      const label = option === "low" ? "低" : option === "medium" ? "中" : "高";
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() => onEffortChange(option)}
                          disabled={!supported || reasoningUnsupported}
                          className={`px-1.5 py-0.5 text-[11px] font-medium rounded transition-colors ${
                            selected
                              ? "bg-zinc-700 text-white"
                              : "text-zinc-500 hover:text-zinc-300 disabled:opacity-30"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* 右侧：提交 / 停止按钮 */}
              <div className="flex items-center gap-2">
                {isRunning ? (
                  <button
                    type="button"
                    onClick={onStop}
                    className="flex size-7 items-center justify-center rounded-lg bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
                    title="停止生成"
                  >
                    <SquareIcon className="size-3.5 fill-current" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={disabled}
                    className="flex size-7 items-center justify-center rounded-lg bg-zinc-100 text-black hover:bg-white disabled:opacity-30 transition-colors"
                    title="发送消息"
                  >
                    <ArrowUpIcon className="size-3.5 stroke-[2.5]" />
                  </button>
                )}
              </div>
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </div>
    </div>
  );
}
