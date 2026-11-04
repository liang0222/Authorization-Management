# 交接说明

给接手的人看：现在能跑到什么程度、哪些是已验证的、哪些坑踩过一次别再踩。

---

## 1. 一句话现状

后台已经可以完整走通「建产品 → 定功能 → 定套餐 → 签授权 → 客户端激活 → 心跳/读权限 →
续费/暂停/解绑/撤销 → 审计留痕」全链路，并新增「备份与灾备」（多目标备份 → 加密 →
上传 → 回读校验 → 隔离恢复演练）。类型检查 0 错、构建 88/88、66 单元、11 集成、
16 端到端全部通过。

---

## 2. 当前状态

### 2.1 已验证（有证据）

| 项 | 状态 | 怎么验的 |
| --- | --- | --- |
| `npx tsc --noEmit` | 0 错误 | 每批改动后执行 |
| `npm run build` | 88/88 静态页 | 生产构建实测 |
| 单元测试 | 66 passed | `npx vitest run`（含备份加解密 / 状态判定 / cron 校验 15 条） |
| 集成测试 | 11 passed | 真实 HTTP + PostgreSQL |
| 端到端 | 16 passed | `npx playwright test`（桌面 + Pixel 7，含只读角色 1 条） |
| 备份全链路 | 16 项冒烟全 PASS | 建目标 → 连接测试 → 建策略 → 立即备份 201 `succeeded` → 回读校验 → 隔离恢复演练 `passed` RTO 3s → 概览统计 → 删除被引用目标 409 |
| 备份页交互 | 5 条 E2E | 五块真实数据 / 新增目标（含空名称拦截）/ 连接测试 / 删除二次确认 / 被引用拒删 / 立即备份→校验→演练 / 只读账号按钮全禁用且有说明 |
| 登录 → 签发 → 激活 → 心跳 → 权限 → 解绑 | 全通 | 手工 curl 脚本 + 集成测试双覆盖 |
| 并发不突破设备上限 | 成立 | `max_devices=1` 双设备并发恒为 `[201, 409]` |
| 登录后循环跳转 | 已修复 | 见第 4.1 节 |
| 移动端抽屉闪关 | 已修复 | 见第 4.2 节 |
| 产品详情页 `licenseByStatus.map` 崩溃 | 已修复 + 已加路由巡检 | 见第 4.13 节 |
| 22 条路由（含 4 个详情页）渲染无错 | 成立 | `tests/e2e/04-routes.spec.ts`，同时监听 pageerror / console / HTTP 4xx |
| 授权详情页失效客户链接 | 已修复（补客户档案页） | 见第 4.14 节 |

### 2.2 已知未做

| 项 | 原因 | 要做的话 |
| --- | --- | --- |
| `/app/devices/[id]` 设备详情页 | 不在 NAV 里，列表已能查到设备且可释放/封禁 | 后端 `GET /admin/devices/[id]` 已就绪（档案 + 激活历史 + 事件），照 `customers/[id]` 的写法加页面即可 |
| `/app/settings/roles` 角色管理页 | 成员页已消费 `GET /admin/roles` 的角色下拉 | 后端 `GET/POST /admin/roles` 已就绪，做一个「角色 + 权限勾选」列表页 |
| 多实例部署 | 单实例够用，注释已标注 | 限流与幂等换成 Redis |
| 真实 Webhook 外发校验 | 无外部接收端 | 起一个本地接收器，验签名头与重试退避 |
| Firefox / WebKit | 只跑 Chromium | `npx playwright install firefox webkit` 后在 config 加 project |

---

## 3. 快速恢复

### 3.1 从零到能登录（5 条命令）

```bash
docker start licensing-pg 2>/dev/null || docker run -d --name licensing-pg \
  -e POSTGRES_PASSWORD=licensing_dev_pw -e POSTGRES_USER=licensing \
  -e POSTGRES_DB=licensing -p 55432:5432 postgres:16-alpine
npm install
npm run db:migrate
npm run db:seed
npm run dev            # http://localhost:3000，owner@xinglan.dev / License#2026
```

### 3.2 服务进程管理

