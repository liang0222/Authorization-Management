import type { NextConfig } from "next";

/**
 * 全站安全响应头（阶段 1）。
 *
 * - `poweredByHeader: false`：不再回 `X-Powered-By: Next.js`，少给指纹信息。
 * - `X-Frame-Options: DENY` 与 CSP 的 `frame-ancestors 'none'` 同时给：
 *   老浏览器只认前者，现代浏览器以 CSP 为准，两条都要有。
 * - CSP 先发 `Content-Security-Policy-Report-Only`（只报告不拦截）。原因：Next 会在
 *   页面里插内联 bootstrap 脚本，直接上强制头会把整站打挂且很难回滚。
 *   **转正式头的步骤**：①在浏览器控制台/上报端点观察两周，确认没有新的违例；
 *   ②把下面的 `Content-Security-Policy-Report-Only` 键名改成 `Content-Security-Policy`；
 *   ③同时把 `script-src` 里的 `'unsafe-inline'` 换成 nonce（需要 middleware 下发 nonce）
 *   ——不换 nonce 就转强制头，等于给内联脚本开白名单，收益有限；
 *   ④先在 3101 沙箱实例验证一周，再动 3100。
 *
 * 注意与反向代理的叠加：`docs/DEPLOY-v15.md` 的 nginx 片段里有
 * `add_header X-Frame-Options SAMEORIGIN always;`，与本文件的 `DENY` 会同时出现在响应里
 * （浏览器行为取决于解释顺序，容易两边打架）。上生产时应删掉 nginx 那条，只留应用层。
 */
const cspReportOnly = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  // 开发模式 React Refresh 需要 eval；生产构建不需要，别把 eval 带进正式策略。
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
]
  .join("; ")
  .concat(";");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
];

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
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
