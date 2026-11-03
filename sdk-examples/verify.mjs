/**
 * SDK 示例最小测试：跑完六个语言，断言成功路径与失败路径都符合预期。
 *
 * 用法（dev server 必须在跑）：
 *   LICENSE_KEY=<授权码> node sdk-examples/verify.mjs
 *
 * 两种失败都要让脚本退出码非 0：
 *   1. 某个语言成功路径没打印 effective_status: active；
 *   2. 某个语言失败路径没有被拒（说明校验有洞），或进程本身崩了。
 *
 * 为什么先 PATCH 一次授权限额：每个语言示例都会注册一个新设备实例，
 * 反复跑迟早撞上 maxDevices / maxActivationCount。把上限抬到足够大，
 * 这个脚本才能反复执行，而不是跑两遍就红。
 */
import { execFile } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const BASE = process.env.LICENSE_BASE_URL?.replace(/\/api\/v1$/, "") ?? "http://127.0.0.1:3000";
const ADMIN_EMAIL = process.env.LICENSE_ADMIN_EMAIL ?? "owner@xinglan.dev";
const ADMIN_PASSWORD = process.env.LICENSE_ADMIN_PASSWORD ?? "License#2026";
const LICENSE_KEY = process.env.LICENSE_KEY ?? "";
const LICENSE_ID = process.env.LICENSE_ID ?? "";
const PRODUCT_ID = process.env.LICENSE_PRODUCT_ID ?? "";
const CLIENT_ID = process.env.LICENSE_CLIENT_ID ?? "";
const KEY_ROOT = process.env.LICENSE_KEY_ROOT ?? "/tmp/ziming-sdk-verify";

/**
 * 语言之间的间隔。
 *
 * 每个示例都会打两次 `/activations`（成功 + 失败路径），六个语言共 12 次；
 * 而公开限流是 `/activations` 每产品 **10 次 / 60 秒**。不留间隔地连跑，
 * 第 6 个语言必然拿到 429 RATE_LIMITED —— 那是限流在正常工作，不是 SDK 有问题。
 * 间隔 12 秒能让 12 次请求铺开在 60 秒窗口之外。
 */
const GAP_MS = Number(process.env.LICENSE_VERIFY_GAP_MS ?? 12_000);
/** 万一还是撞上限流：按 retry-after 等一次再重试该语言。 */
const RETRY_ON_RATE_LIMIT = process.env.LICENSE_VERIFY_NO_RETRY !== "1";

if (!LICENSE_KEY || !PRODUCT_ID) {
  console.error("需要 LICENSE_KEY 与 LICENSE_PRODUCT_ID 环境变量");
  process.exit(2);
}

/* ------------------------------------------------------------------ 管理端 */

async function adminSession() {
  const response = await fetch(`${BASE}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!response.ok) throw new Error(`登录失败 ${response.status}`);
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map((item) => item.split(";")[0]).join("; ");
  const csrf = cookies.find((item) => item.startsWith("lic_csrf="))?.split(";")[0].split("=")[1] ?? "";
  return { cookie, csrf };
}

async function raiseLimits(session) {
  if (!LICENSE_ID) {
    console.log("跳过抬高限额（未提供 LICENSE_ID）——本脚本重复运行前请确认设备名额够用");
    return;
  }
  const response = await fetch(`${BASE}/api/v1/admin/licenses/${LICENSE_ID}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
    },
    body: JSON.stringify({ maxDevices: 50, maxActivationCount: 500 }),
  });
  if (!response.ok) {
    throw new Error(`抬高授权限额失败 ${response.status}: ${await response.text()}`);
  }
  console.log("已把授权限额抬到 maxDevices=50 / maxActivationCount=500（便于反复运行）");
}

/* ------------------------------------------------------------------ 断言 */

