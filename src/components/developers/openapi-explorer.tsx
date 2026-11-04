"use client";

import { useEffect, useRef } from "react";

/**
 * 在线 OpenAPI 浏览器（Scalar 官方 standalone 构建）。
 *
 * 用 IIFE 版（`dist/browser/standalone.js`）而不是 ESM 版：ESM 版把 231 个
 * 组件拆成 `./chunks/*.js` 相对路径动态导入，复制单个文件到 `public/` 后
 * 那些 chunk 全部 404，页面只剩空白。IIFE 版是自包含单文件（grep `./chunks/`
 * 为 0），加载完直接把 `window.Scalar` 挂上。
 *
 * 交互式请求默认关闭（`hideTestRequestButton`）：规格 27.2 只允许在 Sandbox
 * 用测试授权试调，生产域名下不给一键发真实请求的按钮。
 */

type ScalarApi = {
  createApiReference: (
    el: Element,
    config: Record<string, unknown>,
  ) => { destroy?: () => void };
};

declare global {
  interface Window {
    Scalar?: ScalarApi;
  }
}

const SCRIPT_ID = "scalar-standalone";

function loadScalar(): Promise<ScalarApi> {
  if (window.Scalar) return Promise.resolve(window.Scalar);

  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");

    const onLoad = () => {
      if (window.Scalar) resolve(window.Scalar);
      else reject(new Error("Scalar 脚本已加载但没有挂载 window.Scalar"));
    };

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", () => reject(new Error("Scalar 脚本加载失败")), { once: true });

    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = "/vendor/scalar-standalone.js";
      script.async = true;
      document.body.appendChild(script);
    }
  });
}

export function OpenApiExplorer({ specUrl }: { specUrl: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let instance: { destroy?: () => void } | null = null;

    loadScalar()
      .then((scalar) => {
        // 卸载与加载有竞态：await 回来时组件可能已经不在页面上了，
        // 这时候再挂会往已移除的节点上渲染，并且永远无法销毁。
        if (disposed || !host.current) return;
        instance = scalar.createApiReference(host.current, {
          _integration: "html",
          url: specUrl,
          // 内置 zh-CN 词条（standalone 包里已含 zh-CN/zh-TW），不设就整页英文。
          localization: { locale: "zh-CN" },
          theme: "default",
          layout: "modern",
          darkMode: false,
          hideTestRequestButton: true,
          hideClientButton: true,
          showDeveloperTools: "never",
          telemetry: false,
          withDefaultFonts: false,
          persistAuth: false,
        });
      })
      .catch((error: unknown) => {
        console.error("[openapi] 渲染失败", error);
        if (host.current && !disposed) {
          host.current.innerHTML =
            '<p style="padding:1rem;font-size:.875rem">在线文档组件加载失败，请改用 ' +
            `<a href="${specUrl}" style="text-decoration:underline">${specUrl}</a> 下载原始规范。</p>`;
        }
      });

    return () => {
      disposed = true;
      instance?.destroy?.();
    };
  }, [specUrl]);

  return (
    <div className="min-h-[80svh]">
      <div ref={host} />
    </div>
  );
}
