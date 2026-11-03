/**
 * 列表 API 的游标分页（规格 27.5）。
 *
 * 规格要求「管理/开发者门户的列表 API 使用 cursor 分页，不使用大 offset」，
 * 且「Cursor 应签名或服务端存储，不能把可篡改 SQL 条件直接编码给客户端」。
 *
 * 这里的做法：
 * - 游标只装一个位置（offset）与作用域（接口路径），不装任何业务条件；
 * - 位置用 HMAC-SHA256 签名，密钥由 SESSION_SECRET 派生，客户端改一个字节就失效；
 * - 作用域绑定到具体接口，A 接口签出的游标拿到 B 接口会被判定无效，
 *   避免「拿列表游标去翻别的表」；
 * - 对外是不透明 base64url，客户端不该解析它。
 *
 * 为什么仍是 offset 而不是严格 keyset：现有列表服务统一走 Prisma `skip/take` +
 * 多字段排序，改 keyset 要逐表定义稳定排序键（时间戳可能重复，需要 tie-breaker）。
 * 用签名游标把 offset 关在服务端签名里，已经堵住「篡改条件」与「手改页码跳表」，
 * 而真正的收益（稳定翻页、不随总数偏移）需要 keyset 才有 —— 那属于下一轮的工作。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "@/lib/config";

const CURSOR_VERSION = "c1";

export interface CursorPayload {
  /** 已消费的行数（下一页从 offset 开始）。 */
  offset: number;
  /** 绑定的接口路径，用于阻止游标跨接口复用。 */
  scope: string;
}

function sign(body: string, scope: string): string {
  return createHmac("sha256", `list-cursor:${config.sessionSecret}`)
    .update(`${CURSOR_VERSION}\n${scope}\n${body}`)
    .digest("base64url")
    .slice(0, 32);
}

/** 把位置编成不透明游标。 */
export function encodeCursor(payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify({ o: payload.offset, s: payload.scope }), "utf8").toString("base64url");
  return `${CURSOR_VERSION}.${body}.${sign(body, payload.scope)}`;
}

/**
 * 解析并验签。任何异常（格式错、签名不符、作用域不符、offset 非法）都返回 null，
 * 由调用方决定报 400 还是回退到第一页 —— 统一报错更利于发现客户端写错。
 */
export function decodeCursor(cursor: string, scope: string): CursorPayload | null {
  const parts = cursor.split(".");
  if (parts.length !== 3 || parts[0] !== CURSOR_VERSION) return null;
  const [, body, signature] = parts;
  const expected = sign(body, scope);
  if (expected.length !== signature.length) return null;
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { o, s } = parsed as { o?: unknown; s?: unknown };
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) return null;
  if (typeof s !== "string" || s !== scope) return null;
  return { offset: o, scope: s };
}