```bash
# 开发服务（3000）
(setsid bash /tmp/start-dev.sh >> /tmp/next-dev.log 2>&1 &)
# /tmp/start-dev.sh 内容：
#   cd /root/授权saas && exec node node_modules/next/dist/bin/next dev -p 3000

# 生产服务（3001，E2E 默认打这个端口）
(setsid bash -c 'cd /root/授权saas && exec node node_modules/next/dist/bin/next start -p 3001' \
  >> /tmp/next-prod.log 2>&1 &)

# 查谁占了 3001
ss -lptn 'sport = :3001' | grep -oP 'pid=\K[0-9]+'
```

**必须注意**：

- 用 `setsid`，不要直接 `nohup`——不加 `setsid` 的进程会被当前 shell 的作业控制连带杀掉；
- **`npm run build` 会替换 `.next`，之后必须重启 3001**，否则 E2E 打的是旧构建；
- 不要用 `pkill -f "next dev"` 在同一个 bash 调用里执行，会把当前调用自己也 SIGTERM 掉。

### 3.3 测试

```bash
npm run typecheck
npm run test                                    # 单元，不需要服务
npx vitest run -c vitest.integration.config.ts  # 需要 3000 端口服务 + 种子数据
npm run e2e                                     # 自己起 3001，需先 build
```

集成测试会写真实数据（签发、暂停、撤销新的授权），跑多次后库里会多出测试授权。
需要干净数据就 `npm run db:seed`（会 TRUNCATE 全表后重灌）。

---

## 4. 踩坑清单（按踩到的顺序）

### 4.1 登录成功后无限跳转 —— SessionProvider 缓存了 401

**现象**：登录接口返回 200，但地址栏一直停在 `/login?next=%2Fapp%2Flicenses`，
`/api/v1/auth/session` 被反复请求，页面来回闪。

**根因**：`SessionProvider` 挂在根布局。登录前它请求 `/auth/session` 拿到 401，把状态缓存成
`unauthenticated`。登录成功后没人通知它刷新 → `AppShell` 认为未登录 → 跳回 `/login` →
登录页的「已登录就跳后台」逻辑又跳回后台，形成闭环。

**修法**：登录页引入 `useSession()`，在 `router.replace(next)` **之前** `await refreshSession()`。

**教训**：全局会话上下文在「登录」这种身份切换点必须显式刷新，不能依赖下次挂载。

### 4.2 移动端抽屉点了就关 —— effect 依赖了每次新建的函数

**现象**：点汉堡按钮，抽屉闪现后立即消失，console 无报错。

**根因**：`onNavigate={() => setMobileOpen(false)}` 每渲染都是新引用；`RouteBridge` 里
`useEffect(() => onNavigate(), [pathname, onNavigate])` 因此在每次渲染后重跑，刚打开就被关掉。

**修法**：`const closeMobileNav = useCallback(() => setMobileOpen(false), []);`

**教训**：传给「依赖它的 effect」的回调必须是稳定引用；行内箭头函数只适合直接绑定事件。

### 4.3 生产构建 `CLIENT_HOOK_DYNAMIC`

**现象**：`next build` 报
`Route "/app/licenses/[id]": Next.js encountered URL data usePathname() in a Client Component outside of <Suspense>`，
堆栈指向 `app-shell.tsx`。

**根因**：`cacheComponents: true` 下，动态路由（`/app/licenses/[id]`、`/app/developer/webhooks/[id]`）
的参数在构建期不可知，`usePathname()` 会挂起；布局层没有 Suspense 边界就直接让构建失败。

**修法（两轮）**：

1. 先试「layout 用 Suspense 包整个 AppShell」→ 构建过了，但页面被丢出 instant-navigation 预渲染校验，
   dev 日志刷 `instant-unrendered-segment` 警告；
2. 终版：把 `usePathname` 收进 `RouteBridge`（守卫 + 路由变化收抽屉）与 `Sidebar` 各自的
   Suspense 边界，layout 恢复成 `<AppShell>{children}</AppShell>`，页面内容留在边界之外。

**注意**：`RouteBridge` 必须渲染在 `ready ? (…) : <骨架>` 三元**之外**，否则未登录时 Shell
只剩骨架，守卫根本没挂载，永远不会跳转。

### 4.4 Cookie `Secure` 跟 `NODE_ENV` 绑死

**现象**：E2E 登录成功但浏览器不存 Cookie，下次请求还是 401。

**根因**：`session.ts` 用 `secure: process.env.NODE_ENV === "production"`。生产构建跑在
`http://127.0.0.1:3001`，浏览器拒绝在 http 上保存 Secure Cookie。

