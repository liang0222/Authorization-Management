/**
 * 数据库连接与初始化条件探测（规格 §五 第 9、10 步）。
 *
 * 设计原则：
 * - 只用 `pg` 的 Client，短连接，用完立刻 end()，绝不留连接池。
 * - 所有 SQL 都是固定语句，没有任何字符串拼接，因此不存在注入面。
 * - 错误必须分类到人能看懂的中文原因（Phase 7 要求分别测「密码错误」与「库不存在」，
 *   这两种在 PG 里是 28P01 与 3D000，必须能区分开）。
 */
import { Client } from "pg";
import type {
  DatabaseInspection,
  DatabaseTestResult,
  InstallerConfigInput,
} from "@/lib/installer/contract";

export interface ParsedDatabaseUrl {
  scheme: string;
  host: string;
  port: number;
  database: string;
  username: string;
  /** 已做 URL 解码的明文密码；只允许在内存里传给 pg，绝不落盘/落日志。 */
  password: string;
  searchPath?: string;
  raw: string;
}

export class DatabaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseUrlError";
  }
}

export function parseDatabaseUrl(raw: string): ParsedDatabaseUrl {
  const trimmed = raw.trim();
  if (!trimmed) throw new DatabaseUrlError("数据库连接串为空");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new DatabaseUrlError("数据库连接串格式不合法，应形如 postgresql://用户:密码@主机:端口/库名");
  }

  const scheme = url.protocol.replace(/:$/, "");
  if (scheme !== "postgres" && scheme !== "postgresql") {
    throw new DatabaseUrlError(`不支持的数据库类型 ${scheme}，当前适配器只支持 postgresql`);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database) throw new DatabaseUrlError("连接串里没有库名");

  const host = url.hostname || "127.0.0.1";
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new DatabaseUrlError(`端口不合法：${url.port}`);
  }

  const username = decodeURIComponent(url.username);
  if (!username) throw new DatabaseUrlError("连接串里没有用户名");

  return {
    scheme,
    host,
    port,
    database,
    username,
    password: decodeURIComponent(url.password),
    searchPath: url.searchParams.get("schema") ?? undefined,
    raw: trimmed,
  };
}

/** 已经脱敏的连接描述，可安全展示与记日志。 */
export function describeTarget(parsed: ParsedDatabaseUrl): string {
  return `${parsed.username}@${parsed.host}:${parsed.port}/${parsed.database}`;
}

/** SQLSTATE / 网络错误码 → 中文解释。导出是为了让测试与运维文档共用同一份。 */
export const ERROR_MAP: Record<string, { message: string; hint: string }> = {
  "28P01": { message: "用户名或密码错误", hint: "核对连接串里的用户名与密码；注意密码里的特殊字符要 URL 编码" },
  "28000": { message: "认证失败", hint: "检查 pg_hba.conf 是否允许该来源与认证方式" },
  "3D000": { message: "数据库不存在", hint: "先在 PostgreSQL 里创建该库，或把库名改成已存在的库" },
  "42501": { message: "权限不足", hint: "该用户需要目标库的 CONNECT 与 CREATE 权限" },
  "42P07": { message: "对象已存在", hint: "目标库里已有同名表，确认是否装到了错误的库" },
  "53300": { message: "数据库连接数已满", hint: "调大 max_connections 或减少并发安装" },
  "57P03": { message: "数据库正在启动，暂不接受连接", hint: "等几秒后重试" },
};

/** 把数据库/网络错误翻成用户能看懂的中文；未知错误保留原文，不吞掉。 */
export function mapError(error: unknown): { code?: string; message: string; hint?: string } {
  const err = error as NodeJS.ErrnoException & { code?: string; detail?: string; message?: string };
  const code = err?.code;

  if (code && ERROR_MAP[code]) {
    return { code, message: ERROR_MAP[code].message, hint: ERROR_MAP[code].hint };
  }
  switch (code) {
    case "ECONNREFUSED":
      return {
        code,
        message: "目标端口没有服务在监听",
        hint: "确认 PostgreSQL 已启动、端口正确，且监听地址允许本机连接",
      };
    case "ENOTFOUND":
      return { code, message: "主机名解析失败", hint: "检查主机名拼写，或改用 IP 地址" };
    case "ETIMEDOUT":
      return { code, message: "连接超时", hint: "检查防火墙、安全组与 PostgreSQL 的 listen_addresses" };
    case "EHOSTUNREACH":
      return { code, message: "主机不可达", hint: "检查网络连通性" };
    case "ECONNRESET":
      return { code, message: "连接被对端重置", hint: "可能是 TLS 或 pg_hba 拒绝；查看数据库日志" };
    default:
      return {
        code,
        // 字符串型错误（pg 的某些拒绝会直接抛字符串）也要原样带出来，不能吞成「未知」。
        message: typeof error === "string" ? error : (err?.message ?? "未知数据库错误"),
        hint: "查看数据库服务端日志",
      };
  }
}

