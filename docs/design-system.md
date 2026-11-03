# 设计系统

本文件是后台的**唯一视觉与交互事实来源**。页面里不允许出现魔法色值、临时圆角或不一致的
按钮写法——所有样式都从这里的 Token 与组件派生。

- Token 定义：`src/app/globals.css`
- 通用组件：`src/components/app/`
- 基础控件：`src/components/ui/`（shadcn/ui，29 个）

---

## 1. 颜色 Token

颜色用 OKLCH 表达：亮度统一、暗色模式可预测、避免 sRGB 插值发灰。
亮色与暗色两套变量同名，只切换 `.dark` 类。

### 1.1 基础色

| Token | 亮色值 | 用途 |
| --- | --- | --- |
| `--background` | `oklch(0.995 0.0015 260)` | 页面底色（近白，带极轻冷调） |
| `--foreground` | `oklch(0.19 0.01 260)` | 正文文字 |
| `--card` | `oklch(1 0 0)` | 卡片/表格容器（纯白，与底色形成层次） |
| `--muted` | `oklch(0.968 0.006 260)` | 次级背景（表头、代码块、禁用底） |
| `--muted-foreground` | `oklch(0.52 0.014 260)` | 辅助文字（说明、时间戳、占位） |
| `--border` | `oklch(0.912 0.006 260)` | 分隔线与描边 |
| `--input` | `oklch(0.9 0.008 260)` | 输入框边框 |
| `--ring` | `oklch(0.58 0.15 264)` | 焦点环 |

### 1.2 品牌色

| Token | 亮色值 | 用途 |
| --- | --- | --- |
| `--primary` | `oklch(0.52 0.19 264)` | 主按钮、Active 导航、关键数据 |
| `--primary-foreground` | `oklch(0.99 0.005 260)` | 主色上的文字 |
| `--accent` | `oklch(0.958 0.012 262)` | 次级按钮底、行悬停 |
| `--accent-foreground` | `oklch(0.29 0.05 264)` | accent 上的文字 |

选择靛蓝（hue 264）的理由：授权状态里已经占用了绿（成功）、琥珀（警告）、红（危险）、
蓝（信息），品牌色必须与这四者都能区分，靛蓝在色相与明度上都有足够距离。

### 1.3 语义色

| Token | 亮色值 | 语义 | 业务映射 |
| --- | --- | --- | --- |
| `--success` | `oklch(0.6 0.14 156)` | 成功/可用 | 授权 active、投递 succeeded |
| `--warning` | `oklch(0.72 0.15 75)` | 需要注意 | 授权 suspended、30 天内到期、延迟>200ms |
| `--destructive` | `oklch(0.58 0.21 25)` | 危险/失败 | revoked/cancelled、5xx、投递 dead |
| `--info` | `oklch(0.6 0.13 245)` | 中性信息 | pending/draft、4xx |

**对比度**：`--warning` 的 `--warning-foreground` 特意用深色（`oklch(0.24 0.03 75)`），
因为琥珀底配白字达不到 4.5:1；其余语义色配近白字。

### 1.4 状态胶囊

`globals.css` 的 `@layer components` 提供 6 个状态底色类，供 `ToneBadge` 使用：

```css
.status-success   /* 绿底 + 深绿字 */
.status-warning   /* 琥珀底 + 深琥珀字 */
.status-danger    /* 红底 + 深红字 */
.status-info      /* 蓝底 + 深蓝字 */
.status-neutral   /* 灰底 + 中性字 */
.status-brand     /* 靛蓝底 + 靛蓝字 */
```

这 6 个类是状态色的**唯一出口**，页面里写 `className="bg-green-100 text-green-700"`
属于违规。

---

## 2. 间距、圆角、阴影

| 类别 | 规则 |
| --- | --- |
| 间距 | Tailwind 4px 基准。卡片内边距 `p-4`/`p-5`；区块间距 `space-y-6`；表格单元格 `px-3 py-2.5` |
| 圆角 | `--radius: 0.625rem`（10px）。`--radius-sm/md/lg/xl` 由它按 0.6/0.8/1/1.4 派生 |
| 阴影 | 只用 `shadow-sm`/`shadow-xs`。浮层（Dialog/Drawer/Popover）依赖组件自带阴影，不自定义 |
| 最大宽度 | 内容区 `max-w-[1600px]` 居中；超宽屏不留无限拉伸的表格 |