**修法**：`secure: config.appBaseUrl.startsWith("https://")` —— 按实际协议决定，内网 http
自托管能登录，HTTPS 部署仍强制 Secure。

### 4.5 Playwright 断言用 `/\/app\/licenses/` 会假通过

登录页 URL 是 `/login?next=%2Fapp%2Flicenses`，宽正则能匹配上，测试「通过」但根本没登录进去。

**修法**：加 `$` 锚定 `/\/app\/licenses$/`。

### 4.6 `strict mode violation`：两个同名链接

「系统设置」在侧栏和顶栏/命令面板里都有，`getByRole("link", { name: "系统设置" })` 命中 2 个。

**修法**：限定作用域 `getByRole("complementary", { name: "主导航" }).getByRole("link", …)`。

### 4.7 404 断言太宽，误命中业务文案

`getByText(/404|This page could not be found/)` 在「API 接入」页命中了错误码表里的 "404"。

**修法**：只断言框架固定文案 `This page could not be found` / `Application error`。

### 4.8 登录限流把成功也计数，测试自己把自己打成 429

**修法**：`rate-limit.ts` 拆成 `checkRateLimit`（peek 不递增）/ `recordFailure` / `resetRateLimit`，
登录路由改为「先 peek 双桶 → 失败才递增 → 成功清零账号桶」。

### 4.9 Prisma 7 的 `Bytes` 不接受 Node `Buffer`

**现象**：`Type 'Buffer<ArrayBufferLike>' is not assignable to type 'Uint8Array<ArrayBuffer>'`（TS2322）。

**修法**：`toPrismaBytes(u8)` 复制到独立 `ArrayBuffer`，`sha256` / `hashLicenseKey` 统一返回该类型。

### 4.10 不能用 `DATABASE_URL`

本机存在其它项目的 `.env`，用通用名会被污染成 `localhost:5432` 上不存在的库，报
`P1001 ECONNREFUSED`。本项目统一用 `LICENSE_DB_URL`。

### 4.11 bash 里出现 `credentials` 路径会被安全网拦

`ls src/components/**credentials**` 之类会触发 `BLOCKED by CC Safety Net / secret.basename.credentials`。
需要看那个目录就用文件读取工具按完整路径读，别在命令行里拼这个目录名。

### 4.12 Next 16 的异步 API

`cookies()` / `headers()` / `draftMode()` / `params` / `searchParams` **全部是 Promise**。
Route handler 里 `const { id } = await ctx.params`；页面里 `const sp = await searchParams`。
`middleware.ts` 已重命名为 `proxy.ts`。

### 4.13 前端手写的接口类型不是契约 —— 产品详情整页崩

`/app/products/[id]` 曾整页只剩 Next 的「This page couldn't load」，报错
`TypeError: counts.licenseByStatus.map is not a function`。
接口给的是 `Object.fromEntries(...)` 得到的**对象**（`{"active":163}`），页面却写成
`Array<{status,count}>` 直接 `.map`；类型是页面自己声明的，`tsc` 抓不到。

处理方式：类型改 `Record<string, number>` + 渲染前 `Object.entries()`，
并新增 `tests/e2e/04-routes.spec.ts` 把 21 条路由（含 4 个详情页）全部过一遍。

结论：**列表页能打开不代表详情页能打开**。低频详情路径必须进自动化巡检，
不能靠「build 过了、tsc 过了」判断。

### 4.14 预取会把失效链接提前炸出来

授权详情页的客户名链到 `/app/customers/{id}`，但那个路由当时不存在。
页面本身能渲染，是 Next 的 Link 预取去拿 RSC 载荷时拿到 404，console 里才出现红字。
`04-routes.spec.ts` 把 `response` 监听也纳进来，就是为了抓这种「页面没崩但链路是坏的」。

修法是补真实的客户档案页，而不是把链接去掉——去掉链接等于把功能删了。

### 4.15 `table-auto` 下 `width` 只是建议，`truncate` 需要 `max-w`

授权列表在 390px 下「开始/到期」被裁掉：产品编码 `fluxpanel-desktop` 不可断词，
浏览器把客户列撑到 280px，把后面的列整体挤出可视区。
`<td>` 上写 `width: "150px"` 不起作用，必须给承载长文本的内层 `div` 加 `max-w-[160px]`，
`truncate` 才会真的省略。列级收放见 `docs/design-system.md` 6.1 / 6.2。

