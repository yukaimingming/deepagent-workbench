// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** 服务端（Node + TS）lint 配置。 */
export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "**/*.config.ts", "**/*.config.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        projectService: false,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 服务端日志用 console.warn/error 是刻意设计（见 AGENTS.md 第 13 节）。
      "no-console": ["warn", { allow: ["warn", "error"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    // 测试文件允许使用 any 断言来构造假流对象。
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "no-console": "off",
    },
  },
);
