import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    environment: "node",
    // 所有集成用例共用同一个实例与同一个数据库；并行跑文件会让并发激活、
    // 计数快照等用例互相干扰。串行执行换来确定性。
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 60000,
    reporters: ["default"],
  },
});
