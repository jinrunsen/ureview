import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/verify-rule-library.test.ts", "scripts/verify-staging-records.test.ts"],
    // 迁移器的测试要连真 PostgreSQL 建库建表，比纯函数慢
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 每个测试文件各自建一个一次性数据库，文件之间并行会互相抢连接数
    fileParallelism: false,
  },
});