function buildClient(parsed: ParsedDatabaseUrl): Client {
  return new Client({
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.username,
    password: parsed.password,
    // 只给安装期用的短连接，超时收紧，避免卡住 UI。
    connectionTimeoutMillis: 8000,
    statement_timeout: 15000,
    query_timeout: 15000,
    application_name: "universal-installer",
    ...(parsed.searchPath ? { options: `-c search_path=${parsed.searchPath}` } : {}),
  });
}

/**
 * 从表单里取出连接串。
 *
 * 向导既支持「直接填 databaseUrl」，也支持分开填 host/port/database/username/password。
 * 早期版本这里只读 databaseUrl，导致用户在 UI 里逐项填写后点「测试连接」，
 * 永远拿到「数据库连接串为空」——这是实测暴露的缺陷，不是猜测。
 */
export function buildDatabaseUrl(input: InstallerConfigInput): string {
  const direct = String(input.database?.databaseUrl ?? "").trim();
  if (direct) return direct;

  const host = String(input.database?.host ?? "").trim();
  const port = String(input.database?.port ?? "5432").trim() || "5432";
  const database = String(input.database?.database ?? "").trim();
  const username = String(input.database?.username ?? "").trim();
  const password = String(input.database?.password ?? "");
  const schema = String(input.database?.schema ?? "public").trim() || "public";

  if (!host || !database || !username) {
    return "";
  }
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${encodeURIComponent(
    database,
  )}?schema=${encodeURIComponent(schema)}`;
}

export interface TestOptions {
  /** 允许覆盖，用于测试注入。 */
  timeoutMs?: number;
}

/** 第 9 步：真的建一条连接、真的执行一条查询。 */
export async function testDatabaseConnection(
  input: InstallerConfigInput,
  options: TestOptions = {},
): Promise<DatabaseTestResult> {
  let parsed: ParsedDatabaseUrl;
  try {
    const url = buildDatabaseUrl(input);
    if (!url) {
      return {
        ok: false,
        target: "(连接信息不完整)",
        errorCode: "INCOMPLETE",
        errorMessage: "数据库连接信息不完整：需要主机、库名、用户名，或直接填连接串",
        hint: "形如 postgresql://用户:密码@主机:端口/库名",
      };
    }
    parsed = parseDatabaseUrl(url);
  } catch (error) {
    return {
      ok: false,
      target: "(连接串无效)",
      errorCode: "INVALID_URL",
      errorMessage: (error as Error).message,
      hint: "形如 postgresql://用户:密码@主机:端口/库名",
    };
  }

  const target = describeTarget(parsed);
  const started = Date.now();
  const client = buildClient(parsed);
  // 兜底：pg 的 connectionTimeoutMillis 在 DNS 阶段不一定生效，外面再套一层。
  const timeout = options.timeoutMs ?? 12000;
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("连接超时"), { code: "ETIMEDOUT" })), timeout);
      }),
    ]);
    const { rows } = await client.query<{ version: string; current_database: string; current_user: string }>(
      "select version() as version, current_database() as current_database, current_user as current_user",
    );
    const latencyMs = Date.now() - started;
    const version = rows[0]?.version ?? "";
    // 只取 "PostgreSQL 16.4" 这一截，别把编译参数丢给前端。
    const short = /PostgreSQL\s+[\d.]+/.exec(version)?.[0] ?? version.slice(0, 60);
    return { ok: true, target, serverVersion: short, latencyMs };
  } catch (error) {
    const mapped = mapError(error);
    return {
      ok: false,
      target,
      latencyMs: Date.now() - started,
      errorCode: mapped.code,
      errorMessage: mapped.message,
      hint: mapped.hint,
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.end().catch(() => undefined);
  }
}

/**
 * 第 10 步：检查初始化条件。
 * 这一层只读，绝不删表、绝不 TRUNCATE（规格：数据库存在业务数据时禁止擅自清空）。
 */
export async function inspectDatabase(
  input: InstallerConfigInput,
): Promise<DatabaseInspection> {
  const empty: DatabaseInspection = {
    ok: false,
    tableCount: 0,
    looksLikeProject: false,
    appliedMigrations: 0,
    hasBusinessData: false,
    canCreate: false,
    warnings: [],
  };

  let parsed: ParsedDatabaseUrl;
  try {
    const url = buildDatabaseUrl(input);
    if (!url) {
      return { ...empty, warnings: ["数据库连接信息不完整：需要主机、库名、用户名，或直接填连接串"] };
    }
    parsed = parseDatabaseUrl(url);
  } catch (error) {
    return { ...empty, warnings: [(error as Error).message] };
  }

  const client = buildClient(parsed);
  try {
    await client.connect();

    const tables = await client.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    const tableCount = Number(tables.rows[0]?.count ?? 0);

    /*
     * 建表靠的是「目标 schema 的 CREATE 权限」，不是「数据库的 CREATE 权限」。
     * 数据库级 CREATE 只允许建 schema；一个只有 schema 级 CREATE 的用户照样能跑 Prisma 迁移。
     * 原来只查数据库级，会把这种合法配置误判成「无法建表」并直接拦死安装（实测踩到）。
     */
    const canCreate = await client.query<{ schema_ok: boolean; db_ok: boolean }>(
      "select has_schema_privilege(current_schema(), 'CREATE') as schema_ok, has_database_privilege(current_database(), 'CREATE') as db_ok",
    );
    const schemaCanCreate = Boolean(canCreate.rows[0]?.schema_ok);
    const dbCanCreate = Boolean(canCreate.rows[0]?.db_ok);

    let appliedMigrations = 0;
    let hasPrisma = false;
    if (tableCount > 0) {
      const prisma = await client.query<{ count: string }>(
        "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name = '_prisma_migrations'",
      );
      hasPrisma = Number(prisma.rows[0]?.count ?? 0) > 0;
      if (hasPrisma) {
        const applied = await client.query<{ count: string }>(
          "select count(*)::text as count from _prisma_migrations where finished_at is not null and rolled_back_at is null",
        );
        appliedMigrations = Number(applied.rows[0]?.count ?? 0);
      }
    }

    // 业务数据判定：本项目用 organizations / users 是否存在行。
    let hasBusinessData = false;
    const hasOrgs = await client.query<{ count: string }>(
      "select count(*)::text as count from information_schema.tables where table_schema = 'public' and table_name = 'organizations'",
    );
    if (Number(hasOrgs.rows[0]?.count ?? 0) > 0) {
      const rows = await client.query<{ count: string }>("select count(*)::text as count from organizations");
      hasBusinessData = Number(rows.rows[0]?.count ?? 0) > 0;
    }

    const looksLikeProject = hasPrisma || tableCount === 0;

    const warnings: string[] = [];
    if (tableCount > 0 && !hasPrisma) {
      warnings.push(
        `目标库已有 ${tableCount} 张表，但不是本项目的 Prisma 库；继续安装可能污染既有数据，请确认库名`,
      );
    }
    if (hasBusinessData) {
      warnings.push("目标库已有业务数据（organizations 非空）；安装器不会清空它，但请确认这是你要装进去的库");
    }
    if (!schemaCanCreate) {
      warnings.push(
        `当前数据库用户没有 ${parsed.searchPath || "public"} schema 的 CREATE 权限，无法建表（数据库级 CREATE：${dbCanCreate ? "有" : "无"}）`,
      );
    } else if (!dbCanCreate) {
      /*
       * 建表只需 schema 级权限，但迁移里可能有 CREATE EXTENSION（本项目 init 迁移就要 pgcrypto），
       * 那条语句要求数据库级 CREATE。这里只告警不拦：扩展也可能已由 DBA 预装。
       */
      warnings.push(
        "数据库级 CREATE 权限缺失：建表没问题，但如果迁移脚本需要 CREATE EXTENSION（例如 pgcrypto），会在此处失败；可让 DBA 预装扩展或临时授权",
      );
    }

    return {
      ok: schemaCanCreate,
      tableCount,
      looksLikeProject,
      appliedMigrations,
      hasBusinessData,
      canCreate: schemaCanCreate,
      warnings,
    };
  } catch (error) {
    const mapped = mapError(error);
    return { ...empty, warnings: [mapped.message, ...(mapped.hint ? [mapped.hint] : [])] };
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** 供适配器复用：用给定连接串开一个短连接执行一条只读查询。 */
export async function withClient<T>(
  databaseUrl: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const parsed = parseDatabaseUrl(databaseUrl);
  const client = buildClient(parsed);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}
