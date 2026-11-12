/**
 * 备份路径安全：把「配置里的路径」当成不可信输入处理。
 *
 * 为什么单独抽出来：
 * - `root_path` / `remote_prefix` 会直接拼进 WebDAV URL、SFTP 绝对路径、S3 对象键和本地文件路径；
 * - 只要允许 `..`，WebDAV 的 URL 解析会把 `/dav/upload/../../etc` 归一化成 `/etc`，
 *   SFTP 同理，本地 `resolve()` 也会逃出根目录；
 * - 百分号编码的 `%2e%2e` 在 WHATWG URL 里同样会被当作 `..` 处理，所以必须在解码后再判一次。
 *
 * 策略：绝对路径允许（前导 `/` 会被调用方裁掉），但任何 `.`/`..` 段、反斜杠、
 * 编码后的路径分隔符与控制字符一律拒绝。宁可让配置显式报错，也不做「猜用户想放哪」的归一化。
 */

export class BackupPathError extends Error {
  readonly code = "INVALID_BACKUP_PATH";

  constructor(message: string) {
    super(message);
    this.name = "BackupPathError";
  }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function decodeSegment(segment: string, raw: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new BackupPathError(`备份路径包含无效的百分号编码：${raw}`);
  }
}

/** 校验一段路径（可含 `/`），返回原值；不安全时抛 BackupPathError。 */
export function assertSafeBackupPath(value: string, label = "备份路径"): string {
  if (CONTROL_CHARS.test(value)) {
    throw new BackupPathError(`${label}不能包含控制字符`);
  }
  if (value.includes("\\")) {
    throw new BackupPathError(`${label}不能包含反斜杠`);
  }
  for (const segment of value.split("/")) {
    if (!segment) continue;
    const decoded = decodeSegment(segment, value);
    if (decoded === "." || decoded === "..") {
      throw new BackupPathError(`${label}不能包含 . 或 .. 路径段`);
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      throw new BackupPathError(`${label}不能包含编码后的路径分隔符`);
    }
    if (CONTROL_CHARS.test(decoded)) {
      throw new BackupPathError(`${label}不能包含控制字符`);
    }
  }
  return value;
}

/**
 * 校验并归一化「相对前缀」：去掉首尾 `/`，保留内部层级。
 * 用于 `root_path`（远端/S3 前缀）与 `remote_prefix`；本地磁盘根目录不走这里（绝对路径合法）。
 */
export function normalizeRelativePrefix(value: string | null | undefined, label = "备份路径"): string {
  const raw = value?.trim() ?? "";
  if (!raw) return "";
  assertSafeBackupPath(raw, label);
  return raw.replace(/^\/+|\/+$/g, "");
}
