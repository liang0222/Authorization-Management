import { parse as parseYaml } from "yaml";
import { config } from "@/lib/config";

/**
 * 公开 API 的对外基址（开发者文档站里写给集成方的那两个地址）。
 *
 * 历史问题：文档站里写的是 `https://<LICENSE_API_DOMAIN>/api/v1` 这种占位符。
 * 对内部人来说这是「待填」，对拿到文档的集成方来说这就是**没写完**——
 * 他只能回来问「到底填什么」。所以这里改成从运行实例的配置读真实地址。
 *
 * 两条设计约束：
 * 1. **不猜默认域名**。没配置就显式渲染「未配置」，绝不编一个看起来像真的地址；
 *    编错的域名会让人对着一个不存在的主机调试，比明说未配置难排查得多。
 * 2. **必须请求时读**。这些页面原本是构建期预渲染的，构建环境里没有生产 env
 *    （systemd 的 EnvironmentFile 只在运行时注入），预渲染会把 null 烤进 HTML。
 *    因此调用方要先 `await connection()` 再读，页面才会反映当前实例的真实配置。
 */

export interface PublicBaseUrls {
  production: string | null;
  sandbox: string | null;
}

export const PUBLIC_API_ENV = "PUBLIC_API_BASE_URL";
export const PUBLIC_SANDBOX_ENV = "PUBLIC_SANDBOX_API_BASE_URL";

export function readPublicBaseUrls(): PublicBaseUrls {
  return {
    production: config.publicApiBaseUrl,
    sandbox: config.sandboxApiBaseUrl,
  };
}

/**
 * 把基址渲染成一行可直接粘贴的文本。
 *
 * `missing` 的措辞刻意带上环境变量名：运维看到「未配置」能立刻知道该设哪个变量，
 * 而不是去翻代码。
 */
export function displayBaseUrl(url: string | null, envName: string): string {
  return url ?? `（未配置：设置环境变量 ${envName}）`;
}

/** 从基址里取出 host，用于 HTTP 报文示例里的 `Host:` 头。 */
export function hostOf(url: string | null, envName: string): string {
  if (!url) return `（未配置 ${envName}）`;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** 从基址里取出 scheme://host，用于 `host_permissions` 这类只需要 origin 的位置。 */
export function originOf(url: string | null, envName: string): string {
  if (!url) return `（未配置 ${envName}）`;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}

interface OpenApiServer {
  url?: string;
  description?: string;
  variables?: Record<string, { default?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

interface OpenApiWithServers {
  servers?: OpenApiServer[];
  [key: string]: unknown;
}

/**
 * 纯函数：把 OpenAPI 的 `servers` 里的域名默认值换成运行实例的真实域名。
 *
 * 契约文件本身保持「模板」形态（`https://{domain}/api/v1` + 变量），
 * 这样同一个包部署到任何域名都不用改文件；下载到的却是本实例可用的地址。
 */
export function applyServerDomains<T extends OpenApiWithServers>(spec: T, urls: PublicBaseUrls): T {
  if (!Array.isArray(spec.servers) || spec.servers.length === 0) return spec;

  const pick = (server: OpenApiServer): string | null => {
    const description = String(server.description ?? "");
    if (/sandbox/i.test(description)) return urls.sandbox;
    if (/production|生产/i.test(description)) return urls.production;
    return null;
  };

  const servers = spec.servers.map((server) => {
    const domain = pick(server);
    if (!domain) return server;
    let host: string;
    try {
      host = new URL(domain).host;
    } catch {
      return server;
    }
    return {
      ...server,
      variables: {
        ...(server.variables ?? {}),
        domain: { ...(server.variables?.domain ?? {}), default: host },
      },
    };
  });

  return { ...spec, servers };
}

/**
 * 纯函数：把 YAML 文本里 `servers[].variables.domain.default` 换成真实域名。
 *
 * 为什么不「解析 → 改 → 重新 dump」：那样会把契约文件里的注释、缩进风格、
 * 锚点全部冲掉。集成方下载的是这份 YAML，注释本身是文档的一部分。
 * 所以这里只做定点文本替换：用解析出来的模板默认值当搜索锚点，
 * 每处必须**恰好出现一次**才替换，出现零次或多次就原样返回并让调用方知道。
 */
export function rewriteServerDomainsInYaml(raw: string, urls: PublicBaseUrls): { text: string; replaced: number } {
  let spec: OpenApiWithServers;
  try {
    spec = parseYaml(raw) as OpenApiWithServers;
  } catch {
    return { text: raw, replaced: 0 };
  }
  const patched = applyServerDomains(spec, urls);
  const before = spec.servers ?? [];
  const after = patched.servers ?? [];

  let text = raw;
  let replaced = 0;
  for (let index = 0; index < before.length; index += 1) {
    const oldHost = before[index]?.variables?.domain?.default;
    const newHost = after[index]?.variables?.domain?.default;
    if (!oldHost || !newHost || oldHost === newHost) continue;
    const needle = `default: ${oldHost}`;
    const occurrences = text.split(needle).length - 1;
    if (occurrences !== 1) continue;
    text = text.replace(needle, `default: ${newHost}`);
    replaced += 1;
  }
  return { text, replaced };
}