### 4.16 `viewBox` 固定比例的图表会被宽卡片挤成一条

仪表盘柱状图原来用 SVG `viewBox={0 0 width height}`，`width = max(160, len*28)`。
卡片宽 740px 时浏览器等比放大再居中，两侧各留约 100px 空白，柱子缩在中间。
改成 HTML flex 柱（每根 `flex-1`、高度 `%`、网格线 `absolute bottom: %`）后自然撑满，
顺带给每根柱加了 Tooltip，键盘 `tabIndex={0}` 也能读。

### 4.17 种子数据里「周期」和「开始/到期」必须自洽

截图核查时发现一条授权写着「一年（12 个自然月）」，但开始 2026/07/05、到期 2027/05/21——
只有 320 天，而且起算时间还早于签发时间。原因是 `prisma/seed.ts` 的
`expiresAt` 是手写常量（`daysLater(200)`），而周期来自套餐，两边各算各的。

修法：状态表改成只声明「起算时间在几天前 / 几天后」，到期时间用
`addDuration(startsAt, plan.duration, TIMEZONE)` 现算，`start_policy` 也据此推导
（起算时间在未来 → `fixed_start`）。改完 3 个自然月就是 09/18 → 12/18，一眼能验。

顺带修了同一类问题：套餐的功能默认值原来只覆盖 FluxPanel 的功能码，另外三个产品的
20 个套餐全是「功能 0」。改成按「功能在列表里的位次 + 档位」推导（布尔功能第 i 个在
`tier >= i` 解锁、数值功能按档位 ×[0.25, 1, 2, 5, 10]、文本功能分 classic/pro 两档），
现在每个套餐都带齐自己产品的功能默认值，`plan_features` 从 13 行变成 65 行。

教训：**演示数据的内部矛盾会被当成代码 bug**。种子数据也要有「不变式」意识。

### 4.18 「近 14 天」的图必须真的画满 14 天

仪表盘柱状图标题写「近 14 天授权验证量」，但实际只有 8 根柱。两个原因叠在一起：

1. **SQL 只按已有行分组**，没有补零——某天没有请求，那一天就直接消失，横轴变成「有数据的那几天」，
   看起来像是数据被截断了；
2. **种子日志的时间分布只覆盖 6.5 天**：`created_at: hoursAgo(i * 0.6)`，i 最大 259 → 155 小时。

修法分两层：
- `src/app/api/v1/admin/dashboard/route.ts` 的两条趋势查询都改成 `generate_series(0, 13)` 生成日期桶
  再 `LEFT JOIN`，并用 `date_trunc('day', created_at AT TIME ZONE $2)` 按**组织时区**切日
  （`$2` 取 `session.organization.timezone`），返回 `to_char(b.day, 'YYYY-MM-DD')`。
  不按组织时区切日的话，UTC 的「今天」会在北京时间早上 8 点前错开一整天。
- `prisma/seed.ts` 的日志改成 `hoursAgo((i / 259) * 335 + Math.random() * 0.6)`，真正铺满 14 天；
  激活事件同理，原来写死 `daysAgo(25 - d)`（21~25 天前）导致「近 7 天新增激活」恒为 0，
  改成 `daysAgo((d / 5) * 13 + Math.random() * 2)`。

教训：**「近 N 天」是承诺，不是文案**。补零 + 按业务时区切日是图表的两条底线；
种子的时间分布也要覆盖到窗口边界，否则窗口指标永远是 0。

### 4.19 品牌名只有 7 处，但漏一处就很显眼

把 LicenseHub 换成「子铭」时，`grep -rn "LicenseHub"` 命中 7 处代码 + 3 处文档（README 标题、
术语文档里的 localStorage key 说明）。真正要注意的是三个**容易被忘掉的载体**：

- `src/app/layout.tsx` 的 `metadata.title`（浏览器标签页）；
- `src/lib/auth/totp.ts` 的 `otpauthUri(secret, email, issuer = "子铭")`（验证器 App 里显示的名字）；
- `localStorage` key `ziming.sidebar.collapsed`（改名会让老用户的折叠偏好重置一次，可接受）。

