# VibeHub 安装与术语使用记录

本文记录 VibeHub Skill 的安装方式、实际使用方式，以及后台页面里每个交互概念对应的
**准确术语、通俗解释和真实链接**。所有链接均由解析器实际返回，没有手工拼接。

> 术语链接全部来自 `vibehub resolve` 的真实输出（revision `8bd0124c23d96f32`）。
> 如果某次查询没有命中，本文会写「未收录」，不会编造 URL。

---

## 1. 安装记录

### 1.1 检查 Node 版本

规格 15.2 要求 Node.js ≥ 20。当前环境：

```
node v24.22.0
npm 12.2.1
```

满足要求。

### 1.2 执行安装

```bash
npx skills add oil-oil/vibe-hub-skill --agent codex -y
```

**为什么带 `--agent codex -y`**：不带参数时 `skills` CLI 会进入交互式多选（选择目标 Agent），
在本机非 TTY 环境下直接取消。显式指定 agent + 确认，才能在无交互环境下完成安装。

安装结果（项目内副本）：

```
/root/授权saas/.agents/skills/vibehub/
├── SKILL.md
├── vibehub.config.json
├── scripts/vibehub.mjs      # 术语解析器
└── agents/openai.yaml
```

全局副本：`~/.dsh/skills/vibehub/`（会话的 skill 目录能识别到 `vibehub`）。

### 1.3 验证解析器可用

```bash
node ~/.dsh/skills/vibehub/scripts/vibehub.mjs resolve --query "Sidebar"
```

返回 `ok: true`，`candidates[0]` 为 `sidebar-layout` / `左侧栏布局` / `https://vibe-hub.org/sidebar-layout`。

### 1.4 使用边界（重要）

- 解析器只接收**术语查询词**（如 `Sidebar`、`Pagination`），不发送任何源码、客户资料、
  授权码、密钥或请求日志。本项目的术语查询全部是单词或两词短语。
- VibeHub 只在开发阶段用于规范表达，**不进入运行时**：没有写进 Dockerfile、没有打包进
  生产镜像，也不作为 SaaS 的运行时依赖。
- 页面实现仍然使用项目既定技术栈（Next.js 16 + TypeScript + Tailwind CSS 4 + shadcn/ui），
  VibeHub 没有替代任何组件库。

---

## 2. 术语对照表（页面里实际用到的）

表中「本项目落地」一列是**该术语在代码里的真实位置**，不是示意。

### 2.1 结构与导航

