/**
 * 生产环境自检（阶段 2）。
 *
 *   npm run check:prod-env                    # 默认读 .env
 *   npm run check:prod-env -- --env-file /etc/licensing-saas/production.env
 *
 * 输出逐项 PASS/FAIL，任一 FAIL 以退出码 1 结束（可直接串进上线脚本）。
 *
 * 安全约定：**绝不打印密钥值或片段**。密钥项只说「是否仍是开发默认值 / 长度是否够」；
 * 数据库连接串只说 host 与是否用了开发口令。判定逻辑在 src/lib/prod-env-check.ts。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseEnv } from "dotenv";
import { checkProdEnv, hasFailure, type EnvCheckItem } from "../src/lib/prod-env-check";

function parseArgs(argv: string[]): { envFile: string } {
  const index = argv.findIndex((a) => a === "--env-file" || a.startsWith("--env-file="));
  if (index === -1) return { envFile: ".env" };
  const arg = argv[index]!;
  if (arg.startsWith("--env-file=")) {
    return { envFile: arg.slice("--env-file=".length) };
  }
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error("--env-file 后面要跟文件路径");
    process.exit(2);
  }
  return { envFile: value };
}

function printItem(item: EnvCheckItem): void {
  const tag = item.status === "PASS" ? "PASS" : "FAIL";
  console.log(`${tag}  ${item.name.padEnd(22)}${item.detail}`);
}

function main(): void {
  const { envFile } = parseArgs(process.argv.slice(2));
  const path = resolve(process.cwd(), envFile);

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    console.error(`读不到 env 文件：${path}`);
    console.error("用 --env-file <path> 指定，例如：npm run check:prod-env -- --env-file /etc/licensing-saas/production.env");
    process.exit(2);
  }

  const env = parseEnv(content);
  const items = checkProdEnv(env);
  const failCount = items.filter((i) => i.status === "FAIL").length;

  console.log(`检查文件：${path}`);
  console.log("");
  for (const item of items) printItem(item);
  console.log("");
  console.log(`汇总：${items.length} 项，PASS ${items.length - failCount} / FAIL ${failCount}`);

  if (hasFailure(items)) {
    console.log("");
    console.log("结论：不满足生产要求，先改 env 再上线。");
    process.exit(1);
  }
  console.log("结论：全部通过，可以作为生产 env 使用。");
}

main();
