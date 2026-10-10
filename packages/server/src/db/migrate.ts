import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type pg from "pg";

/**
 * 迁移期间持有的咨询锁。
 *
 * 队列也在这个 PostgreSQL 里，所以后面会起 worker 进程，同一个镜像
 * 多进程启动时会同时跑迁移。没有这把锁的话，两个进程会各自读到
 * 「还没执行过」然后把同一个文件执行两遍。
 */
const MIGRATION_LOCK_ID = 0x7572_6576;

async function ensureMigrationTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    text        PRIMARY KEY,
      executed_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * 执行迁移目录里所有还没执行过的 .sql 文件，按文件名升序。
 *
 * @returns 本次实际执行了哪几个文件，已经执行过的不会出现在里面。
 */
export async function migrate(pool: pg.Pool, migrationsDir: string): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    try {
      await ensureMigrationTable(client);

      const allFiles = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
      const { rows } = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations",
      );
      const alreadyRun = new Set(rows.map((r) => r.filename));

      const applied: string[] = [];
      for (const filename of allFiles) {
        if (alreadyRun.has(filename)) continue;
        const sql = await readFile(join(migrationsDir, filename), "utf8");

        // 一个迁移文件加它的执行记录是一笔事务。失败就整笔回滚，
        // 不会留下「表建了一半、记录没写」这种没法重跑的状态。
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [filename]);
          await client.query("COMMIT");
        } catch (cause) {
          await client.query("ROLLBACK");
          // 点名是哪个文件。不这么做的话，人只能看到一句 PostgreSQL 的
          // 语法错误，还得自己去几十个文件里翻是哪一个。
          throw new Error(
            `迁移 ${filename} 执行失败：${cause instanceof Error ? cause.message : String(cause)}`,
            { cause },
          );
        }
        applied.push(filename);
      }
      return applied;
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    }
  } finally {
    client.release();
  }
}

/** 跑一次迁移并给出一句可以直接打印的结果。服务启动与 migrate 命令共用这一段。 */
export async function runMigrations(pool: pg.Pool, migrationsDir: string): Promise<string> {
  const applied = await migrate(pool, migrationsDir);
  return applied.length > 0
    ? `已执行 ${applied.length} 个迁移：${applied.join("、")}`
    : "没有待执行的迁移";
}
