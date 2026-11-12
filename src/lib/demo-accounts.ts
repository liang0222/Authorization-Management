/**
 * 生产库里的演示账号检测（阶段 2）。
 *
 * `prisma/seed.ts` 会建三个 `*@xinglan.dev` 的账号，密码是公开的演示口令。
 * 这些账号落在生产库里就等于给了一个人人都知道密码的管理员入口。
 * 所以生产启动时查一遍，命中就作为启动闸门的一条 issue（阶段 1 的规则会据此拒绝启动）。
 *
 * 拆成「纯判定」+「查询」两层：纯判定可以在单测里喂假数据，
 * 查询层只在 `DEPLOYMENT_ENV=production` 的启动路径上调用一次。
 */

/** seed 里的演示邮箱域。 */
export const DEMO_EMAIL_DOMAIN = "xinglan.dev";

/** seed 里的三个 display_name（见 `prisma/seed.ts` 的 users.create）。 */
export const DEMO_DISPLAY_NAMES = ["陈星岚", "林可", "周睿（审计）"] as const;

export type DemoAccountRow = {
  email: string;
  display_name?: string | null;
};

/** 单条 issue 的正文里只放邮箱与显示名——不涉及口令，也不会被当成敏感值。 */
function describe(row: DemoAccountRow): string {
  const name = row.display_name?.trim();
  return `生产库里存在演示账号 ${row.email}${name ? `（displayName=${name}）` : ""}：这是 seed 产物，密码是公开的演示口令，必须先改密或删除`;
}

/**
 * 把查询结果转成 issue 列表：**每个命中账号一条**，方便启动日志逐条列出。
 * 去重按邮箱（邮箱本身有唯一索引，这里只是防止上游 join 出重复行）。
 */
export function demoAccountIssuesFromRows(rows: readonly DemoAccountRow[]): string[] {
  const seen = new Set<string>();
  const issues: string[] = [];
  for (const row of rows) {
    const email = row.email.trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    issues.push(describe({ email: row.email.trim(), display_name: row.display_name ?? null }));
  }
  return issues;
}

/**
 * 查询生产库里的演示账号。
 *
 * 只在生产启动路径上调用；调用方负责把异常降级为警告——表还没建（全新实例跑安装器之前）
 * 这种情况不该把启动打断，那是「装完再检查」的问题，不是「带着演示账号上线」的问题。
 */
export async function findDemoAccountIssues(): Promise<string[]> {
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.users.findMany({
    where: {
      OR: [
        { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}`, mode: "insensitive" } },
        { display_name: { in: [...DEMO_DISPLAY_NAMES] } },
      ],
    },
    select: { email: true, display_name: true },
    orderBy: { email: "asc" },
    take: 50,
  });
  return demoAccountIssuesFromRows(rows);
}

export type DemoAccountBootCheck = {
  /** 需要并入启动闸门的 issue。 */
  issues: string[];
  /** 降级警告（查询失败时），调用方打印即可。 */
  warning?: string;
};

/**
 * 启动期入口：只在 `DEPLOYMENT_ENV=production` 时查库。
 *
 * 两条边界要守住：
 * - 开发/沙箱**完全不查**：那边本来就该有演示账号，查了只会天天报警。
 * - 生产查库失败（全新实例还没跑迁移，`users` 表不存在）降级为警告——
 *   那是「还没装完」，不是「带着演示账号上线」，不该把启动打断；
 *   安装器 finalize 之后会重启进程，届时会重新检测。
 *
 * `finder` 作为参数注入，单测可以喂假实现覆盖「命中 / 空 / 抛错」三条路径。
 */
export async function demoAccountBootCheck(
  deploymentEnv: string,
  finder: () => Promise<string[]>,
): Promise<DemoAccountBootCheck> {
  if (deploymentEnv !== "production") return { issues: [] };
  try {
    return { issues: await finder() };
  } catch (error) {
    // Prisma 的报错正文第一行常常是空的（形如 "\nInvalid `prisma.users.findMany()` ..."），
    // 所以取第一个非空行，别把原因打成一对空括号。
    const raw = error instanceof Error ? error.message : String(error);
    const lines = raw.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
    // Prisma 的报错头一行只有 `Invalid \`prisma.users.findMany()\` invocation:`，
    // 真正的原因（表不存在、连不上库）在最后一行，两个都带上才有排查价值。
    const reason =
      lines.length > 1 && lines[0]!.startsWith("Invalid `")
        ? `${lines[0]} ${lines[lines.length - 1]}`
        : (lines[0] ?? (error instanceof Error ? error.name : "未知错误"));
    return {
      issues: [],
      warning: `[boot] 演示账号检测已跳过：查询 users 表失败（${reason}）。表未建属预期，安装完成后会重新检测。`,
    };
  }
}