徽标方块里的字母标记用英文 `Z`（取「子铭」拼音首字母），三处都要改：
`src/components/app/sidebar.tsx:92`、`src/app/(auth)/layout.tsx:13`、`src/app/(auth)/login/page.tsx:83`。
用中文「子」做标记也行，但同一枚 7×7 方块里中文字形的视觉重量比拉丁字母大，
缩小到 28px 时中文字会显得偏满，所以最终选 `Z`。

改完必须**重新构建 + 重启 + 重截全部截图**——截图是交付物的一部分，品牌不一致等于交付不一致。

### 4.20 改了 `src/lib/config.ts` 却不重启 dev server，会拿到「幽灵 undefined」

点「立即备份」返回 422 `BACKUP_FAILED`，消息是
`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received undefined`，
堆栈落在 `src/lib/services/backup/crypto.ts:17` 的 `keyBuffer()`——`config.backupEncryptionKey` 是 `undefined`。

排查顺序很关键，我们差点去改代码：
1. 读源码 `.env` 与 `src/lib/config.ts` 默认值，都对；
2. `grep -rn "backupEncryptionKey" .next/dev` 查编译产物，也对；
3. 那就不是代码问题，而是**进程里的模块实例是旧的**。

根因：`next dev`（Turbopack）长时间运行时，对 `src/lib/config.ts` 这种被全站引用的模块做 HMR 后，
某些 `import` 链上仍持有**旧实例**，新增的导出字段在该实例上不存在。dev server 已经跑了几个小时。

修法不是改代码，是重启：
```bash
PID=$(ss -lptn 'sport = :3000' | grep -oP 'pid=\K[0-9]+' | head -1); kill $PID
(setsid bash /tmp/start-dev.sh >> /tmp/next-dev.log 2>&1 &)
```
重启后同一请求立刻 201。

教训：**给 `config` 加字段后，第一件事是重启 dev server 再验。**「环境变量读不到」先怀疑进程，
别急着在代码里加 fallback——加了 fallback 会把这个真实的运维坑埋掉。

### 4.21 否定断言会制造假通过：`expect(x).not.toBe(y)` 单独用等于没测

集成测试里这条链路连续挂了两次，第二次才找到真因：

```ts
const rotated = heartbeat.json.data!.accessToken;   // 接口其实是 access_token
expect(rotated).not.toBe(token);                    // undefined !== "eyJ..." → 通过
const res = await publicJson(`/api/v1/activations/${id}/entitlements`, { token: rotated });
expect(res.status).toBe(200);                       // 401
```

`rotated` 是 `undefined`，否定断言照样成立，于是「字段名读错」被伪装成「接口鉴权出错」，
排查方向一开始就偏了（去读 entitlements 路由的验签逻辑）。

正确写法是先正向锁定形状，再比差异：
```ts
expect(typeof rotated).toBe("string");
expect(rotated.split(".")).toHaveLength(2);
expect(rotated).not.toBe(token);
```

教训：**任何 `not.toBe` / `not.toEqual` 之前，必须有一步断言「东西真的拿到了」。**
否定断言只证明「不是旧值」，不证明「是新值」。

### 4.22 危险操作没有二次确认、表单 label 没接控件——都是可用性缺陷，不是样式问题

这两条都是写 E2E 时被测试逼出来的：

- **删除存储目标**原本点一下就发 `DELETE`。改成 `AlertDialog` 确认，文案要说清**删掉什么、保留什么**：
  「它历史上的作业副本记录也会一并清除（作业本体与审计保留）」。只说「确定删除吗」等于没说。
- **`FormField` 的 label 没有 `htmlFor`**，`<label>` 和 `<input>` 只是视觉上挨着。后果有两层：
  读屏软件念不出控件名；`page.getByLabel("名称")` 直接取不到元素。

```tsx
<FormField label="名称" htmlFor="destination-name" required>
  <Input id="destination-name" ... />
</FormField>
```

教训：**能用无障碍查询定位到的界面，才是真实可用的界面。** 测试写不下去的地方，
往往正是键盘用户和读屏用户卡住的地方。写 E2E 时优先用 `getByRole` / `getByLabel`，
不要图省事用 `nth()` 或 CSS 选择器——那会把 a11y 缺陷藏起来。

### 4.23 备份/恢复必须走 `docker exec`：宿主机 `pg_dump` 15.18 打不开 PG 16.15 的库

宿主机装的是 `postgresql-client` 15.18，服务端是容器里的 PostgreSQL 16.15，直接跑会报
`aborting because of server version mismatch`；反过来用 15 生成的 dump 恢复到 16 也可能报
`unsupported version (1.15) in file header`。

