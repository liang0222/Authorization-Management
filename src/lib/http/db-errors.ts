import { ApiError } from "@/lib/http/api";

/** 把 Prisma 唯一约束/外键错误翻译成业务错误码。 */
export function translatePrismaError(error: unknown, message: string): never {
  const code = (error as { code?: string })?.code;
  if (code === "P2002") {
    throw new ApiError(409, "CONFLICT", message);
  }
  if (code === "P2003") {
    throw new ApiError(409, "CONFLICT", "存在关联数据，无法完成该操作");
  }
  if (code === "P2025") {
    throw new ApiError(404, "RESOURCE_NOT_FOUND", "目标记录不存在");
  }
  throw error;
}