---

## 3. 字体与数字

| 项 | 规则 |
| --- | --- |
| 字体 | `--font-sans`（Geist Sans），等宽 `--font-geist-mono` |
| 字号 | 正文 `text-sm`（14px）；说明 `text-xs`；页面标题 `text-xl font-semibold tracking-tight`；KPI 数字 `text-2xl` |
| 数字 | 所有 ID、授权码、时间戳、延迟、金额加 `.tabular`（`font-variant-numeric: tabular-nums`），保证列对齐 |
| 截断 | 长 ID 用 `truncate` + `title`；授权码统一 `maskLicenseKey` 显示为 `••••-••••-••••-3456` |

---

## 4. 动效

| Token | 值 | 用途 |
| --- | --- | --- |
| `--motion-fast` | `120ms` | 悬停、按下、颜色切换 |
| `--motion-base` | `160ms` | 展开/收起、弹窗淡入 |
| `--motion-slow` | `200ms` | 抽屉滑入、Toast 进出 |

规则：

- 只动 `opacity`/`transform`/`background-color`，不动布局属性；
- 不使用弹跳曲线（`cubic-bezier` 越界 > 1）；
- `prefers-reduced-motion: reduce` 时全部降为 `0.01ms`（已写在 `globals.css`）。

---

## 5. 组件规范

### 5.1 Button（五变体 × 七状态）

变体来源：`src/components/ui/button.tsx`

| 变体 | 用途 | 例 |
| --- | --- | --- |
| `default` | 主行动，一屏最多一个 | 签发授权、保存 |
| `secondary` | 次要行动 | 取消、筛选、重置 |
| `outline` | 中性行动，带描边 | 导出 CSV、撤销改动 |
| `ghost` | 低权重，无底色 | 图标按钮、表格行内动作 |
| `destructive` | 破坏性 | 撤销授权、删除、归档 |

七状态与实现：

| 状态 | 表现 | 实现 |
| --- | --- | --- |
| Default | 基础色 | `bg-primary text-primary-foreground` |
| Hover | 背景加深一档 | `hover:bg-primary/80`（其它变体各自一档） |
| Focus-visible | 3px 焦点环（全局 `:focus-visible` 另给 2px outline + 2px offset） | `focus-visible:ring-3 focus-visible:ring-ring/50` |
| Active（按下） | 轻微下沉 | `active:not-aria-[haspopup]:translate-y-px` |
| Disabled | 50% 不透明、不可点 | `disabled:opacity-50 disabled:pointer-events-none` |
| Loading | 左侧 Spinner + 文案变「正在…」+ 禁用 | 业务组件状态位，见 `ConfirmDialog` |
| Selected | 用于切换类按钮（周期预设） | `aria-pressed` + `bg-accent` |
| Invalid | 表单校验失败的输入 | `aria-invalid:border-destructive aria-invalid:ring-3` |

**权限不足时**：按钮 `disabled` 且外层包 `Tooltip`，文案说明缺哪个权限码
（例：「当前角色没有 product:write 权限」）。不隐藏按钮，否则用户不知道功能存在。

### 5.2 DataTable

`src/components/app/data-table.tsx`

- 四态渲染顺序：**Error → Skeleton → Empty → Table**（先报错，其次加载，再空态，最后数据）；
- 表头 `sticky top-0`，长列表滚动时列名不丢；
- 排序：表头按钮，`sort`/`order` 写进 URL，后端 `ORDER BY`；
- 选择：`selectable` 开启后出现首列 Checkbox，全选只作用于当前页（跨页选择需要显式提示）；
- 行点击：`onRowClick` 用于打开详情；行内有按钮时按钮 `stopPropagation`，避免误跳转。

### 5.3 FilterBar 与 URL 同步

`src/components/app/filter-bar.tsx`

- 搜索框 300ms 防抖后才提交（`useSearchState(initial, apply, 300)`）；
- 所有筛选条件写进 `router.replace`，**刷新不丢、可分享**；
- 已生效条件渲染成可删除的 chip；
- 分页在筛选变化时回到第 1 页（不清空 `page` 会出现「筛选后空白页」）。

