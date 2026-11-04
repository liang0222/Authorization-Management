# Universal Installer · 文档索引

一套可复用的安装部署基础设施。Core 与项目业务代码解耦，通过 Adapter 接入不同技术栈。

---

## 文档

| 文档 | 内容 | 给谁看 |
| --- | --- | --- |
| [PHASE1-AUDIT.md](./PHASE1-AUDIT.md) | 项目审计：现有能力、缺口清单、不能碰的东西 | 想知道"为什么要做"的人 |
| [PHASE2-ARCHITECTURE.md](./PHASE2-ARCHITECTURE.md) | 四层架构、Installer Contract、状态机、五级判定、安全设计 | 要改安装器的人 |
| [INTEGRATION.md](./INTEGRATION.md) | 接一个新项目：写 Manifest + 实现 9 个方法 | 接其他技术栈的人 |
| [TEST-REPORT.md](./TEST-REPORT.md) | Phase 7 的 16 类场景 + 干净包部署实测 + 7 个缺陷修复记录 | 想验证"真能跑"的人 |
| [DEPLOYMENT.md](./DEPLOYMENT.md) | 数据目录、环境变量、权限、备份、升级、排障 | 要部署的人 |

---

## 代码地图

```
src/lib/installer/
├── contract.ts        类型与 InstallerAdapter 接口
├── manifest.ts        Manifest zod 校验 + 版本兼容 + 秘密扫描
├── state.ts           状态机（7 状态 / 转移表）
├── store.ts           状态持久化 + 五级判定 buildSnapshot
├── lock.ts            安装互斥锁（wx + 心跳 + 陈旧接管）
├── env-probe.ts       环境检测（10 项）
├── database.ts        连接串解析 / 连接测试 / 只读预检 / 错误映射
├── migrations.ts      prisma migrate deploy 封装 + 迁移前备份
├── config-writer.ts   运行配置原子写 + 0600 + 备份
├── orchestrator.ts    14 步流水线 + 失败恢复
├── guard.ts           CSRF / 同源 / 限流
├── runtime.ts         接线层（唯一 import 业务模块的地方）
└── adapters/
    └── licensing-saas/
        ├── manifest.ts
        └── index.ts   ← 本项目 Adapter 参考实现

src/app/install/           安装向导页面（Manifest 驱动）
src/app/api/install/       state / probe / run / log 四个接口
src/components/install/    wizard.tsx + i18n.ts
src/proxy.ts               根路径门禁（未装 → /install）
```

---

## 快速验证

```bash
npx tsc --noEmit
npx vitest run tests/unit          # 22 files / 302 tests
npm run build
curl -s http://127.0.0.1:3100/api/install/state | jq '.data.state'
```

---

## 核心设计一句话

**「宁可判成已安装，也不误判成未安装」**——数据库连不上判 `UNKNOWN` 并锁定入口；锁被删但有库记录判 `tampered` 并重建锁；安装失败时在途状态优先于自适配，保证能继续。
