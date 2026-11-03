import { describe, expect, it } from "vitest";
import { buildLlmsFull, buildLlmsIndex, endpointsFromSpec, loadOpenApiDocument } from "@/lib/developers/llms-generator";
import { ERROR_STATUS } from "@/lib/http/api";
import { PUBLIC_RATE_LIMITS } from "@/lib/domain/public-rate-limits";
import { WEBHOOK_EVENT_TYPES } from "@/lib/services/webhook-events";
import { DOCS_SECTIONS } from "@/lib/developers/docs-nav";

/**
 * `llms.txt` / `llms-full.txt` 的契约测试（P1-5）。
 *
 * 这一组断言的全部意义是：**生成结果必须跟着真源走**。
 * 如果哪天有人把生成器改回手写、或者新增端点忘了同步，这里必须红。
 */

const spec = loadOpenApiDocument();

describe("llms.txt 由真实契约与代码常量生成", () => {
  it("端点清单与 OpenAPI paths 完全一致（不多不少）", () => {
    const index = buildLlmsIndex(spec);
    const facts = endpointsFromSpec(spec);
    expect(facts.length).toBeGreaterThan(0);

    for (const fact of facts) {
      expect(index, `索引缺少端点 ${fact.method} ${fact.path}`).toContain(`${fact.method} ${fact.path}`);
    }

    // 反向：索引里出现的端点路径必须都在契约里，防止手写残留。
    const documented = [...index.matchAll(/^- (GET|POST|PUT|PATCH|DELETE) (\/\S+)/gm)].map(
      (match) => `${match[1]} ${match[2]}`,
    );
    const expected = facts.map((fact) => `${fact.method} ${fact.path}`);
    expect(documented.sort()).toEqual(expected.sort());
  });

  it("新增端点会自动出现在索引里（模拟加一条 path）", () => {
    const patched = {
      ...spec,
      paths: {
        ...spec.paths,
        "/activations/{activation_id}": {
          get: { summary: "查询单个激活的当前状态", tags: ["设备激活"] },
        },
      },
    };
    const index = buildLlmsIndex(patched);
    expect(index).toContain("GET /activations/{activation_id}");
    expect(index).toContain("查询单个激活的当前状态");
  });

  it("限流数值来自 PUBLIC_RATE_LIMITS，不是手抄", () => {
    const full = buildLlmsFull(spec);
    for (const [route, rule] of Object.entries(PUBLIC_RATE_LIMITS)) {
      const label = route === "default" ? "其他端点" : `/${route}`;
      expect(full, `缺少限流行 ${label}`).toContain(`${label}  ${rule.limit} 次 / ${rule.windowSeconds} 秒`);
    }
  });

  it("Webhook 事件来自 WEBHOOK_EVENT_TYPES，数量对得上", () => {
    const full = buildLlmsFull(spec);
    expect(full).toContain(`事件（共 ${WEBHOOK_EVENT_TYPES.length} 个）：`);
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(full).toContain(`- ${event}`);
    }
  });

  it("公开错误码覆盖 ERROR_STATUS 里的对外码，且不泄露控制台专用码", () => {
    const full = buildLlmsFull(spec);
    // 只取「## 8. 错误码」这一节来比对：直接全文 toContain("CONFLICT") 会被
    // IDEMPOTENCY_CONFLICT 这类包含关系的编码骗过去，那是个假断言。
    const section = full.split("## 8. 错误码")[1].split("## 9.")[0];
    const listed = new Set(
      section
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .flatMap((line) => line.replace(/^- \d+：/, "").split(" / ")),
    );

    const adminOnly = ["MFA_REQUIRED", "CSRF_FAILED", "CONFLICT"];
    for (const code of Object.keys(ERROR_STATUS)) {
      if (adminOnly.includes(code)) {
        expect(listed.has(code), `${code} 是控制台登录流程用的，不该出现在公开文档`).toBe(false);
        continue;
      }
      expect(listed.has(code), `缺少错误码 ${code}`).toBe(true);
    }
  });

  it("推荐阅读顺序来自 DOCS_SECTIONS，序号连续", () => {
    const index = buildLlmsIndex(spec);
    const total = DOCS_SECTIONS.reduce((sum, section) => sum + section.items.length, 0);
    expect(index).toContain(`1. ${DOCS_SECTIONS[0].items[0].href}`);
    expect(index).toContain(`${total}. `);
    expect(index).not.toContain(`${total + 1}. `);
  });

  it("两个文件都不含密钥样式的内容", () => {
    const forbidden = [
      /BEGIN [A-Z ]*PRIVATE KEY/,
      /\bsk_[A-Za-z0-9]{8,}/,
      /\bwhsec_[A-Za-z0-9]{8,}/,
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
      /license[-_]?key["'\s:=]+[A-Z0-9]{4}-[A-Z0-9]{4}/i,
    ];
    for (const text of [buildLlmsIndex(spec), buildLlmsFull(spec)]) {
      for (const pattern of forbidden) {
        expect(text, `疑似密钥泄漏：${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("索引里列出全部机器可读文件，且路径可访问", () => {
    const index = buildLlmsIndex(spec);
    for (const path of [
      "/developers/llms.txt",
      "/developers/llms-full.txt",
      "/developers/openapi.yaml",
      "/developers/openapi.json",
    ]) {
      expect(index).toContain(path);
    }
  });
});
  it("错误码清单覆盖 ERROR_STATUS 的全部键（含控制台专用码，页面会注明）", () => {
    const full = buildLlmsFull(spec);
    const section = full.split("## 8. 错误码")[1].split("## 9.")[0];
    const listed = new Set(
      section
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .flatMap((line) => line.replace(/^- \d+：/, "").split(" / ")),
    );
    // 公开文档刻意只列对外码；这里断言的是「一个都没多、一个都没少地来自 ERROR_STATUS」。
    for (const code of listed) {
      expect(Object.keys(ERROR_STATUS), `${code} 不在 ERROR_STATUS 里`).toContain(code);
    }
    expect(listed.size).toBeGreaterThan(0);
  });

