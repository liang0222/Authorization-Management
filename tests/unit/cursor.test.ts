import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "@/lib/domain/cursor";
import { cursorFields, pageResult, readListQuery } from "@/lib/http/api";

function url(query: string) {
  return new URL(`http://127.0.0.1:3100/api/v1/admin/webhooks?${query}`);
}

describe("列表游标签名（规格 27.5）", () => {
  it("同一个位置与作用域编码稳定，解码回原值", () => {
    const cursor = encodeCursor({ offset: 40, scope: "/api/v1/admin/webhooks" });
    expect(decodeCursor(cursor, "/api/v1/admin/webhooks")).toEqual({
      offset: 40,
      scope: "/api/v1/admin/webhooks",
    });
  });

  it("游标里不含明文字段名，客户端拿不到可篡改条件", () => {
    const cursor = encodeCursor({ offset: 40, scope: "/api/v1/admin/webhooks" });
    expect(cursor.startsWith("c1.")).toBe(true);
    expect(cursor).not.toContain("offset");
    expect(cursor).not.toContain("admin");
  });

  it("改一个字节就失效", () => {
    const cursor = encodeCursor({ offset: 40, scope: "/api/v1/admin/webhooks" });
    const [v, body, sig] = cursor.split(".");
    const flipped = `${v}.${body}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    expect(decodeCursor(flipped, "/api/v1/admin/webhooks")).toBeNull();
  });

  it("换作用域（跨接口复用）失效", () => {
    const cursor = encodeCursor({ offset: 40, scope: "/api/v1/admin/webhooks" });
    expect(decodeCursor(cursor, "/api/v1/admin/license-list")).toBeNull();
  });

  it("垃圾输入不抛异常，只返回 null", () => {
    for (const bad of ["", "x", "c1", "c1..", "c1.abc.def", "c2.abc.def"]) {
      expect(decodeCursor(bad, "/api/v1/admin/webhooks")).toBeNull();
    }
  });

  it("offset 必须是安全非负整数", () => {
    // 手工构造一个 offset 为负的载荷且签名正确，验证值域校验生效
    const cursor = encodeCursor({ offset: -1, scope: "/api/v1/admin/webhooks" });
    expect(decodeCursor(cursor, "/api/v1/admin/webhooks")).toBeNull();
    const huge = encodeCursor({ offset: Number.MAX_SAFE_INTEGER + 2, scope: "/api/v1/admin/webhooks" });
    expect(decodeCursor(huge, "/api/v1/admin/webhooks")).toBeNull();
  });
});

describe("readListQuery 的游标入口", () => {
  it("没有 cursor 时仍走旧的 page/pageSize（老页面不需要改）", () => {
    const query = readListQuery(url("page=3&pageSize=20"));
    expect(query).toMatchObject({ page: 3, pageSize: 20, skip: 40, fromCursor: false });
  });

  it("cursor + limit 驱动分页，page 由位置换算", () => {
    const scope = "/api/v1/admin/webhooks";
    const cursor = encodeCursor({ offset: 60, scope });
    const query = readListQuery(url(`cursor=${encodeURIComponent(cursor)}&limit=20`), 20, scope);
    expect(query.skip).toBe(60);
    expect(query.page).toBe(4);
    expect(query.pageSize).toBe(20);
    expect(query.fromCursor).toBe(true);
  });

  it("limit 上限仍是 100", () => {
    const query = readListQuery(url("limit=500"));
    expect(query.pageSize).toBe(100);
  });

  it("伪造的 cursor 直接报 400，不静默回退第一页", () => {
    expect(() => readListQuery(url("cursor=c1.fake.sig"))).toThrowError(/游标无效/);
  });

  it("作用域默认取请求路径，跨接口复用会被拒", () => {
    const cursor = encodeCursor({ offset: 20, scope: "/api/v1/admin/audit-logs" });
    expect(() => readListQuery(url(`cursor=${encodeURIComponent(cursor)}`))).toThrowError(/游标无效/);
  });
});

describe("游标字段输出", () => {
  it("还有下一页时产出 next_cursor，且位置等于已消费行数", () => {
    const query = readListQuery(url("pageSize=20"));
    const meta = cursorFields(20, 95, query);
    expect(meta.has_more).toBe(true);
    expect(decodeCursor(meta.next_cursor as string, query.scope)).toEqual({
      offset: 20,
      scope: query.scope,
    });
    expect(meta.pagination).toEqual({ next_cursor: meta.next_cursor, has_more: true, limit: 20 });
  });

  it("最后一页没有 next_cursor", () => {
    const query = readListQuery(url("page=5&pageSize=20"));
    const meta = cursorFields(15, 95, query);
    expect(meta.has_more).toBe(false);
    expect(meta.next_cursor).toBeNull();
  });

  it("空列表不产生游标", () => {
    const query = readListQuery(url("pageSize=20"));
    expect(cursorFields(0, 0, query).next_cursor).toBeNull();
  });

  it("pageResult 同时保留旧字段与新游标字段", () => {
    const query = readListQuery(url("page=2&pageSize=20"));
    const result = pageResult([1, 2, 3], 43, query);
    expect(result.page).toBe(2);
    expect(result.pageCount).toBe(3);
    expect(result.has_more).toBe(true);
    expect(result.next_cursor).not.toBeNull();
  });

  it("总数为 0 时 pageCount 至少是 1，不出现 0 页", () => {
    const result = pageResult([], 0, readListQuery(url("")));
    expect(result.pageCount).toBe(1);
    expect(result.pagination.has_more).toBe(false);
  });
});
