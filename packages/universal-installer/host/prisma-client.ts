/**
 * 宿主项目的 Prisma Client。
 *
 * 这是本包**唯一**指向宿主项目源码的引用（其余跨包依赖都已在 host/ 下复制）。
 * 适配器要用宿主的模型去建组织、角色、管理员、签名密钥，没法在安装器里重写一遍。
 *
 * 提取成独立仓库时，把下面这一行换成宿主发布的 client 包即可
 * （例如 `import { PrismaClient } from "@your-org/licensing-prisma"`）。
 */
export { PrismaClient } from "../../../src/generated/prisma/client";