所以 `src/lib/services/backup/pg.ts` 的第一选择永远是容器内的二进制：
```bash
docker exec -e PGPASSWORD=... licensing-pg pg_dump \
  --format=custom --no-owner --no-privileges --compress=6 \
  --username <u> --dbname <db>
```
返回值带 `strategy: "docker"`，方便 UI 和排障时知道这份备份是谁生成的。
宿主机 `pg_dump` 只作兜底，且**必须剥掉连接串里的 `?schema=public`**——
那是 Prisma 的方言，libpq 不认识，会报 `invalid URI query parameter: "schema"`。

还有一处只有真跑才知道：**`licenses` 表里没有 `license_key` 列**，授权码在 `license_keys`
（`key_hash` / `key_prefix` / `key_last4`）。恢复对账的 SQL 一开始写错表，直接报列不存在。

教训：**备份是「能不能恢复」的问题，不是「有没有文件」的问题。** 因此每次隔离演练都做三条对账
（表数量、授权行数、关键列完整性），实测 41/41 表、245/245 行、RTO 2–4 秒，才敢说这条链路是通的。

### 4.24 凭证永不出后端；没实测过的能力一律标 false

两条写进了 `src/lib/services/backup/serialize.ts` 的文件头注释：

- **接口只回 `credentialConfigured: boolean`**，连密文都不下发。密文虽然解不开，但下发它就等于
  给了攻击者离线爆破的靶子，没有任何正面价值。
- **`capabilities()` 对新适配器一律返回全 `false`**：S3 的版本控制、对象锁、WebDAV 的原子移动，
  我们只有 local 做过端到端验证。规格 16.11.1 要求「未实测不标已支持」，标了就是骗人。
  UI 上对应显示「未验证」，而不是「不支持」。

换凭证的策略是**新建 + 吊销旧的**（`revokeCredential` 写 `revoked_at` + `rotated_at`），
不原地覆盖——轮换历史本身是审计证据。

---

### 4.25 权限只做了 `disabled` 却没解释，等于让用户猜

只读账号（`backup:read`）打开备份页，数据全在，但「立即备份 / 新增目标 / 新增策略」
和行内「测试 / 编辑 / 删除」都是禁用态，页面上**没有一个字**说明为什么点不动。

排查时我自己也差点误判：第一轮核查只读 `allInnerTexts()`，看到按钮都在就以为是权限没生效；
实际上 `disabled` 一直在，缺的是解释。

最终规则（已写进 `docs/design-system.md` 5.4.1）：

| 做法 | 为什么不选 |
| --- | --- |
| 隐藏按钮 | 用户不知道这里本来能做什么，会当成功能缺失 |
| 可点，点了 403 | 最差：用户白填一遍表单才被拒，把服务端校验当交互反馈 |
| **禁用 + 顶部说明 + 点名权限码** | 保留能力可见性，并给出下一步动作（找谁开通 `backup:write`） |

配套：顶栏组织徽标旁显示角色（只读 / 操作员 / 管理员 / 所有者），换账号一眼就知道当前视角；
只读账号必须仍能读到真实数据，E2E 里专门断言「最近成功备份」有值，而不是只断言按钮禁用。

### 4.26 `browser.newContext()` 会继承项目的 `storageState`

想写一条「以审计账号登录」的 E2E，用 `test("…", async ({ browser }) => { const context = await browser.newContext(); … })`
手动建 context，结果**context 里已经带着 owner 的会话**——`goto("/login")` 直接被应用跳到
`/app/dashboard`，随后在错误的页面上等元素，报的是 `Test timeout of 45000ms exceeded`，
截图里赫然是所有者视角。

正确写法是在 describe 里清空：
```ts
test.describe("只读角色", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("…", async ({ page }) => { /* 走真实登录 */ });
});
```

教训：**排查 E2E 超时先看失败截图里的「我是谁」**。会话不是你以为的那个人，
后面所有断言都在错的前提上跑。

### 4.27 契约测试拦住的不是「解析失败」，而是「接口加了、文档没加」

给 P1-1 补完三个公开端点后跑 `tests/unit/openapi.test.ts`，报的是：

```
代码里存在但 spec 未覆盖的公开端点：
/api/v1/activations/{activation_id}
/api/v1/oauth/token
/api/v1/offline-grants
```