/** 每个语言怎么跑、成功路径该打印什么、失败路径该打印什么。 */
const TARGETS = [
  {
    name: "python",
    command: "python3",
    args: ["sdk-examples/python/quickstart.py"],
    okPattern: /effective_status: active/,
    rejectPattern: /预期失败：LICENSE_INVALID/,
  },
  {
    name: "node",
    command: "node",
    args: ["sdk-examples/node/quickstart.mjs"],
    okPattern: /effective_status: active/,
    rejectPattern: /预期失败：LICENSE_INVALID/,
  },
  {
    name: "php",
    command: "php",
    args: ["sdk-examples/php/quickstart.php"],
    okPattern: /effective_status: active/,
    rejectPattern: /预期失败：LICENSE_INVALID/,
  },
  {
    name: "go",
    command: "go",
    args: ["run", "quickstart.go"],
    cwd: "sdk-examples/go",
    okPattern: /effective_status: active/,
    rejectPattern: /已被拒绝（预期）: LICENSE_INVALID/,
  },
  {
    name: "java",
    command: "java",
    args: ["-cp", process.env.JAVA_CLASSES ?? "/tmp/java-example", "Quickstart"],
    okPattern: /effective_status: active/,
    rejectPattern: /已被拒绝（预期）: LICENSE_INVALID/,
    prepare: "javac -d ${JAVA_CLASSES} sdk-examples/java/Quickstart.java",
  },
  {
    name: "csharp",
    command: "mono",
    args: [process.env.CSHARP_EXE ?? "/tmp/csharp-example/Quickstart.exe"],
    okPattern: /effective_status: active/,
    rejectPattern: /已被拒绝（预期）: LICENSE_INVALID/,
    prepare: "mcs -out:${CSHARP_EXE} -r:${CSHARP_BCL} -r:System.Net.Http.dll sdk-examples/csharp/Quickstart.cs",
  },
];

const env = {
  ...process.env,
  LICENSE_BASE_URL: `${BASE}/api/v1`,
  LICENSE_CLIENT_ID: CLIENT_ID,
  LICENSE_PRODUCT_ID: PRODUCT_ID,
  LICENSE_KEY,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从一个语言的输出里读出限流要求的等待秒数；读不到就退到 20 秒。 */
function retryDelay(output) {
  const match = output.match(/(\d+)\s*秒后重试/) ?? output.match(/retry[_-]?after["':\s]+(\d+)/i);
  return (match ? Number(match[1]) : 20) * 1000 + 1_000;
}

async function runTarget(target, keyDir) {
  try {
    const { stdout, stderr } = await run(target.command, target.args, {
      cwd: target.cwd,
      env: { ...env, LICENSE_KEY_DIR: keyDir },
      timeout: 120_000,
    });
    return { code: 0, output: `${stdout}\n${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, output: `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}` };
  }
}

async function main() {
  const session = await adminSession();
  await raiseLimits(session);

  mkdirSync(KEY_ROOT, { recursive: true });
  const failures = [];

  for (const [index, target] of TARGETS.entries()) {
    if (index > 0 && GAP_MS > 0) {
      // 说明见文件头：这是给公开限流留的间隔，不是脚本慢。
      console.log(`… 等待 ${Math.round(GAP_MS / 1000)}s（避开 /activations 的 10 次/60 秒限流）`);
      await sleep(GAP_MS);
    }

    const keyDir = `${KEY_ROOT}/${target.name}`;
    rmSync(keyDir, { recursive: true, force: true });
    const started = Date.now();
    let result = await runTarget(target, keyDir);

    if (RETRY_ON_RATE_LIMIT && /RATE_LIMITED/.test(result.output)) {
      const wait = retryDelay(result.output);
      console.log(`… ${target.name} 撞到限流，等 ${Math.round(wait / 1000)}s 后重试`);
      await sleep(wait);
      rmSync(keyDir, { recursive: true, force: true });
      result = await runTarget(target, keyDir);
    }

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const ok = target.okPattern.test(result.output);
    const rejected = target.rejectPattern.test(result.output);

    if (ok && rejected) {
      console.log(`PASS ${target.name.padEnd(6)} ${seconds}s`);
    } else {
      console.log(`FAIL ${target.name.padEnd(6)} ${seconds}s  ok=${ok} rejected=${rejected}`);
      failures.push({
        name: target.name,
        stage: ok ? "失败路径" : "成功路径",
        output: result.output,
      });
    }
  }

  if (failures.length > 0) {
    console.log("\n失败详情：");
    for (const failure of failures) {
      console.log(`\n--- ${failure.name}（${failure.stage}）`);
      console.log(failure.output.trim().split("\n").slice(-12).join("\n"));
    }
    process.exit(1);
  }
  console.log(`\n${TARGETS.length}/${TARGETS.length} 全部通过`);
}

await main();