#!/usr/bin/env node
/**
 * 把 Scalar 的 standalone 浏览器构建复制到 `public/vendor/`。
 *
 * 为什么不直接把 671KB 的构建产物签进 git：
 * 它是 `@scalar/api-reference` 的派生产物，版本跟着 package-lock 走。
 * 签进仓库意味着升级依赖时要手动同步一个压缩过的单行文件，
 * 而且 review 时看不出任何差异。改为构建前现拷。
 *
 * 为什么不用 `@scalar/api-reference-react`：那个包装会把整个 Vue 运行时
 * 打进 Next 的客户端 bundle（node_modules 里 58MB），而文档页只需要一个
 * 自包含的浏览器脚本，挂在 `public/` 下按需加载，首屏 HTML 不用为它买单。
 *
 * 必须用 IIFE 版（`standalone.js`）而不是 ESM 版（`standalone.esm.js`）：
 * ESM 版把 231 个组件拆成 `./chunks/*.js` 相对路径动态导入，单独复制一个文件
 * 到 `public/vendor/` 后那些 chunk 全部 404，页面渲染不出来。
 * IIFE 版是自包含的（`grep -c "./chunks/"` 为 0），4.7MB / gzip 后 1.4MB，
 * 只在访问该页时按需加载，不进 Next 的首屏 bundle。
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "@scalar", "api-reference", "dist", "browser", "standalone.js");
const target = join(root, "public", "vendor", "scalar-standalone.js");

if (!existsSync(source)) {
  // 依赖没装（例如只跑单测）时不该让构建挂掉，但要让缺失可见。
  console.warn(`[api-reference] 跳过：找不到 ${source}（先跑 npm ci）`);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
const size = statSync(target).size;
console.log(`[api-reference] 已复制 Scalar standalone → public/vendor/scalar-standalone.js（${size} B）`);