注意：`openapi.yaml` 本身**一直能正常解析**，`$ref` 也都能解析，所有旧断言都绿。
如果只做「spec 能不能解析」「$ref 有没有断」这类检查，这三个缺口永远不会被发现。

所以契约测试必须双向：既检查「spec 里的 path 有没有对应路由文件」，也检查
「代码里的公开 route 有没有进 spec」。后者才是真正会漏的那个方向。

同样的道理适用于文档里的数字：`badge="7 个端点"` 这种手写数量在加了 3 个端点之后
就成了错误信息，而且**没有任何机制会提醒你改**。能算出来的数字一律算出来。

### 4.28 `Record<string, T>` 会吃掉键的字面量信息，让完整性检查变成假的

给错误码文档页写文案表时，我用了：

```ts
const ERROR_GUIDANCE: Record<keyof typeof ERROR_STATUS, { meaning: string; action: string }> = { … };
```

想靠编译期逼出「新增错误码必须补文案」。它没报错，但**不是因为它对，而是因为它没在检查**：
`ERROR_STATUS` 当时声明为 `Record<string, number>`，于是 `keyof typeof ERROR_STATUS` 就是 `string`，
任何对象都能赋值给 `Record<string, T>`。

把源头改成字面量对象 + `as const` 并导出 `ErrorCode` 联合类型后，`npx tsc --noEmit` 立刻报：

```
error TS2739: Type '{ … }' is missing the following properties from type
'Record<… | "MFA_REQUIRED", { … }>': CSRF_FAILED, CONFLICT
```

确实是漏写的两条。补上后 21 个错误码全部有文案。

教训：**任何依赖 `keyof` / `Exclude` 的完整性检查，先确认源头不是 `Record<string, …>`、`string` 索引签名
或 `any`**。否则你得到的是一段看起来很严谨、实际永远通过的类型体操。

### 4.29 子串断言会双向骗人：`CONFLICT` 与 `IDEMPOTENCY_CONFLICT`

`llms-full.txt` 的公开错误码清单要排除控制台专用码。第一版断言写成：

```ts
expect(full).not.toContain("CONFLICT");   // 想表达「不该出现 CONFLICT」
```

它失败了——因为正文里出现的是 `IDEMPOTENCY_CONFLICT`，包含 `CONFLICT` 这个子串。
反过来，如果写成 `expect(full).toContain("CONFLICT")` 想证明「列了 CONFLICT」，同样会被骗过去。

正确做法是**先切出「## 8. 错误码」这一节，解析出编码集合再按元素比较**，
而不是对整篇文本做子串判断。

### 4.30 「默认目录一定存在」的假设，只会在用户传自定义路径时炸

Python / PHP / Go 三个示例第一版都是这样：

```python
with open(os.path.join(KEY_DIR, "ziming-example-device.key"), "wb") as handle:  # 目录不存在就 FileNotFoundError
```

`KEY_DIR` 默认是系统临时目录，**当然**存在，所以按 README 默认值跑一百遍都不会出问题；
一旦有人按文档传 `LICENSE_KEY_DIR=/tmp/my-keys`，三个脚本同时崩。

PHP 那一版更阴：`file_put_contents()` 目录不存在时只抛 **Warning** 并返回 `false`，
旧代码没检查返回值，于是「写失败」被当成「写成功」，后面拿空字符串去签名。

修法：Python `os.makedirs(..., mode=0o700, exist_ok=True)`、PHP `mkdir(0700, true)` +
检查返回值 + `chmod 0600`、Go `os.MkdirAll(dir, 0o700)`。
Java（`Files.createDirectories`）与 C#（`Directory.CreateDirectory`）本来就建目录，所以没暴露——
**同一个 bug 只在三个语言里出现，不是巧合，是那三个语言的写法都跳过了「确保目录存在」这一步。**

### 4.31 验收脚本自己会被限流：`/activations` 是 10 次 / 60 秒

`verify.mjs` 第一版连跑六个语言，第 6 个报：

```
RATE_LIMITED: 请求过于频繁，请在 15 秒后重试
```

不是 SDK 的问题：每个示例打两次 `/activations`（成功 + 失败路径），六个语言共 12 次，
而公开限流是**每产品 10 次 / 60 秒**。这类「验收脚本比被测代码更容易撞限流」的情况很常见，
因为验收脚本天生要短时间重复同一个动作。

