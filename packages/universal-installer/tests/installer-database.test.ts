import { describe, expect, it } from "vitest";
import {
  describeTarget,
  DatabaseUrlError,
  ERROR_MAP,
  mapError,
  parseDatabaseUrl,
} from "../lib/installer/database";

describe("连接串解析", () => {
  it("标准 postgresql URL", () => {
    const parsed = parseDatabaseUrl("postgresql://licensing:pw@127.0.0.1:55432/licensing?schema=public");
    expect(parsed.scheme).toBe("postgresql");
    expect(parsed.host).toBe("127.0.0.1");
    expect(parsed.port).toBe(55432);
    expect(parsed.database).toBe("licensing");
    expect(parsed.username).toBe("licensing");
    expect(parsed.password).toBe("pw");
    expect(parsed.searchPath).toBe("public");
  });

  it("postgres:// 短写法也接受", () => {
    expect(parseDatabaseUrl("postgres://u:p@db:5432/app").scheme).toBe("postgres");
  });

  it("缺端口时默认 5432", () => {
    expect(parseDatabaseUrl("postgresql://u:p@db/app").port).toBe(5432);
  });

  it("密码里的特殊字符会被解码", () => {
    const parsed = parseDatabaseUrl("postgresql://u:p%40ss%3Aword@db:5432/app");
    expect(parsed.password).toBe("p@ss:word");
  });

  it("非 postgres 协议直接拒绝", () => {
    for (const url of ["mysql://u:p@db/app", "mongodb://u:p@db/app", "http://db/app"]) {
      expect(() => parseDatabaseUrl(url), url).toThrow(DatabaseUrlError);
    }
  });

  it("缺库名拒绝", () => {
    expect(() => parseDatabaseUrl("postgresql://u:p@db:5432")).toThrow(DatabaseUrlError);
    expect(() => parseDatabaseUrl("postgresql://u:p@db:5432/")).toThrow(DatabaseUrlError);
  });

  it("缺用户名拒绝", () => {
    expect(() => parseDatabaseUrl("postgresql://db:5432/app")).toThrow(DatabaseUrlError);
  });

  it("端口越界拒绝", () => {
    expect(() => parseDatabaseUrl("postgresql://u:p@db:0/app")).toThrow(DatabaseUrlError);
    expect(() => parseDatabaseUrl("postgresql://u:p@db:70000/app")).toThrow(DatabaseUrlError);
  });

  it("空串与乱码拒绝", () => {
    expect(() => parseDatabaseUrl("")).toThrow(DatabaseUrlError);
    expect(() => parseDatabaseUrl("not a url")).toThrow(DatabaseUrlError);
  });
});

describe("目标描述（脱敏）", () => {
  it("不含密码，只留 user@host:port/db", () => {
    const text = describeTarget(parseDatabaseUrl("postgresql://licensing:sup3r@10.0.0.5:5432/app"));
    expect(text).toBe("licensing@10.0.0.5:5432/app");
    expect(text).not.toContain("sup3r");
  });
});

describe("数据库错误映射", () => {
  it("已知 SQLSTATE 都有中文解释", () => {
    for (const code of ["28P01", "3D000", "42501", "53300", "57P03"]) {
      expect(ERROR_MAP[code], code).toBeTruthy();
      expect(ERROR_MAP[code].message.length).toBeGreaterThan(0);
    }
  });

  it("28P01 → 用户名或密码错误", () => {
    const mapped = mapError({ code: "28P01" });
    expect(mapped.message).toContain("密码");
    expect(mapped.hint).toBeTruthy();
  });

  it("3D000 → 数据库不存在", () => {
    expect(mapError({ code: "3D000" }).message).toContain("不存在");
  });

  it("ECONNREFUSED → 端口没有服务监听", () => {
    const mapped = mapError({ code: "ECONNREFUSED" });
    expect(mapped.message).toContain("监听");
    expect(mapped.hint).toBeTruthy();
  });

  it("ENOTFOUND → 域名解析失败", () => {
    expect(mapError({ code: "ENOTFOUND" }).message).toContain("解析");
  });

  it("未知错误保留原文而不是吞掉", () => {
    const mapped = mapError(new Error("某种没见过的错误"));
    expect(mapped.message).toContain("某种没见过的错误");
  });

  it("字符串错误也能处理", () => {
    expect(mapError("boom").message).toContain("boom");
  });
});
