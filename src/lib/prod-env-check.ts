/**
 * 生产环境自检（阶段 2）：`npm run check:prod-env`。
 *
 * 上线前把「最容易配错、配错最要命」的几项逐条过一遍，每条只输出 PASS/FAIL 与**结论**，
 * 绝不打印密钥值或其片段——包括长度、前几位、哈希，都不打。
 *
 * 纯函数在 `src/lib/prod-env-check.ts`，便于单测；读 env 文件、打印、退出码在 `scripts/check-prod-env.mts`。
 */

import { DEV_DEFAULTS } from "./config";

export type EnvCheckStatus = "PASS" | "FAIL";

export type EnvCheckItem = {
  /** 检查项名字（通常是环境变量名）。 */
  name: string;
  status: EnvCheckStatus;
  /** 人类可读的结论。**不允许**出现密钥值或片段。 */
  detail: string;
};

export type EnvLike = Record<string, string | undefined>;

/** 长度下限：与 Next/iron-session 之类的库无关，纯粹是「够不够当密钥」的经验值。 */
const MIN_SECRET_LENGTH = 32;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** 判断主机是否属于本机/内网（10/8、172.16/12、192.168/16、169.254/16、fc00::/7）。 */
export function isLocalOrPrivateHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (LOCAL_HOSTS.has(normalized)) return true;
  if (/^10\./.test(normalized)) return true;
  if (/^192\.168\./.test(normalized)) return true;
  if (/^169\.254\./.test(normalized)) return true;
  const m = /^172\.(\d{1,3})\./.exec(normalized);
  if (m) {
    const second = Number(m[1]);
    if (second >= 16 && second <= 31) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
  return false;
}

function secretItem(env: EnvLike, name: string, devDefault: string): EnvCheckItem {
  const value = env[name];
  if (!value || value.length === 0) {
    return { name, status: "FAIL", detail: "未设置，运行时会回落到开发默认值" };
  }
  if (value === devDefault) {
    return { name, status: "FAIL", detail: "仍是开发默认值" };
  }
  if (value.length < MIN_SECRET_LENGTH) {
    return { name, status: "FAIL", detail: `长度不足 ${MIN_SECRET_LENGTH}` };
  }
  // 只报结论：不打印值、长度、前几位、摘要。
  return { name, status: "PASS", detail: "非开发默认值，长度满足要求" };
}

/**
 * 逐项检查。顺序固定，输出即报告顺序。
 *
 * 三把密钥 + `SECRETBOX_KEY` 共四项走「密钥」检查；其余是布尔/字符串语义检查。
 */
export function checkProdEnv(env: EnvLike): EnvCheckItem[] {
  const items: EnvCheckItem[] = [];

  items.push(secretItem(env, "SESSION_SECRET", DEV_DEFAULTS.SESSION_SECRET));
  items.push(secretItem(env, "LICENSE_HMAC_PEPPER", DEV_DEFAULTS.LICENSE_HMAC_PEPPER));
  items.push(secretItem(env, "BACKUP_ENCRYPTION_KEY", DEV_DEFAULTS.BACKUP_ENCRYPTION_KEY));
  // SECRETBOX_KEY 没有独立默认值：未设置时会回落到 SESSION_SECRET 派生，
  // 生产要求独立根（轮换周期不同），所以「未设置」在这里算 FAIL 而不是回落。
  items.push(
    env.SECRETBOX_KEY && env.SECRETBOX_KEY.length >= MIN_SECRET_LENGTH && env.SECRETBOX_KEY !== DEV_DEFAULTS.SESSION_SECRET
      ? { name: "SECRETBOX_KEY", status: "PASS", detail: "独立密钥，长度满足要求" }
      : {
          name: "SECRETBOX_KEY",
          status: "FAIL",
          detail: env.SECRETBOX_KEY ? "长度不足或沿用了 SESSION_SECRET 的开发默认值" : "未设置，会回落为由 SESSION_SECRET 派生",
        },
  );

  items.push(
    env.DEPLOYMENT_ENV === "production"
      ? { name: "DEPLOYMENT_ENV", status: "PASS", detail: "=production" }
      : {
          name: "DEPLOYMENT_ENV",
          status: "FAIL",
          detail: `当前=${env.DEPLOYMENT_ENV?.trim() || "(未设置，默认 development)"}，应为 production`,
        },
  );

  items.push(
    env.DEV_MAIL_SINK === "false"
      ? { name: "DEV_MAIL_SINK", status: "PASS", detail: "=false" }
      : {
          name: "DEV_MAIL_SINK",
          status: "FAIL",
          detail: `当前=${env.DEV_MAIL_SINK ?? "(未设置，默认 true)"}，生产必须为 false（否则重置链接会直接回给调用方）`,
        },
  );

  // 归一化：`./.keys`、`.keys/`、`.keys` 视为同一处（与 instrumentation 的判定保持一致）。
  const normalizeDir = (dir: string) => dir.trim().replace(/^\.\//, "").replace(/\/+$/, "");
  const keyDir = env.SIGNING_KEY_DIR ? normalizeDir(env.SIGNING_KEY_DIR) : "";
  items.push(
    keyDir && keyDir !== DEV_DEFAULTS.SIGNING_KEY_DIR
      ? { name: "SIGNING_KEY_DIR", status: "PASS", detail: `=${keyDir}` }
      : {
          name: "SIGNING_KEY_DIR",
          status: "FAIL",
          detail: keyDir ? "仍指向开发共用的 .keys" : "(未设置，回落到 .keys)",
        },
  );

  const baseUrl = env.APP_BASE_URL?.trim();
  items.push(
    baseUrl && /^https:\/\//i.test(baseUrl)
      ? { name: "APP_BASE_URL", status: "PASS", detail: `${baseUrl}（https）` }
      : {
          name: "APP_BASE_URL",
          status: "FAIL",
          detail: baseUrl ? `${baseUrl} 不是 https（会话 Cookie 的 Secure 标记因此不会开启）` : "(未设置，回落到 http://127.0.0.1:3000)",
        },
  );

  items.push(checkDatabaseUrl(env.LICENSE_DB_URL));

  return items;
}

/**
 * 数据库连接串检查。
 *
 * 注意这里**不打印完整 URL**：它带着口令。只解析 host / 是否用了开发口令 / 是否本机内网。
 */
function checkDatabaseUrl(raw: string | undefined): EnvCheckItem {
  const name = "LICENSE_DB_URL";
  if (!raw || raw.trim().length === 0) {
    return { name, status: "FAIL", detail: "未设置，会回落到本机开发库（含开发口令 licensing_dev_pw）" };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { name, status: "FAIL", detail: "不是合法的连接串" };
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    return { name, status: "FAIL", detail: `协议应为 postgresql:，当前是 ${url.protocol}` };
  }
  if (url.password === "licensing_dev_pw") {
    return { name, status: "FAIL", detail: "仍在使用开发默认口令" };
  }

  const host = url.hostname || "(空)";
  if (isLocalOrPrivateHost(host)) {
    return {
      name,
      status: "PASS",
      detail: `host=${host}（本机/内网）。单机 Docker 部署这是正常的；如走公网请确认已开 sslmode=require`,
    };
  }
  return { name, status: "PASS", detail: `host=${host}（非内网地址）` };
}

/** 有任意 FAIL 就该以非零码退出。 */
export function hasFailure(items: readonly EnvCheckItem[]): boolean {
  return items.some((item) => item.status === "FAIL");
}
