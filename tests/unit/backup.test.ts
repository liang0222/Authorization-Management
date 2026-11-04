import { describe, expect, it } from "vitest";
import { decryptBackup, encryptBackup, sha256Hex } from "@/lib/services/backup/crypto";
import {
  UPLOAD_ATTEMPTS,
  backupObjectKey,
  decideJobStatus,
  isTransientUploadError,
} from "@/lib/services/backup/runner";
import { isSameOriginTrailingSlashRedirect } from "@/lib/services/backup/adapters/webdav";
import { isCronLike, retentionSchema } from "@/lib/services/backup/schemas";

/**
 * 备份模块里不需要数据库就能验证的三块纯逻辑：
 * 加解密（含篡改检测）、作业状态判定（三种多目标模式）、调度表达式校验。
 * 这些是最容易被"看起来对"骗过去的地方，所以每一条都写死预期值。
 */

describe("备份包加解密", () => {
  it("往返后字节完全一致", () => {
    const payload = Buffer.from("PGDMP-something-binary\u0000\u0001\u0002", "utf8");
    const encrypted = encryptBackup(payload);
    expect(decryptBackup(encrypted.body).equals(payload)).toBe(true);
  });

  it("同一个明文每次加密结果都不同（IV 随机）", () => {
    const payload = Buffer.from("same payload", "utf8");
    const first = encryptBackup(payload);
    const second = encryptBackup(payload);
    expect(first.body.equals(second.body)).toBe(false);
    expect(first.sha256).not.toBe(second.sha256);
  });

  it("头部带魔数，且密文里看不到明文", () => {
    const payload = Buffer.from("SECRET-MARKER-12345", "utf8");
    const { body } = encryptBackup(payload);
    expect(body.subarray(0, 5).toString("ascii")).toBe("ZMBK1");
    expect(body.includes(payload)).toBe(false);
  });

  it("改一个字节就解不开（GCM 认证失败）", () => {
    const { body } = encryptBackup(Buffer.from("tamper me", "utf8"));
    const tampered = Buffer.from(body);
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptBackup(tampered)).toThrow();
  });

  it("不是备份包的文件在解密前就被拦住", () => {
    expect(() => decryptBackup(Buffer.from("not a backup file at all"))).toThrow(/魔数/);
  });

  it("sha256Hex 与 Node 的 digest 一致", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("作业状态判定 decideJobStatus", () => {
  const ok = { isRequired: true, ok: true, priority: 10 };
  const bad = { isRequired: true, ok: false, priority: 10 };

  it("all_required：全部成功才算成功", () => {
    expect(decideJobStatus("all_required", [ok, { ...ok, priority: 20 }])).toBe("succeeded");
    expect(decideJobStatus("all_required", [ok, { ...bad, priority: 20 }])).toBe("partial");
    expect(decideJobStatus("all_required", [bad, { ...bad, priority: 20 }])).toBe("failed");
  });

  it("all_required：只统计必需目标，可选目标失败不影响结论", () => {
    const optionalBad = { isRequired: false, ok: false, priority: 30 };
    expect(decideJobStatus("all_required", [ok, optionalBad])).toBe("succeeded");
  });

  it("primary_then_fallback：主目标成功即成功", () => {
    expect(decideJobStatus("primary_then_fallback", [{ ...ok, priority: 1 }, { ...bad, priority: 2 }])).toBe("succeeded");
  });

  it("primary_then_fallback：主失败备成功要标 degraded，不能算 succeeded", () => {
    expect(decideJobStatus("primary_then_fallback", [{ ...bad, priority: 1 }, { ...ok, priority: 2 }])).toBe("degraded");
    expect(decideJobStatus("primary_then_fallback", [{ ...bad, priority: 1 }, { ...bad, priority: 2 }])).toBe("failed");
  });

  it("quorum：达到阈值算 partial，未达到算 failed", () => {
    const results = [ok, bad, bad];
    expect(decideJobStatus("quorum", results, 1)).toBe("partial");
    expect(decideJobStatus("quorum", results, 2)).toBe("failed");
    expect(decideJobStatus("quorum", [ok, ok, bad], 3)).toBe("failed");
    expect(decideJobStatus("quorum", [ok, ok, ok], 3)).toBe("succeeded");
  });

  it("空结果集不会假装成功", () => {
    expect(decideJobStatus("all_required", [])).toBe("failed");
    expect(decideJobStatus("primary_then_fallback", [])).toBe("failed");
  });
});

describe("调度与保留策略校验", () => {
  it("接受五段标准 cron", () => {
    expect(isCronLike("0 3 * * *")).toBe(true);
    expect(isCronLike("*/15 9-17 * * 1-5")).toBe(true);
  });

  it("拒绝段数不对或含非法字符的表达式", () => {
    expect(isCronLike("0 3 * *")).toBe(false);
    expect(isCronLike("0 3 * * * *")).toBe(false);
    expect(isCronLike("0 3 * * MON")).toBe(false);
    expect(isCronLike("")).toBe(false);
  });

  it("保留策略有上下界，防止填出 0 天或负数", () => {
    expect(retentionSchema.safeParse({ daily: 7, weekly: 4, monthly: 6 }).success).toBe(true);
    expect(retentionSchema.safeParse({ daily: 0, weekly: 4, monthly: 6 }).success).toBe(false);
    expect(retentionSchema.safeParse({ daily: 7, weekly: -1, monthly: 6 }).success).toBe(false);
    expect(retentionSchema.safeParse({ daily: 7, weekly: 4, monthly: 999 }).success).toBe(false);
  });
});

describe("远端对象键 backupObjectKey（防前缀双拼回归）", () => {
  it("有 remote_prefix 时拼一次", () => {
    expect(backupObjectKey("backups/offsite", "bkp_20261103123208_765418")).toBe(
      "backups/offsite/bkp_20261103123208_765418.zmbk",
    );
  });

  it("前后斜杠被归一，不会产生双斜杠", () => {
    expect(backupObjectKey("/backups/offsite/", "bkp_x")).toBe("backups/offsite/bkp_x.zmbk");
    expect(backupObjectKey("//backups//offsite//", "bkp_x")).toBe("backups/offsite/bkp_x.zmbk");
  });

  it("没有 remote_prefix 时只留文件名，不会以斜杠开头", () => {
    expect(backupObjectKey(null, "bkp_x")).toBe("bkp_x.zmbk");
    expect(backupObjectKey(undefined, "bkp_x")).toBe("bkp_x.zmbk");
    expect(backupObjectKey("", "bkp_x")).toBe("bkp_x.zmbk");
    expect(backupObjectKey("/", "bkp_x")).toBe("bkp_x.zmbk");
  });

  it("前缀里出现重复时不做二次拼（这是当年的 bug 形态）", () => {
    // 回归断言：结果里 backups/offsite 只出现一次
    const key = backupObjectKey("backups/offsite", "bkp_x");
    expect(key.match(/backups\/offsite/g)).toHaveLength(1);
  });
});

describe("WebDAV MKCOL 尾斜杠重定向识别", () => {
  /**
   * Apache 对「已存在的集合 + 无尾斜杠」会回 301 到 `<path>/`。因为 request() 是
   * redirect:"manual"（防止把 Basic Auth 带去别的主机），这类重定向必须自己判定。
   * 下面把「该认」和「绝不能认」两类都写死。
   */
  const requested = "http://127.0.0.1:19080/backups/offsite";

  it("同源、路径相同、只多了尾斜杠 → 视为目录已存在", () => {
    expect(isSameOriginTrailingSlashRedirect("http://127.0.0.1:19080/backups/offsite/", requested)).toBe(true);
    // 相对 Location 同样成立
    expect(isSameOriginTrailingSlashRedirect("/backups/offsite/", requested)).toBe(true);
  });

  it("跨主机一律拒绝（哪怕路径一模一样）", () => {
    expect(isSameOriginTrailingSlashRedirect("http://evil.example.com/backups/offsite/", requested)).toBe(false);
    // 同主机不同端口也算跨源
    expect(isSameOriginTrailingSlashRedirect("http://127.0.0.1:19081/backups/offsite/", requested)).toBe(false);
  });

  it("同源但路径不同 → 拒绝（不是 DirectorySlash 那种情况）", () => {
    expect(isSameOriginTrailingSlashRedirect("http://127.0.0.1:19080/other/", requested)).toBe(false);
    expect(isSameOriginTrailingSlashRedirect("http://127.0.0.1:19080/backups/offsite/nested/", requested)).toBe(false);
  });

  it("缺失或非法的 Location → 拒绝", () => {
    expect(isSameOriginTrailingSlashRedirect(null, requested)).toBe(false);
    expect(isSameOriginTrailingSlashRedirect("", requested)).toBe(false);
    expect(isSameOriginTrailingSlashRedirect("http://[::bad", requested)).toBe(false);
  });
});

describe("上传重试判定", () => {
  it("超时、连接重置、DNS 抖动都算可重试", () => {
    for (const message of [
      "The operation was aborted due to timeout",
      "read ETIMEDOUT",
      "read ECONNRESET",
      "connect ECONNREFUSED 203.0.113.20:5244",
      "write EPIPE",
      "getaddrinfo EAI_AGAIN",
      "socket hang up",
      "fetch failed",
    ]) {
      expect(isTransientUploadError(message), message).toBe(true);
    }
  });

  it("服务端明确拒绝不算可重试（重试只会重复失败）", () => {
    for (const message of [
      "WebDAV PUT 失败：HTTP 401",
      "WebDAV PUT 失败：HTTP 403",
      "WebDAV PUT 失败：HTTP 404",
      "创建目录失败：backups（HTTP 405）",
      "远端 SHA-256 为 abc",
      "WebDAV 端点不是 https，且没有显式设 tlsVerify=false 放行",
    ]) {
      expect(isTransientUploadError(message), message).toBe(false);
    }
  });

  it("尝试次数是 2：够覆盖偶发抖动，又不会把作业拖长", () => {
    expect(UPLOAD_ATTEMPTS).toBe(2);
  });
});
