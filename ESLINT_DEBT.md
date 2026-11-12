# ESLint 技术债登记（阶段 7）

统计口径：2026-11-13 在仓库根目录执行

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx eslint .
```

结果：**0 errors / 50 warnings**。其中本轮主动降级为 `warn` 的两条 React Compiler 规则共 **44 条**（`react-hooks/set-state-in-effect` 24 条 + `react-hooks/preserve-manual-memoization` 20 条），与下表逐行合计一致。`public/vendor/scalar-standalone.js` 是第三方压缩产物，已加入 `globalIgnores`，不计入统计。

另有 6 条 `react-hooks/exhaustive-deps` 存量 warning（集中在 `src/app/app/settings/backups/page.tsx`），不属于本轮两条降级规则，未在下表登记。

## 处理原则

- 本轮**不批量重写页面**；两条规则先降为 `warn`，error 仍然拦截新增问题。
- 按文件、按批次迁移；每批完成后更新本表，并把该文件对应规则的违规清零。
- 全部文件清零后，在 `eslint.config.mjs` 把两条规则恢复为 `error`，再删除本文件。
- 禁止用 `eslint-disable` 局部掩盖；如确有 React 规则误报，必须在本文件登记理由与复核日期。

## 登记表

| # | 文件 | 规则 | 行号（条数） | 计划批次 |
| --- | --- | --- | --- | --- |
| 1 | `src/app/app/developer/api/page.tsx` | `react-hooks/set-state-in-effect` | 134（1） | B |
| 2 | `src/app/app/developer/credentials/page.tsx` | `react-hooks/preserve-manual-memoization` | 149（5） | B |
| 3 | `src/app/app/developer/webhooks/[id]/page.tsx` | `react-hooks/preserve-manual-memoization` | 151（3） | B |
| 4 | `src/app/app/developer/webhooks/page.tsx` | `react-hooks/preserve-manual-memoization` | 138（4） | B |
| 5 | `src/app/app/features/page.tsx` | `react-hooks/preserve-manual-memoization` | 128（2） | B |
| 6 | `src/app/app/products/[id]/page.tsx` | `react-hooks/set-state-in-effect` | 159（1） | B |
| 7 | `src/app/app/settings/members/page.tsx` | `react-hooks/preserve-manual-memoization` | 114（6） | B |
| 8 | `src/app/app/settings/organization/page.tsx` | `react-hooks/set-state-in-effect` | 78（1） | B |
| 9 | `src/app/app/settings/profile/page.tsx` | `react-hooks/set-state-in-effect` | 86（1） | B |
| 10 | `src/app/app/settings/system/page.tsx` | `react-hooks/set-state-in-effect` | 113（1） | B |
| 11 | `src/components/app/sidebar.tsx` | `react-hooks/set-state-in-effect` | 193（1） | B |
| 12 | `src/components/catalog/customer-dialogs.tsx` | `react-hooks/set-state-in-effect` | 61、179（2） | A |
| 13 | `src/components/catalog/feature-dialogs.tsx` | `react-hooks/set-state-in-effect` | 92（1） | A |
| 14 | `src/components/catalog/plan-dialogs.tsx` | `react-hooks/set-state-in-effect` | 140（1） | A |
| 15 | `src/components/catalog/product-dialogs.tsx` | `react-hooks/set-state-in-effect` | 100、329（2） | A |
| 16 | `src/components/developer/credential-dialogs.tsx` | `react-hooks/set-state-in-effect` | 105、361、473（3） | A |
| 17 | `src/components/developer/webhook-dialogs.tsx` | `react-hooks/set-state-in-effect` | 114、241（2） | A |
| 18 | `src/components/developers/status-panel.tsx` | `react-hooks/set-state-in-effect` | 43（1） | A |
| 19 | `src/components/licensing/license-feature-dialog.tsx` | `react-hooks/set-state-in-effect` | 131（1） | A |
| 20 | `src/components/licensing/license-issue-drawer.tsx` | `react-hooks/set-state-in-effect` | 125（1） | A |
| 21 | `src/components/settings/member-dialogs.tsx` | `react-hooks/set-state-in-effect` | 72、239（2） | A |
| 22 | `src/lib/client/session-context.tsx` | `react-hooks/set-state-in-effect` | 64（1） | C |
| 23 | `src/lib/client/use-resource.ts` | `react-hooks/set-state-in-effect` | 30（1） | C |

**合计：44 条。**

## 批次说明

- **批次 A（对话框/局部组件，低风险）**：把「打开时同步 props 到 state」改为 `key` 重置、派生 state 或事件驱动；每个对话框单独提交，便于回滚。
- **批次 B（页面级）**：优先处理只读展示与筛选页；涉及 URL 查询参数同步的，先补交互测试再改。
- **批次 C（核心 hooks，最后做）**：`session-context` 与 `use-resource` 影响全站，先补 401/刷新/并发请求的回归测试，再迁移到 `useSyncExternalStore` 或请求层缓存。

## 已在本轮修复的两类「渲染期 impure」

| 位置 | 问题 | 修法 |
| --- | --- | --- |
| `src/components/licensing/license-dialogs.tsx`（批量结果下载名） | 渲染期调用 `Date.now()` 生成 CSV 文件名 | 改用结果首条 License ID 前 8 位，渲染确定化 |
| `src/components/licensing/license-dialogs.tsx`（续费提示） | 渲染期用 `Date.now()` 判断是否过期 | 新增 `src/lib/client/use-now.ts`，用 `useSyncExternalStore` 读外部时间快照 |

## 变更记录

| 日期 | 变更 | 剩余两类 warning |
| --- | --- | --- |
| 2026-11-13 | 建立登记；两条规则降为 warn；修复 2 条 purity、6 条 require、1 条 any、27 条 unused-vars | 44 |