### 5.4 Dialog / Drawer / ConfirmDialog

| 场景 | 组件 | 规则 |
| --- | --- | --- |
| 破坏性操作 | `ConfirmDialog` | `tone="danger"`，确认按钮 Loading，失败在弹窗内展示错误不关闭 |
| 非破坏性表单 | `Dialog` | 提交失败保留输入，字段级错误回填到 `FormField` |
| 不离开列表的创建 | `Drawer`（右侧） | 签发授权、日志详情；Esc 关闭，关闭后列表刷新 |
| 一次性密钥 | `SecretReveal` | 与 Dialog 同层，需用户主动关闭；关闭后不可再查看 |

焦点规则：打开后焦点进入第一个可交互元素，关闭后回到触发按钮（Radix 默认行为，未破坏）。

**破坏性操作的确认文案要写清「删掉什么、保留什么」**，不能只问「确定删除吗」：

> 删除存储目标「上海机房本地盘」？
> 它历史上传的备份副本会一并清除；作业记录、校验结果与审计日志保留。

`ConfirmDialog` / `AlertDialog` 的确认按钮用动词本身（「确认删除」「撤销授权」），
不用「确定」——用户在弹窗上读到的最后一个词，应该是他即将造成的后果。

### 5.4.1 无权限的操作：禁用 + 说明，而不是隐藏或等它 403

权限不足时，按钮**保留在原位但 `disabled`**，页面顶部给一条解释性 `Alert`：

> 当前账号对备份只有只读权限
> 可以查看存储目标、备份策略、作业历史与恢复演练结果，但按钮是禁用的。
> 需要发起备份、修改目标或做恢复演练，请联系管理员为你的角色开通 backup:write 与 backup:restore。

三个候选做法里为什么选这个：

| 做法 | 问题 |
| --- | --- |
| 直接隐藏按钮 | 用户不知道「这里本来能做什么」，会以为功能不存在，反复提需求 |
| 可点，点了报 403 | 最差：把服务端校验当交互反馈，用户白填一遍表单才被拒 |
| **禁用 + 顶部说明原因** | 保留能力可见性，同时给出**下一步动作**（找谁开通哪个权限码） |

配套要求：
- 权限码要写进文案（`backup:write`），运维照着就能改角色，不用猜；
- 页面顶栏的组织徽标旁显示角色（只读 / 操作员 / 管理员 / 所有者），一眼知道当前视角；
- 只读账号仍要能**读到真实数据**——只读不是空白页，E2E 里专门断言了这一点。

### 5.5 Switch（即时保存）

- 不配保存按钮：切换即 `PATCH`；
- 乐观更新 + 失败回滚 + `toast.error` 显示服务端原因；
- 请求进行中该行 Switch `disabled`，防连点；
- 语义要求：`aria-label` 必须说明「改的是哪个对象的哪个开关」，例如「FluxPanel 桌面版 启用状态」。

### 5.6 Toast

- 成功：`toast.success`，文案含结果（「已暂停 3 份授权」而不是「操作成功」）；
- 失败：`toast.error`，优先展示服务端 `message`，其次 `code`；
- 不使用 Toast 承载需要用户决策的信息——那属于 Dialog。

### 5.7 Badge

`src/components/app/status-badge.tsx` 提供：

| 组件 | 覆盖取值 |
| --- | --- |
| `EffectiveStatusBadge` | 8 种计算状态（含 `activation_limit_reached`、`device_limit_reached`） |
| `AdminStatusBadge` | 6 种管理状态 |
| `RecordStatusBadge` | active / disabled / archived |
| `ActivationStatusBadge` | active / released / blocked |
| `HttpStatusBadge` | 1xx–5xx 分段着色 |
| `DeliveryStatusBadge` | pending / delivering / succeeded / failed / dead |

每个徽章都带 `dot`（小圆点），不依赖颜色单一通道传达状态（色盲可用）。

---

## 6. 布局与响应式

| 断点 | 侧栏 | 内容区 | 表格 |
| --- | --- | --- | --- |
| ≥1024px（lg） | 固定 240px，可折叠为 64px 图标栏 | 剩余宽度，最大 1600px | 全列展示 |
| 768–1023px（md） | 隐藏，改汉堡按钮 + 抽屉 | 全宽 | 全列展示，允许横向滚动 |
| <768px（sm） | 抽屉（280px）+ 遮罩 | 全宽，`px-3` | 隐藏次要列，关键列保留 |

