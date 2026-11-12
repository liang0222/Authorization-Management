import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // cpu-features 是 ssh2 的可选原生插件，静态 require 了 .node 文件；Turbopack 无法把
    // 原生 addon 放入 ESM chunk，干净安装后 build 必失败。构建期把它替换为空实现，
    // 运行时 ssh2 会像「该可选依赖不存在」一样回退到纯 JS 实现（见 shims 文件注释）。
    resolveAlias: {
      "cpu-features": "./src/lib/shims/cpu-features-noop.cjs",
    },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
