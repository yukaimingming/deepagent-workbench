"use client";

/**
 * shadcn/ui 官方 Shimmer 文字微光动画组件实现。
 * 参考：https://ui.shadcn.com/docs/utils/shimmer
 *
 * 核心特性：
 * 1. 纯 CSS background-clip: text + @keyframes tw-shimmer 驱动，零外部动画库运行时开销；
 * 2. 默认采用带 color 的 .shimmer 与 .shimmer-color-blue-500/60，呈现细腻的微光掠过动效；
 * 3. 默认渲染为 span，支持通过 as 属性多态渲染为 p、div、span 等标签。
 */

import { cn } from "@/lib/utils";
import type { ComponentProps, ElementType, ReactNode } from "react";

export type ShimmerProps<T extends ElementType = "span"> = {
  as?: T;
  children: ReactNode;
  className?: string;
  duration?: number;
  spread?: number;
} & Omit<ComponentProps<T>, "as" | "children">;

export const Shimmer = <T extends ElementType = "span">({
  as,
  children,
  className,
  duration,
  spread,
  style,
  ...props
}: ShimmerProps<T>) => {
  const Component = (as || "span") as ElementType;

  const inlineStyles: Record<string, string | number> = {
    ...style,
  };
  if (typeof duration === "number") {
    inlineStyles["--shimmer-duration"] = `${duration}s`;
  }
  if (typeof spread === "number") {
    inlineStyles["--shimmer-spread"] = `${spread * 12}px`;
  }

  return (
    <Component
      className={cn("shimmer shimmer-color-blue-500/60 inline-block select-none", className)}
      style={inlineStyles}
      {...(props as any)}
    >
      {children}
    </Component>
  );
};

