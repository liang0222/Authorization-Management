# docs/shots/ — 页面截图（31 张）

这批截图来自**虚构种子数据**（`prisma/seed.ts`：客户是「示例客户 01–12」与「个人开发者 · 示例甲/乙」，
邮箱用 `*.example`、`*.demo.example` 等 RFC 2606 保留域，电话固定 `138-0000-00NN`），
不含任何真实客户、真实域名或真实口令，可以随仓库公开发布。

| 分组 | 文件 |
| --- | --- |
| 入口 | `login.png`、`install.png`（安装入口已关闭页）、`developers.png`（免登录开发者文档站首页） |
| 概览与授权 | `dashboard.png`、`licenses.png`、`license-detail.png` |
| 业务配置 | `products.png`、`product-detail.png`、`customers.png`、`customer-detail.png`、`plans.png`、`features.png`、`devices.png`、`device-detail.png` |
| 开发者中心 | `developer-api.png`、`developer-credentials.png`、`developer-webhooks.png` |
| 安全与系统 | `signing-keys.png`、`verification-logs.png`、`audit-logs.png`、`settings-members.png`、`settings-organization.png`、`settings-system.png`、`settings-profile.png`、`settings-roles.png` |
| 备份与灾备（v1.5） | `backups.png`（整页）、`backups-top.png`（首屏）、`backups-readonly.png`（只读账号视角：数据可见，写操作按钮全部禁用） |
| 移动端（390×844） | `mobile-dashboard.png`、`mobile-licenses.png`、`mobile-backups.png` |

## 如何自己重新截一遍（推荐：截自己的数据）

```bash
# 1) 起一个隔离库 + 种子数据（不要用生产库）
docker run -d --name shots-pg -e POSTGRES_USER=licensing \
  -e POSTGRES_PASSWORD=licensing_dev_pw -p 55432:5432 postgres:16-alpine
export LICENSE_DB_URL="postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/shots?schema=public"
npx prisma migrate deploy
npx tsx prisma/seed.ts

# 2) 生产构建 + 起服务（端口随便挑一个空闲的）
npm run build
npx next start -p 3196

# 3) Playwright 截图（本仓库自带的脚本思路）
#    - chromium 需要显式 executablePath（Playwright 自带下载目录可能与安装版本不一致）
#    - 详情页靠 page.locator("tbody tr").first().click() 进入
#    - 只读账号视角：用 audit@xinglan.dev 登录再截 /app/settings/backups
#    - 移动端：newContext({ viewport: { width: 390, height: 844 } })
```

登录账号见 `prisma/seed.ts` 末尾输出（种子演示口令，仅用于本地演示，部署时必须改）。
