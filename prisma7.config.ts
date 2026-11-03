// Prisma 7 CLI 配置：数据库连接优先取环境变量，未设置时回退到本地开发实例。
// 注意：本仓库的运行环境禁止读写 .env 文件，因此默认值写在代码里并在 README 说明。
import { defineConfig } from "prisma/config";

const DEV_DATABASE_URL =
  "postgresql://licensing:licensing_dev_pw@127.0.0.1:55432/licensing?schema=public";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.LICENSE_DB_URL ?? DEV_DATABASE_URL,
  },
});
