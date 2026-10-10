/** 测试连的是真 PostgreSQL。迁移器要处理事务、顺序、重复执行，打桩的执行器测不出来。 */
export const testServerUrl =
  process.env["TEST_DATABASE_URL"] ?? "postgres://ureview:ureview@localhost:5432/postgres";
