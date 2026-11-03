"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  Building2,
  FileKey,
  LayoutDashboard,
  Package,
  PlusCircle,
  RefreshCcw,
  Search,
  ShieldCheck,
  UserPlus,
  Webhook,
  KeyRound,
  Waypoints,
} from "lucide-react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useSession } from "@/lib/client/session-context";

interface Action {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  href: string;
  icon: React.ElementType;
  permission?: string;
}

const QUICK_ACTIONS: Action[] = [
  {
    id: "license-issue",
    label: "签发授权",
    hint: "进入授权管理并打开签发对话框",
    keywords: "issue license 发放 授权 新建",
    href: "/app/licenses?action=issue",
    icon: PlusCircle,
    permission: "license:issue",
  },
  {
    id: "license-batch",
    label: "批量生成兑换码",
    hint: "一次生成多张授权",
    keywords: "batch 批量 兑换码",
    href: "/app/licenses?action=batch",
    icon: FileKey,
    permission: "license:issue",
  },
  {
    id: "license-expiring",
    label: "查看 30 天内到期",
    hint: "按到期时间筛选授权",
    keywords: "expiring 到期 续费",
    href: "/app/licenses?expiringInDays=30",
    icon: RefreshCcw,
    permission: "license:read",
  },
  {
    id: "license-suspended",
    label: "查看已暂停授权",
    hint: "按有效状态筛选",
    keywords: "suspend 暂停 冻结",
    href: "/app/licenses?effectiveStatus=suspended",
    icon: ShieldCheck,
    permission: "license:read",
  },
  {
    id: "device-active",
    label: "查看在线设备",
    hint: "最近心跳在 30 分钟内",
    keywords: "device 设备 在线 心跳",
    href: "/app/devices?online=1",
    icon: Waypoints,
    permission: "activation:read",
  },
  {
    id: "customer-new",
    label: "新建客户",
    hint: "打开客户管理并新建",
    keywords: "customer 客户 新建",
    href: "/app/customers?action=create",
    icon: UserPlus,
    permission: "customer:write",
  },
  {
    id: "credential-new",
    label: "创建 API 凭证",
    hint: "为产品生成 client_id / secret",
    keywords: "credential api 凭证 client secret",
    href: "/app/developer/credentials?action=create",
    icon: KeyRound,
    permission: "credential:write",
  },
  {
    id: "webhook-new",
    label: "新增 Webhook",
    hint: "订阅授权事件",
    keywords: "webhook 回调 事件",
    href: "/app/developer/webhooks?action=create",
    icon: Webhook,
    permission: "webhook:write",
  },
];

/** 全局命令菜单（⌘K）：页面跳转 + 常用操作，全部走真实路由。 */
export function CommandMenu({
  open,
  onOpenChange,
  onNavigate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNavigate: (href: string) => void;
}) {
  const router = useRouter();
  const { session } = useSession();

  const navItems = useMemo(
    () =>
      (session?.navGroups ?? []).flatMap((group) =>
        group.items.map((item) => ({ ...item, group: group.title })),
      ),
    [session],
  );

  const actions = useMemo(
    () =>
      QUICK_ACTIONS.filter(
        (action) => !action.permission || session?.permissions.includes(action.permission),
      ),
    [session],
  );

  const go = (href: string) => {
    onOpenChange(false);
    // 同一路由的 query 变化需要 router.push，onNavigate 由调用方提供
    onNavigate(href);
    router.refresh();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="全局搜索"
      description="搜索页面或执行操作"
      className="sm:max-w-lg"
    >
      <CommandInput placeholder="搜索页面、授权操作、客户…" />
      <CommandList>
        <CommandEmpty>没有匹配结果，试试“授权”或“设备”。</CommandEmpty>
        <CommandGroup heading="快速操作">
          {actions.map((action) => (
            <CommandItem
              key={action.id}
              value={`${action.label} ${action.keywords}`}
              onSelect={() => go(action.href)}
            >
              <action.icon className="size-4 text-muted-foreground" />
              <span className="flex flex-col">
                <span>{action.label}</span>
                <span className="text-[11px] text-muted-foreground">{action.hint}</span>
              </span>
              <CommandShortcut>
                <ArrowRight className="size-3" />
              </CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="页面">
          {navItems.map((item) => (
            <CommandItem
              key={item.href}
              value={`${item.group} ${item.label}`}
              onSelect={() => go(item.href)}
            >
              <Search className="size-4 text-muted-foreground" />
              <span>{item.label}</span>
              <CommandShortcut>{item.group}</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

export const COMMAND_ICONS = { Building2, LayoutDashboard, Package };