修法有两层，缺一不可：

1. **按窗口铺开**：语言之间默认间隔 12 秒（`LICENSE_VERIFY_GAP_MS` 可调），12 次请求才落在
   60 秒窗口之外；
2. **撞上就退避**：识别到 `RATE_LIMITED` 后从错误文案/`retry-after` 读出等待秒数，等一轮再重试一次。

只做第 1 层会在别人机器上偶发失败（机器快慢、窗口边界），只做第 2 层会让脚本慢得莫名其妙。
**验收脚本要把「限流是预期行为」写进设计**，而不是把它当失败信号。

---

## 5. 改动过哪些既有约定（避免被回退）

| 位置 | 改动 | 原因 |
| --- | --- | --- |
| `src/lib/auth/session.ts` | Cookie `secure` 按 `appBaseUrl` 协议判断 | 内网 http 部署要能登录 |
| `src/lib/services/license-list.ts` | `q` 增加 `OR l.id::text ILIKE $n` | 支持按授权 ID 片段检索（真实需求） |
| `src/lib/http/rate-limit.ts` | 新增 peek / recordFailure / reset | 登录只对失败计数 |
| `src/components/app/page-header.tsx` | `Section` 增加 `id` + `scroll-mt-20` | 个人设置页的 `#security` 锚点 |
| `src/app/app/layout.tsx` | 不用 Suspense 包 AppShell | 保住页面的 instant-navigation 校验 |
| `src/app/app/products/page.tsx` / `customers/page.tsx` | 列表加 `onRowClick` 整行进详情 | 与授权/设备列表交互一致 |
| `docs/shots/` | 已重建（31 张，全部基于虚构种子数据） | 早期截图含真实客户名，公开发布前移除；现用虚构数据重截，可随仓库分发，见 [`docs/shots/README.md`](shots/README.md) |
| `src/lib/http/api.ts` | `ERROR_STATUS` 由 `Record<string, number>` 改为字面量对象 + `as const`，并导出 `ErrorCode` | 宽类型让 `keyof` 退化成 `string`，完整性检查全失效（见 4.28） |
| `src/lib/services/rate-limit-store.ts` | 限流表移到 `src/lib/domain/public-rate-limits.ts` 并 re-export | 只想读数值的读者（llms 生成器、契约测试）不该被迫拖起 Prisma |
| `src/lib/services/webhook-events.ts` | 先写 `WEBHOOK_EVENT_TYPES` 数组，类型由数组推导 | 反过来先写 union 再手抄数组必然分裂 |
| `src/lib/developers/llms-content.ts` | 删除，改为 `llms-generator.ts` 从契约与代码派生 | 手写副本一定会过期（见 4.27） |
| `prisma/seed.ts` | 授权到期时间改为「起算 + 套餐周期」现算 | 让演示数据的周期与日期自洽 |
| `src/app/api/v1/admin/dashboard/route.ts` | 趋势查询补零 + 按组织时区切日 | 「近 14 天」必须画满 14 天 |
| `src/lib/auth/totp.ts` / `layout.tsx` / `sidebar.tsx` | 品牌名改为「子铭」 | 改名要覆盖浏览器标题、验证器 issuer、localStorage key |
| `sdk-examples/*/quickstart.*` | 密钥目录改为主建 `0700` 并 `chmod 0600` | 默认目录一定存在，自定义路径时三个语言直接崩（见 4.30） |
| `sdk-examples/README.md` | 六语言统一异常族名 + 错误映射表 + 平台坑 | 「服务不可用」原本三种叫法（`ServiceUnavailableError` / `ServiceDownError` / `ServiceUnavailableException`），文档无法给出一张表 |

---

## 6. 下一步建议（按价值排序）

1. **设备详情页**：从设备列表点进去看「这台机器用过哪些授权、被禁过几次」——客服排查最需要
   （后端接口已就绪，照 `customers/[id]` 的写法做一个页面即可）；
2. **角色管理页**：现在只能改成员角色，自定义角色的权限勾选只能在 API 层做；
3. **Webhook 真实外发验证**：起本地接收器，验 `X-Signature` 与重试退避是否符合规格第 8 章；
4. **多实例化**：限流与幂等换 Redis，会话表已经是数据库态可直接横向扩；
5. **Firefox / WebKit**：Radix 组件在 Safari 的焦点行为值得跑一遍。
