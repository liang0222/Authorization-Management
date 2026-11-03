# 授权 SaaS 运行镜像（规格 13 / 24：可复现部署）
#
# 设计取舍：
# - 不用 `output: "standalone"`：项目当前由 systemd + `next start` 运行，改构建产物的布局
#   会影响既有部署方式。这里保持与宿主机一致的 `npm ci → prisma generate → next build → next start`。
# - Prisma 7 需要 openssl 与 schema 引擎，运行时保留 node_modules（不裁剪），
#   镜像大一些但和线上已验证的依赖树完全一致。
# - 构建期不注入任何密钥：`prisma generate` 只需要 schema，不需要连库。
#   真正的连接串、SESSION_SECRET、HMAC pepper、备份密钥全部在运行时通过环境变量注入。

FROM node:22-bookworm-slim AS builder

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 先只拷清单，利用层缓存：源码改动不会让 npm ci 重跑。
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN npx prisma generate

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


FROM node:22-bookworm-slim AS runner

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    BACKUP_LOCAL_DIR=/app/.backups

# 运行期需要：构建产物、依赖、Prisma schema 与生成的 client、以及静态资源。
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma7.config.ts ./
COPY --from=builder /app/next.config.ts ./
COPY --from=builder /app/src ./src
COPY --from=builder /app/tsconfig.json ./

# 非 root 运行；签名私钥目录与备份目录通过卷挂载，属主需与 uid 1000 对齐。
RUN groupadd --system --gid 1001 app \
 && useradd --system --uid 1001 --gid app app \
 && mkdir -p /app/.keys /app/.backups \
 && chown -R app:app /app/.keys /app/.backups
USER app

EXPOSE 3000

# 容器内探活走公开状态端点（/api/health 在本项目里不存在）。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/v1/status" >/dev/null || exit 1

CMD ["npm", "run", "start", "--", "-p", "3000", "-H", "0.0.0.0"]
