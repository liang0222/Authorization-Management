import { describe, expect, it } from "vitest";
import { lintOpenApi } from "../../scripts/openapi-lint.mjs";

/**
 * OpenAPI 文档质量守门（规格 27.18 / 27.20）。
 *
 * 与 `openapi.test.ts` 互补：那边核对「路由 ↔ path 双向一致」，
 * 这里核对文档自身是否可用（schema 结构、servers、凭证泄漏、YAML/JSON 同步）。
 * 二者共用同一个 lint 实现，CI 里跑的是 `npm run lint:openapi`。
 */

describe("OpenAPI lint", () => {
  it("公开契约没有结构性问题", () => {
    const problems = lintOpenApi() as string[];
    expect(problems, `OpenAPI lint 问题：\n${problems.join("\n")}`).toEqual([]);
  });
});
