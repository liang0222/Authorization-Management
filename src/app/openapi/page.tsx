import { redirect } from "next/navigation";

/**
 * `/openapi` 是外部最常被猜到的路径，指向真正的在线浏览页。
 * 用临时重定向（307）而不是永久重定向：路由位置将来可能调整，
 * 客户端缓存住 301 之后就再也改不掉了。
 */
export default function OpenApiShortcutPage() {
  redirect("/developers/openapi");
}
