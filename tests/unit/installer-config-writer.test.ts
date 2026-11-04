import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENV_KEY_RE,
  formatValue,
  generateSecret,
  readEnvFile,
  renderEnvFile,
  summarizeConfig,
  writeRuntimeConfig,
} from "@/lib/installer/config-writer";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "installer-config-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("密钥生成", () => {
  it("默认 32 字节 → 43 字符 base64url", () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(43);
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("每次都不一样", () => {
    const set = new Set(Array.from({ length: 20 }, () => generateSecret()));
    expect(set.size).toBe(20);
  });

  it("长度可调", () => {
    expect(generateSecret(16)).toHaveLength(22);
  });
});

describe("env 键名校验", () => {
  it("只接受大写字母、数字与下划线", () => {
    expect(ENV_KEY_RE.test("LICENSE_DB_URL")).toBe(true);
    expect(ENV_KEY_RE.test("A1_B2")).toBe(true);
    for (const bad of ["lower", "1LEADING", "WITH-DASH", "WITH SPACE", "WITH.DOT", ""]) {
      expect(ENV_KEY_RE.test(bad), bad).toBe(false);
    }
  });
});

describe("值格式化", () => {
  it("普通值不加引号", () => {
    expect(formatValue("postgresql://u:p@h:5432/db")).toBe("postgresql://u:p@h:5432/db");
    expect(formatValue("production")).toBe("production");
  });

  it("含空格或特殊字符时加双引号并转义", () => {
    expect(formatValue("a b")).toBe('"a b"');
    expect(formatValue('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("空值输出空串（不是 undefined）", () => {
    expect(formatValue("")).toBe("");
  });
});

describe("渲染 env 文件", () => {
  it("按字母序输出 KEY=VALUE，并带生成说明头", () => {
    const text = renderEnvFile({ B: "2", A: "1" });
    expect(text).toContain("# 由 Universal Installer 生成");
    expect(text.indexOf("A=1")).toBeLessThan(text.indexOf("B=2"));
  });

  it("末尾有换行（POSIX 文本文件）", () => {
    expect(renderEnvFile({ A: "1" }).endsWith("\n")).toBe(true);
  });
});

describe("写运行配置", () => {
  it("首次写入生成 0600 文件", () => {
    const path = join(dir, "production.env");
    const result = writeRuntimeConfig({ path, values: { A: "1", B: "2" } });
    expect(result.path).toBe(path);
    expect(result.keys.sort()).toEqual(["A", "B"]);
    expect(result.bytes).toBeGreaterThan(0);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("A=1");
    expect(text).toContain("B=2");
  });

  it("覆盖写之前先备份成 .bak-<时间戳>", () => {
    const path = join(dir, "production.env");
    writeFileSync(path, "OLD=1\n");
    const result = writeRuntimeConfig({ path, values: { NEW: "2" } });
    expect(result.backupPath).toBeTruthy();
    expect(readFileSync(result.backupPath!, "utf8")).toBe("OLD=1\n");
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
  });

  it("备份可以关掉", () => {
    const path = join(dir, "no-backup.env");
    writeFileSync(path, "OLD=1\n");
    const result = writeRuntimeConfig({ path, values: { A: "1" }, backup: false });
    expect(result.backupPath).toBeUndefined();
    expect(readdirSync(dir).filter((n) => n.includes(".bak-"))).toEqual([]);
  });

  it("非法键名直接拒绝，不写坏文件", () => {
    const path = join(dir, "bad.env");
    expect(() => writeRuntimeConfig({ path, values: { "bad-key": "1" } })).toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("父目录不存在时自动创建", () => {
    const path = join(dir, "nested", "deep", "app.env");
    writeRuntimeConfig({ path, values: { A: "1" } });
    expect(existsSync(path)).toBe(true);
  });
});

describe("读取已有 env", () => {
  it("解析 KEY=VALUE，跳过注释与空行", () => {
    const path = join(dir, "read.env");
    writeFileSync(path, "# 注释\n\nA=1\nB=\"two words\"\nC=\n");
    const parsed = readEnvFile(path);
    expect(parsed.A).toBe("1");
    expect(parsed.B).toBe("two words");
    expect(parsed.C).toBe("");
  });

  it("文件不存在返回空对象", () => {
    expect(readEnvFile(join(dir, "nope.env"))).toEqual({});
  });
});

describe("配置摘要（不回显值）", () => {
  it("摘要只提路径、字节数与键数，绝不带值", () => {
    const path = join(dir, "summary.env");
    const result = writeRuntimeConfig({ path, values: { A: "super-secret-value" } });
    const summary = summarizeConfig(result);
    expect(summary).not.toContain("super-secret-value");
    expect(summary).toContain(path);
    expect(summary).toContain("1 个键");
  });

  it("有备份时摘要里会提到备份路径", () => {
    const path = join(dir, "summary2.env");
    writeFileSync(path, "OLD=1\n");
    const result = writeRuntimeConfig({ path, values: { A: "1" } });
    expect(summarizeConfig(result)).toContain(".bak-");
  });
});
