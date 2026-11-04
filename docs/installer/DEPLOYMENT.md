# 部署 · Universal Installer

> 本文只讲**安装器本身**怎么部署。整个 SaaS 的部署看 [../DEPLOY-v15.md](../DEPLOY-v15.md)。

---

## 1. 数据目录（必须持久化）

安装状态存在 `$INSTALLER_DATA_DIR`，默认 `/var/lib/universal-installer`。

```bash
sudo mkdir -p /var/lib/universal-installer
sudo chmod 700 /var/lib/universal-installer
sudo chown -R <运行用户>:<运行用户> /var/lib/universal-installer
```

**必须在容器外或挂载卷上。** 否则 Docker 容器重建会丢状态，安装器会重新进入首次安装（违反验收标准 G）。

systemd 里显式声明：

```ini
Environment=INSTALLER_DATA_DIR=/var/lib/universal-installer
```

Docker Compose：

```yaml
services:
  app:
    volumes:
      - installer-data:/var/lib/universal-installer
volumes:
  installer-data:
```

---

## 2. 环境变量

| 变量 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `INSTALLER_DATA_DIR` | 否 | `/var/lib/universal-installer` | 安装状态根目录 |
| `INSTALLER_ENV_FILE` | 否 | `/etc/licensing-saas/production.env` | 安装器写运行配置的目标 |
| `INSTALLER_CSRF_SECRET` | 否 | 回退 `SESSION_SECRET`，再回退 `csrf.key` 文件 | CSRF 签名密钥 |
| `DISABLE_WEBHOOK_WORKER` | 否 | — | 设 `true` 关掉 webhook 投递器 |
| `DISABLE_BACKUP_SCHEDULER` | 否 | — | 设 `true` 关掉备份调度器 |

### 后台任务的启动时机

webhook 投递器与备份调度器**只在装完之后才启动**：`src/lib/background.ts` 的 `backgroundWorkersAllowed()` 查安装锁文件（纯 fs，不连库）。

- 未装：启动日志打印 `[boot] 尚未安装，跳过后台任务（安装完成后自动启动）`，不起循环
- 装完：`/api/install/run` 的成功分支调 `startBackgroundWorkers()` 补起，**不用重启服务**

理由：全新实例在用户提交表单前数据库里一张表都没有，循环一跑就每 5 秒刷 `TableDoesNotExist`，真出问题时反而看不见。

---

## 3. 权限要求

安装器要写两处：

1. `$INSTALLER_DATA_DIR/<project-id>/`（目录 0700、文件 0600）
2. `INSTALLER_ENV_FILE` 的父目录（通常 `/etc/licensing-saas/`）

```bash
sudo mkdir -p /etc/licensing-saas
sudo chown <运行用户>:<运行用户> /etc/licensing-saas
sudo chmod 750 /etc/licensing-saas
```

**不要**把 `/etc/licensing-saas` 设成 777——里面有会话密钥。

---

## 4. 首次安装流程

1. 部署代码 + `npm ci` + `npx prisma generate` + `npm run build`
2. 起服务（此时**不要**跑 `prisma migrate deploy`，让安装器做）
3. 浏览器打开站点根路径 → 自动跳 `/install`
4. 填管理员 → 填数据库 → 填系统配置 → 开始安装
5. 完成后自动跳 `/login`

**如果库已经手工初始化过**（跑过 `migrate deploy` + `seed`），安装器会自适配：
判 `INSTALLED` / `source=adopted`，写一把 `adopted:true` 的锁，`/` 仍然跳 `/app/dashboard`。**不会重装。**

---

## 5. 安装完成后

```bash
# 确认状态
curl -s http://127.0.0.1:3100/api/install/state | jq '.data.state'   # "INSTALLED"

# 确认入口已关
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://127.0.0.1:3100/
# 307 http://127.0.0.1:3100/app/dashboard
```

此时 4 个 `/api/install/*` 接口全部返回 `409 INSTALL_LOCKED`（`GET /api/install/state` 除外，它只读）。

---

## 6. 备份要包含什么

| 路径 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| 数据库 | 全部业务数据 | 灾难 |
| `$INSTALLER_DATA_DIR/<project-id>/installed.lock` | 已安装凭据 | 锁没了但库里有 `installer_records` → 仍判已装（`tampered=true`），不会重装 |
| `$INSTALLER_DATA_DIR/<project-id>/state.json` | 当前状态 | 可重建 |
| `.keys-prod/*.pem` | 签名私钥 | **签发会失败**，必须从备份恢复或用 `scripts/repair-signing-keys.mts` 重生成 |
| `/etc/licensing-saas/*.env` | 运行配置 | 密钥全丢，会话与加密数据不可解 |

**只备份数据库是不够的**——私钥与 env 文件同样关键。已有 `scripts/offsite-key-backup.sh` 负责私钥异地归档。

---

## 7. 升级

```bash
git pull            # 或解包新版本
npm ci
npx prisma generate
npm run build
sudo systemctl restart licensing-saas
```

**不要**因为升级就删 `installed.lock`。升级不是重装；迁移由 `prisma migrate deploy` 处理（安装器已装状态下不会再跑，需手工执行）。

---

## 8. 多实例注意

- 限流是**进程内 Map**，多实例各自计数
- `install.lock` 是**单机文件锁**，跨机器不互斥
- 多实例部署时，安装阶段只应让**一个实例**对外提供服务，装完再全部拉起

---

## 9. 排障

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `/` 跳 `/install`，但库里有数据 | 锁文件丢了 + 库连不上 | 检查 `LICENSE_DB_URL`；库连不上会判 `UNKNOWN` 并锁定 |
| `state=UNKNOWN` | 数据库不可达 | 修连接；`UNKNOWN` 状态下安装入口是锁死的，不会误装 |
| `INSTALL_BUSY` | 有别的安装进程在跑 | 等 90s 心跳超时，或确认进程已死后删 `install.lock` |
| `config failed: EACCES` | 没权限写 env 文件父目录 | `chown` 目录给运行用户 |
| `migrate failed: SQLSTATE 42501` | 权限不足 | schema 级 `CREATE` + 数据库级 `CREATE`（后者是给 `CREATE EXTENSION` 用的） |
| `migrate failed: P3009` | 库里有失败的历史迁移 | `npx prisma migrate resolve --rolled-back <迁移名>` 后重试 |

---

## 10. 关掉安装器（装完之后）

理论上不需要——装完入口自动关闭。若确实要彻底移除：

1. 删 `src/app/install/`、`src/app/api/install/`、`src/components/install/`
2. 删 `src/proxy.ts`，把 `src/app/page.tsx` 改回 `redirect("/app/dashboard")`
3. 保留 `$INSTALLER_DATA_DIR`（删了不影响运行，只影响状态判定）
