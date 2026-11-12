import { describe, expect, it } from "vitest";

import {
  BackupPathError,
  assertSafeBackupPath,
  normalizeRelativePrefix,
} from "@/lib/services/backup/paths";

describe("备份路径安全", () => {
  it("普通相对路径与绝对路径都保留原值", () => {
    expect(assertSafeBackupPath("team/upload")).toBe("team/upload");
    expect(assertSafeBackupPath("/var/lib/ziming/backups")).toBe("/var/lib/ziming/backups");
    expect(assertSafeBackupPath("a.b/c-d_1")).toBe("a.b/c-d_1");
  });

  it("拒绝 .. 与 . 路径段", () => {
    for (const value of ["..", "../etc", "a/../../b", "a/./b", "/../root"]) {
      expect(() => assertSafeBackupPath(value), value).toThrow(BackupPathError);
    }
  });

  it("拒绝百分号编码的穿越与分隔符", () => {
    for (const value of ["%2e%2e", "%2E%2E/etc", "a/%2e%2e/b", "a%2fb", "a%5cb", "%"]) {
      expect(() => assertSafeBackupPath(value), value).toThrow(BackupPathError);
    }
  });

  it("拒绝反斜杠与控制字符", () => {
    for (const value of ["a\\b", "C:\\backups", "a\u0000b", "a\nb"]) {
      expect(() => assertSafeBackupPath(value), value).toThrow(BackupPathError);
    }
  });

  it("归一化前缀时裁掉首尾斜杠，内部层级保留", () => {
    expect(normalizeRelativePrefix(null)).toBe("");
    expect(normalizeRelativePrefix("  ")).toBe("");
    expect(normalizeRelativePrefix("/upload/")).toBe("upload");
    expect(normalizeRelativePrefix("team//upload/")).toBe("team//upload");
  });

  it("归一化同样拒绝穿越段", () => {
    expect(() => normalizeRelativePrefix("../outside")).toThrow(BackupPathError);
    expect(() => normalizeRelativePrefix("/upload/%2e%2e")).toThrow(BackupPathError);
  });
});
