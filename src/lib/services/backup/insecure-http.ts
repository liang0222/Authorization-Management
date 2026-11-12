/**
 * 备份目标的「明文 http」判定（阶段 4 · 双重确认护栏）。
 *
 * 背景（这是真实发生过的问题，不是假想）：
 * 早先 `factory.ts` 里 `allowInsecureHttp = DEPLOYMENT_ENV !== "production" || row.tls_verify === false`，
 * 意思是**生产环境只要把目标上的 tls_verify 设成 false，任何 http 端点都会被放行**。
 * `tls_verify` 本来只是「要不要校验证书」的开关，被当成了「我同意明文过网」的授权书；
 * 结果一个 `http://<公网主机>:5244/dav` 的 WebDAV 目标在生产里长期存在，
 * Basic Auth 的用户名口令每次备份都明文过网（备份体是 AES 信封，内容没泄露，凭据会泄露）。
 *
 * 现在改成两个条件同时满足才放行，缺一个都不行：
 *   1. 目标上显式 `tls_verify = false`（配置层面的确认）；
 *   2. 环境变量 `ALLOW_INSECURE_BACKUP_HTTP=true`（部署层面的确认，字符串必须精确等于 "true"）。
 *
 * 不适用范围（保持原行为）：
 * - https 端点；
 * - 回环地址（localhost / 127.0.0.0/8 / ::1 / 0.0.0.0）—— 本机进程内的明文不出网卡；
 * - 非生产环境（development / sandbox）。
 *
 * 这个模块只做判定，不读数据库、不建连接，方便单测覆盖正反例。
 */

export const ALLOW_INSECURE_BACKUP_HTTP = "ALLOW_INSECURE_BACKUP_HTTP";

/** 判定所需的最小输入。`deploymentEnv` 来自 `config.deploymentEnv`。 */
export interface InsecureHttpInput {
  deploymentEnv: string;
  endpointUrl: string | null | undefined;
  tlsVerify: boolean;
  /**
   * `process.env.ALLOW_INSECURE_BACKUP_HTTP` 的原始值。
   * 只认精确的 `"true"`：`"1"`、`"TRUE"`、`"yes"` 一律不算确认（避免「看起来配了其实没配」）。
   */
  allowEnvValue?: string | null;
}

export interface InsecureHttpDecision {
  /** 端点是不是 http。 */
  isHttp: boolean;
  /** http 且主机不是回环 —— 也就是「这条链路真的会把凭据明文发到网卡外面」。 */
  plaintext: boolean;
  /** http 且主机是回环（不受限）。 */
  loopback: boolean;
  /** 解析出的主机名；端点缺失/非法时为 null。 */
  host: string | null;
  /** 目标上显式 tls_verify=false。 */
  targetConfirmed: boolean;
  /** 环境变量显式等于 "true"。 */
  envConfirmed: boolean;
  /** 双重确认都满足、且确实在放行一条明文链路 —— 保存时要落审计。 */
  needsAudit: boolean;
  /** 当前条件下是否允许保存/执行。 */
  allowed: boolean;
  /** 不允许时给操作者看的原因（直接进 400 文案与作业 error_message）。 */
  reason: string | null;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

/** 域名形式的回环：`localhost`、`*.localhost`。 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost")) return true;
  // 整个 127.0.0.0/8 都是回环，`127.0.0.53` 这类也得认。
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

/** 从 endpoint 里取协议与主机；解析失败返回 null（调用方按「不是 http」处理）。 */
export function parseEndpoint(endpointUrl: string | null | undefined): { protocol: string; hostname: string } | null {
  if (!endpointUrl) return null;
  try {
    const url = new URL(endpointUrl);
    return { protocol: url.protocol.replace(":", "").toLowerCase(), hostname: url.hostname };
  } catch {
    return null;
  }
}

function decide(input: InsecureHttpInput): InsecureHttpDecision {
  const parsed = parseEndpoint(input.endpointUrl);
  const targetConfirmed = input.tlsVerify === false;
  const envConfirmed = input.allowEnvValue === "true";
  const production = input.deploymentEnv === "production";

  const base: InsecureHttpDecision = {
    isHttp: false,
    plaintext: false,
    loopback: false,
    host: parsed?.hostname ?? null,
    targetConfirmed,
    envConfirmed,
    needsAudit: false,
    allowed: true,
    reason: null,
  };

  if (!parsed || parsed.protocol !== "http") return base;

  const loopback = isLoopbackHostname(parsed.hostname);
  if (loopback) return { ...base, isHttp: true, loopback: true };

  // 下面是「http + 非回环」：明文链路。
  const plaintext = true;

  if (!production) {
    // 开发/沙箱保持原行为，只是把事实标出来（前端仍可显示徽章）。
    return { ...base, isHttp: true, plaintext };
  }

  const missing: string[] = [];
  if (!targetConfirmed) missing.push("目标上显式 tls_verify=false");
  if (!envConfirmed) missing.push(`环境变量 ${ALLOW_INSECURE_BACKUP_HTTP}=true`);

  if (missing.length > 0) {
    return {
      ...base,
      isHttp: true,
      plaintext,
      allowed: false,
      reason:
        `拒绝使用明文 http 备份目标：${parsed.hostname} 不是回环地址，` +
        `生产环境需要双重确认，当前缺少 ${missing.join(" 与 ")}。` +
        `备份凭据会以明文过网；请改用 https（推荐），或同时补齐上面两项确认。`,
    };
  }

  return { ...base, isHttp: true, plaintext, needsAudit: true, allowed: true };
}

/**
 * 判定一个备份目标能否使用。
 *
 * `allowEnvValue` 不传时自动读当前进程环境（运行期调用点用默认值即可；
 * 单测与「换一套 env 预演」的场景显式传参）。
 */
export function evaluateInsecureHttpTarget(input: InsecureHttpInput): InsecureHttpDecision {
  const allowEnvValue = input.allowEnvValue === undefined ? process.env[ALLOW_INSECURE_BACKUP_HTTP] : input.allowEnvValue;
  return decide({ ...input, allowEnvValue });
}