实测断点：桌面 1280×720、移动 Pixel 7（412×915），E2E `responsive.spec.ts` 覆盖抽屉开合与
列表控件可用性。

### 6.1 表格列的响应式收放

`DataColumn` 的 `className` / `headerClassName` 会同时作用到 `<th>` 与 `<td>`，所以列可以按断点整列收发；
**两处必须同时写**，只写一处会出现表头在、单元格空，或反过来错位。

授权列表的实际取舍（390px 宽实测）：

| 列 | 断点 | 理由 |
| --- | --- | --- |
| 客户 / 产品 | 始终显示 | 行的身份 |
| 开始 / 到期 | 始终显示 | 判断是否还能用 |
| 状态 | 始终显示 | 判断该不该处理 |
| 设备 | `hidden sm:table-cell` | 进度条占宽，可进详情看 |
| 周期 | `hidden md:table-cell` | 与「到期」信息重复 |
| 兑换码 | `hidden lg:table-cell` | 已打码，检索用不着 |
| 创建时间 | `hidden lg:table-cell` | 排序用，不需要常驻 |
| 操作 | 始终显示 | 行内入口 |

### 6.2 表格是 `table-auto`：列宽必须自己兜住

`width` 只是给浏览器的建议值，**内容更宽时浏览器会撑开整列**。产品编码这种长字符串一旦撑开，
后面的列会被整体挤出小屏可视区。所以承载长文本的单元格要自己加 `max-w-[…]`，配合 `truncate` 才真的省略：

```tsx
<div className="min-w-0 max-w-[160px] sm:max-w-[220px]">
  <p className="truncate text-sm font-medium">{row.customer.name}</p>
</div>
```

### 6.3 网格里不要把卡片硬拉齐

`grid` 默认 `items-stretch`，同一行里内容少的卡片会被拉成和最高的一样高，中间留一大片空白。
两种情况分别处理：

- 内容本身能长（如图表）：给 `Section` 加 `className="flex flex-col"` + `contentClassName="flex flex-1 flex-col"`，
  让图表 `flex-1` 真的长满；
- 内容长度固定（如说明卡）：给网格加 `items-start`，让它保持自身高度。

---

## 7. 无障碍

- 所有图标按钮都有 `aria-label`（例：`aria-label="账户菜单：张三"`）；
- 侧栏导航是 `<nav aria-label="主导航">`，移动端抽屉标题 `sr-only` 为「主导航」，
  这样 `getByRole("dialog", { name: "主导航" })` 可定位；
- 表格 `<caption>` 说明数据范围（`DataTable` 的 `caption` 属性）；
- 焦点环 2px 且 `offset 2px`，暗色模式下同样可见；
- 状态不只靠颜色：徽章带文字 + 圆点；图表带数值标签；
- **表单控件必须用 `htmlFor` / `id` 建立 label 关联**（`FormField` 已支持 `htmlFor` 属性）：

  ```tsx
  <FormField label="名称" htmlFor="destination-name" required>
    <Input id="destination-name" value={name} onChange={...} />
  </FormField>
  ```

  只把 `<label>` 放在 `<input>` 旁边不算关联：读屏软件念不出控件名，
  自动化测试的 `getByLabel("名称")` 也取不到元素。**能用无障碍查询定位到的界面，
  才是真实可用的界面**——写 E2E 时优先 `getByRole` / `getByLabel`，
  用 CSS 选择器或 `nth()` 会把这类缺陷藏起来。

---

## 8. 禁用清单

以下写法在代码评审中直接打回：

1. 页面内硬编码颜色（`text-green-600`、`#1e40af`）；
2. 自建按钮样式（`<button className="px-4 py-2 bg-blue-500">`）；
3. 用 Toast 代替错误态（列表请求失败必须原地展示 `ErrorState` 并给重试）；
4. 分页/排序在前端对当前页数据做假处理（必须走服务端参数）；
5. 破坏性操作没有 `ConfirmDialog`；
6. 一次性密钥重复展示（`SecretReveal` 关闭后不可再取）。
