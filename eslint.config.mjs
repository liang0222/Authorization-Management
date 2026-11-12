import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import reactHooks from "eslint-plugin-react-hooks";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 第三方压缩产物：public/vendor/scalar-standalone.js 是 Scalar 的独立构建，
    // 不是本仓库源码；对其跑 lint 只会得到压缩代码的噪声（约 8.8k 条）。
    "public/vendor/**",
  ]),
  {
    // 阶段 7：React Compiler 两条存量规则先降为 warn，逐文件登记在
    // ESLINT_DEBT.md，按批次迁移；error 仍然拦截新增问题。
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
    },
  },
]);

export default eslintConfig;