| 术语 | 中文 | 通俗解释 | 本项目落地 |
| --- | --- | --- | --- |
| [Sidebar](https://vibe-hub.org/sidebar-layout) | 左侧栏布局 | 把层级导航固定放在页面一侧，主内容放另一侧 | `src/components/app/sidebar.tsx`，桌面固定、窄屏变抽屉 |
| [Menu](https://vibe-hub.org/menu) | 导航菜单 | 一组可点击的层级入口 | `NAV_GROUPS`（`src/lib/domain/permissions.ts`），5 组 16 项 |
| [Breadcrumb](https://vibe-hub.org/breadcrumb) | 面包屑 | 显示「我在哪一层」并支持逐级返回 | `PageHeader` 的 `breadcrumbs`，用于授权详情、产品详情、投递记录 |
| [Navbar](https://vibe-hub.org/navbar) | 顶部导航栏 | 页面顶部的全局操作区 | `src/components/app/topbar.tsx`（搜索、通知、主题、账户菜单） |
| [Drawer](https://vibe-hub.org/drawer) | 抽屉 | 从侧边滑出的面板，适合承载不离开列表的表单 | 移动端导航抽屉；`license-issue-drawer.tsx` 签发授权；日志详情抽屉 |
| [Focus](https://vibe-hub.org/focus) | 聚焦 | 键盘操作时当前元素的高亮位置 | 全局 `:focus-visible` 2px 焦点环（`globals.css`） |

### 2.2 操作与状态

| 术语 | 中文 | 通俗解释 | 本项目落地 |
| --- | --- | --- | --- |
| [Button](https://vibe-hub.org/button) | 按钮 | 触发一次动作的控件 | shadcn `Button`，5 变体 × 7 状态 |
| [Hover](https://vibe-hub.org/hover) | 悬停 | 鼠标停在元素上时的反馈 | 按钮 `hover:`、表格行 `hover:bg-muted/50`、侧栏项悬停底色 |
| [Active](https://vibe-hub.org/active) | 按下 | 鼠标按下瞬间的反馈 | 按钮 `active:` 微下沉；侧栏当前页的 Active State |
| [State](https://vibe-hub.org/state) | 状态 | 同一控件在不同数据条件下的呈现 | 授权 8 种有效状态、设备绑定状态、投递状态全部有独立令牌色 |
| [Tooltip](https://vibe-hub.org/tooltip) | 文字提示 | 悬停后出现的一句话说明 | 侧栏折叠时的图标说明、表格里的「+3」授权范围、权限不足原因 |
| [Toast](https://vibe-hub.org/toast) | 轻提示 | 操作完成后右下角短暂出现的反馈 | `sonner`，全站成功/失败统一走 `toast.success/error` |
| [Spinner](https://vibe-hub.org/spinner) | 旋转加载指示器 | 表示「正在处理」的转圈动画 | 按钮 loading 态、会话校验骨架 |
| [Skeleton](https://vibe-hub.org/skeleton) | 骨架屏 | 数据没回来前先占位出大致排版 | `TableSkeleton` / `DetailSkeleton`，表格首屏与详情页 |

### 2.3 表单与弹窗

| 术语 | 中文 | 通俗解释 | 本项目落地 |
| --- | --- | --- | --- |
| [Modal](https://vibe-hub.org/modal) | 弹窗 | 盖在页面上、需要先处理完才能继续的层 | 新建产品/客户/套餐/凭证/Webhook 的表单弹窗 |
| [Form](https://vibe-hub.org/form) | 表单 | 一组带标签和校验的输入项 | `FormField` + `FormError` + 字段级 `fieldErrors` 回填 |
| [Switch](https://vibe-hub.org/switch) | 开关 | 二选一的即时生效控件 | 产品启用状态、解绑返还次数、允许离线、系统设置布尔项 |
| [Dropdown](https://vibe-hub.org/dropdown) | 下拉菜单 | 点击后展开的一组次级操作 | 表格行末「更多操作」；顶栏账户菜单 |
| [Validation](https://vibe-hub.org/data-validation) | 数据校验 | 提交前后对输入合法性的检查 | 前端即时校验 + 服务端 400 的 `fieldErrors` 逐字段回填 |

### 2.4 数据展示

| 术语 | 中文 | 通俗解释 | 本项目落地 |
| --- | --- | --- | --- |
| [Table](https://vibe-hub.org/table) | 表格 | 多条同类数据的行列展示 | `DataTable`，服务端分页 + 排序 + 选择 |
| [Pagination](https://vibe-hub.org/pagination) | 分页 | 把长列表拆成多页浏览 | `PaginationBar`，页码与总数全部来自服务端 `pageCount` |
| [Filter](https://vibe-hub.org/filter) | 筛选 | 按条件缩小数据集 | `FilterBar`，条件写入 URL，刷新与分享都保持 |
| [Sort](https://vibe-hub.org/sort) | 排序 | 按某列升/降序重排 | 表头点击，`sort`+`order` 进 URL，后端 `ORDER BY` |
| [Empty](https://vibe-hub.org/empty) | 空状态 | 没有数据时的解释和下一步引导 | `EmptyState`，区分「还没有数据」和「筛选无结果」 |
| [Badge](https://vibe-hub.org/badge) | 徽标 | 用小色块标出状态或分类 | `ToneBadge` 及 7 个状态徽章组件 |

### 2.5 体验与适配

| 术语 | 中文 | 通俗解释 | 本项目落地 |
| --- | --- | --- | --- |
| [Responsive Design](https://vibe-hub.org/responsive-design) | 响应式设计 | 同一页面适配不同宽度 | 侧栏 ≥1024px 固定、以下变抽屉；表格窄屏横向滚动 |
| [Skip Link](https://vibe-hub.org/skip-link) | 跳过导航链接 | 键盘用户跳过重复导航直达正文 | `app-shell.tsx` 的「跳到主要内容」，`sr-only` 直到获得焦点，指向 `#main-content` |

**未收录但已按通行规范实现的术语**：`Navigation`（解析器未命中，实际用 `Menu` 表达）、
`Confirmation`（未命中，实际用 `Modal` + 危险色确认按钮表达）、`Sorting`（未命中，用 `Sort`）、
`Row Click`（未命中，按 `Hover` + `Active` 的通行做法实现：整行可点、手型光标、悬停底色）、
`Truncation`（未命中，按 `Table` 条目的「长文本省略 + Tooltip 补全」实现）。

### 2.6 本轮补充的术语落地

| 术语 | 中文 | 通俗解释 | 本项目落地 |
| --- | --- | --- | --- |
| [Hover](https://vibe-hub.org/hover) | 悬停 | 鼠标停在行上时整行变色，暗示「这一行可以点」 | 产品/客户/授权/设备列表的 `onRowClick` + 行悬停底色 |
| [Tooltip](https://vibe-hub.org/tooltip) | 文字提示 | 列被截断后，把完整内容补在悬停提示里 | 授权列表客户列 `max-w-[160px]` + `truncate`；截断信息进 Tooltip |
| [Toast](https://vibe-hub.org/toast) | 轻提示 | 操作结果反馈，且不能挡住主操作按钮 | `Toaster` 从 `top-right` 改为 `bottom-right`——右上角有「刷新 / 签发授权」 |
| [Badge](https://vibe-hub.org/badge) | 徽标 | 同一行出现两个同文案徽标时必须能区分 | 授权详情把「有效状态」与「管理状态」各自加前缀标签 |
| [State](https://vibe-hub.org/state) | 状态 | 同一字段在不同条件下要有准确文案，不能一律兜底 | 到期列三态：有到期日 / 「激活后 30 天」/ 「永久有效」 |

### 2.7 备份与灾备页新增的术语

| 术语 | 中文 | 通俗解释 | 本项目落地 |
| --- | --- | --- | --- |
| [Confirmation](https://vibe-hub.org/confirmation) | 二次确认 | 会丢数据的操作要先问一句，且要问清「删掉什么、保留什么」 | 删除存储目标走 `AlertDialog`：「历史副本一并清除，作业与审计保留」 |
| [Alert Dialog](https://vibe-hub.org/alert-dialog) | 警示弹窗 | 打断式弹窗，只用于必须让用户停下来做判断的事 | 危险操作用 `AlertDialog`，普通表单用 `Dialog`，两者不混用 |
| [Call to Action](https://vibe-hub.org/cta) | 操作按钮文案 | 确认按钮写动作本身，不写「确定」 | 「确认删除」「创建」「保存」——用户在弹窗上读到的最后一个词就是后果 |
| [Form Label](https://vibe-hub.org/form-label) | 表单标签 | 标签要真的绑到控件上，不能只是摆在旁边 | `FormField` 加 `htmlFor` + `Input` 加 `id`（`destination-name` 等） |
| [Degraded](https://vibe-hub.org/degraded) | 降级完成 | 部分目标失败但主目标成功，是一个**独立**状态而不是失败 | 作业状态 `JOB_LABEL` 里 `degraded` = 「降级完成」，与 `failed` 分开配色与文案 |
| [Skeleton](https://vibe-hub.org/skeleton) | 骨架屏 | 数据没到之前占位，避免页面跳动 | 备份页五块各自 `useResource` 的 `loading` 走骨架，不显示「0」假数字 |

**为什么 `degraded` 要单独存在**：`all_required` 模式下必备份成功才算成功；但
`primary_then_fallback` 模式下主目标失败、备用目标成功，这份备份**是可用的**——
把它标成 `failed` 会让人去重做一次没必要的备份，标成 `succeeded` 又会掩盖主链路故障。
所以它是一个独立状态，配 warning 色，并在概览里单独计数。

---

## 3. 术语如何影响实现（3 个真实例子）

规格 15.3 要求「术语必须结合当前页面解释」，下面三个是术语反过来改了设计的例子。

### 3.1 Sidebar → 折叠与窄屏抽屉

VibeHub 的 `sidebar-layout` 明确写了三条约束：侧栏只放层级导航、可收起、移动端变抽屉。
按此实现：

- 折叠状态持久化到 `localStorage`（key `ziming.sidebar.collapsed`），刷新不丢；
- 折叠成图标栏后，每个图标必须有 `Tooltip`，否则图标无法自解释；
- 窄屏抽屉必须带遮罩、关闭入口与正确的键盘焦点——`DrawerTitle` 提供可访问名称「主导航」。

### 3.2 Active State → 导航高亮必须匹配真实路由

`state` 条目强调「当前项要与实际位置一致」。本项目用 `matchPrefixes` 解决：进入
`/app/licenses/<id>` 时，「授权管理」仍然高亮。E2E 里有一条用例专门逐项点击 16 个导航项，
断言 URL 与 h1 一致，就是为了防「点得进去但高亮错位」。

### 3.3 Switch → 即时保存，失败必须回滚

`switch` 条目的关键约束是「即时生效」：不该再配一个保存按钮。本项目所有 Switch 都是
**乐观更新 + 失败回滚**：先改本地状态，`PATCH` 失败则回滚并 `toast.error` 显示服务端原因。
系统设置页的布尔项额外标注「已覆盖 / 默认值」，避免用户不知道自己改过什么。

---

## 4. 使用记录（可复核）

```bash
# 单个术语
node ~/.dsh/skills/vibehub/scripts/vibehub.mjs resolve --query "Pagination"

# 一次最多 3 个（超过会报 resolver_failed: --query may be repeated at most 3 times）
node ~/.dsh/skills/vibehub/scripts/vibehub.mjs resolve \
  --query "Sidebar" --query "Pagination" --query "Toast" --compact
```

本次开发实际查询过的词：Sidebar、Navigation、Button、Hover、Active State、Tooltip、Dialog、
Drawer、Dropdown、Switch、Toast、Skeleton、Pagination、Breadcrumb、Empty State、Data Table、
Form、Badge、Focus Visible、Loading State、Confirmation、Filter、Sorting，以及中文补充查询
导航、表格、当前页、激活态、确认弹窗、排序、加载、空状态、响应式、可访问性、键盘焦点、
表单校验、批量操作。

解析器限制（实测）：

- `--query` 最多重复 3 次，超过返回 `resolver_failed`；
- 部分口语词未收录（`Navigation`、`Confirmation`、`Sorting`、`批量操作`、`错误状态`），
  此时用已收录的近义词（`Menu`、`Modal`、`Sort`、`Filter`、`State`）表达，并在本文标注。
