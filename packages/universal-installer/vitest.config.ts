import { defineConfig } from "vitest/config";

/** 本包的单元测试自成一体：只跑 tests/ 下的用例，不依赖宿主仓库的配置。 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
  },
});
