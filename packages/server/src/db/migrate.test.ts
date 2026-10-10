import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testServerUrl } from "../test-support.js";
import { migrate } from "./migrate.js";
import { DEFAULT_TEAM_ID } from "./tenant.js";

let dbName: string;
let pool: pg.Pool;

/** 每个用例建一个一次性数据库，用完就丢。 */
beforeEach(async () => {
  dbName = `ureview_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new pg.Client({ connectionString: testServerUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  pool = new pg.Pool({ connectionString: testServerUrl.replace(/\/[^/]*$/, `/${dbName}`) });
});

afterEach(async () => {
  await pool.end();
  const admin = new pg.Client({ connectionString: testServerUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

/** 在一个临时目录里放几个迁移文件，返回目录路径。 */
async function prepareMigrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ureview-migrations-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, "utf8");
  }
  return dir;
}

describe("schema 迁移", () => {
  it("判断题迁移为已有规范填充否，保留历史快照并支持重复执行", async () => {
    const source = fileURLToPath(new URL("../../migrations/", import.meta.url));
    const previous = await mkdtemp(join(tmpdir(), "ureview-judgement-migration-"));
    try {
      for (const file of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < "0033")) {
        await copyFile(join(source, file), join(previous, file));
      }
      await migrate(pool, previous);
      const userId = randomUUID(), ruleId = randomUUID(), repositoryId = randomUUID(), reviewId = randomUUID();
      await pool.query("INSERT INTO auth_users(id,username,name,password_hash) VALUES($1,'judgement-reviewer','陈明','fixture')", [userId]);
      await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')", [DEFAULT_TEAM_ID, userId]);
      await pool.query(`INSERT INTO managed_rules(id,team_id,name,body,good_example,bad_example,category,severity,scope,status,created_by,updated_by)
        VALUES($1,$2,'金额格式','金额使用整数分。','','','correctness','error','global','active',$3,$3)`, [ruleId, DEFAULT_TEAM_ID, userId]);
      await pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
        VALUES($1,'https://gitlab.example.test',42,'inventory','commerce/inventory','https://gitlab.example.test/commerce/inventory',
          'https://gitlab.example.test/commerce/inventory.git',$2)`, [repositoryId, Buffer.from("fixture")]);
      const rules = [{ id: `managed:${ruleId}`, body: "历史规范正文", file: { kind: "database", ruleId, version: 1, scope: "global" } }];
      await pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,rules)
        VALUES($1,$2,'judgement-history',1,'fixture-head','库存评审','陈明',1,$3)`, [reviewId, repositoryId, JSON.stringify(rules)]);
      const filename = "0033-judgement-rules.sql";
      await copyFile(join(source, filename), join(previous, filename));
      expect(await migrate(pool, previous)).toEqual([filename]);
      expect((await pool.query("SELECT judgement,version FROM managed_rules WHERE id=$1", [ruleId])).rows).toEqual([{ judgement: false, version: 1 }]);
      expect((await pool.query("SELECT rules FROM reviews WHERE id=$1", [reviewId])).rows).toEqual([{ rules }]);
      await pool.query("UPDATE managed_rules SET judgement=true WHERE id=$1", [ruleId]);
      expect(await migrate(pool, previous)).toEqual([]);
      expect((await pool.query("SELECT judgement FROM managed_rules WHERE id=$1", [ruleId])).rows).toEqual([{ judgement: true }]);
    } finally { await rm(previous, { recursive: true, force: true }); }
  });

  it("解读迁移保留旧评审与会话，允许独立解读会话并约束完成状态", async () => {
    const source = fileURLToPath(new URL("../../migrations/", import.meta.url));
    const previous = await mkdtemp(join(tmpdir(), "ureview-reading-migration-"));
    try {
      for (const file of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < "0017")) {
        await copyFile(join(source, file), join(previous, file));
      }
      await migrate(pool, previous);
      const repositoryId = randomUUID();
      const reviewId = randomUUID();
      const generatorSessionId = randomUUID();
      await pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
        VALUES($1,'https://gitlab.example.test',42,'inventory','commerce/inventory','https://gitlab.example.test/commerce/inventory',
          'https://gitlab.example.test/commerce/inventory.git',$2)`, [repositoryId, Buffer.from("fixture")]);
      await pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round)
        VALUES($1,$2,'historical-reading',1,'fixture-head','库存评审','张伟',1)`, [reviewId, repositoryId]);
      await pool.query(`INSERT INTO agent_sessions(id,team_id,dsh_session_id,kind,review_id,model,provider)
        VALUES($1,$2,'generator-before-reading','review_generator',$3,'fixture-model','fixture-provider')`,
      [generatorSessionId, DEFAULT_TEAM_ID, reviewId]);
      await pool.query(`INSERT INTO agent_session_events(team_id,session_id,seq,event)
        VALUES($1,$2,0,'{"type":"message","text":"历史会话"}')`, [DEFAULT_TEAM_ID, generatorSessionId]);

      const filename = "0017_pr_design_reading.sql";
      await copyFile(join(source, filename), join(previous, filename));
      expect(await migrate(pool, previous)).toEqual([filename]);
      expect((await pool.query(`SELECT reading_status,reading_failure_reason,reading,reading_submissions,requirement_sources
        FROM reviews WHERE id=$1`, [reviewId])).rows).toEqual([
        { reading_status: null, reading_failure_reason: null, reading: null, reading_submissions: [], requirement_sources: [] },
      ]);
      expect((await pool.query("SELECT kind,review_id,status FROM agent_sessions WHERE id=$1", [generatorSessionId])).rows)
        .toEqual([{ kind: "review_generator", review_id: reviewId, status: "running" }]);
      expect((await pool.query("SELECT event FROM agent_session_events WHERE session_id=$1", [generatorSessionId])).rows)
        .toEqual([{ event: { type: "message", text: "历史会话" } }]);
      const readingSessionId = randomUUID();
      await pool.query(`INSERT INTO agent_sessions(id,team_id,dsh_session_id,kind,review_id,model,provider)
        VALUES($1,$2,'reading-after-migration','review_reading',$3,'fixture-model','fixture-provider')`,
      [readingSessionId, DEFAULT_TEAM_ID, reviewId]);
      expect((await pool.query("SELECT kind,review_id FROM agent_sessions WHERE id=$1", [readingSessionId])).rows)
        .toEqual([{ kind: "review_reading", review_id: reviewId }]);
      await expect(pool.query("UPDATE reviews SET reading_status='completed' WHERE id=$1", [reviewId]))
        .rejects.toMatchObject({ code: "23514", constraint: "reviews_reading_completion" });
      expect(await migrate(pool, previous)).toEqual([]);
    } finally { await rm(previous, { recursive: true, force: true }); }
  });

  it("仓库详情迁移为已有仓库开启自动评审并保留评审历史，事件表只保存字段", async () => {
    const source = fileURLToPath(new URL("../../migrations/", import.meta.url));
    const previous = await mkdtemp(join(tmpdir(), "ureview-repository-detail-migration-"));
    try {
      for (const file of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < "0019")) {
        await copyFile(join(source, file), join(previous, file));
      }
      await migrate(pool, previous);
      const repositoryId = randomUUID();
      const reviewId = randomUUID();
      await pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
        VALUES($1,'https://gitlab.example.test',42,'inventory','commerce/inventory','https://gitlab.example.test/commerce/inventory',
          'https://gitlab.example.test/commerce/inventory.git',$2)`, [repositoryId, Buffer.from("fixture")]);
      await pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round)
        VALUES($1,$2,'repository-detail-history',1,'fixture-head','库存评审','张伟',1)`, [reviewId, repositoryId]);
      const filename = "0019_repository_detail.sql";
      await copyFile(join(source, filename), join(previous, filename));
      expect(await migrate(pool, previous)).toEqual([filename]);
      expect((await pool.query(`SELECT automatic_review_enabled,automatic_review_version,last_authentication_failure_at
        FROM repositories WHERE id=$1`, [repositoryId])).rows)
        .toEqual([{ automatic_review_enabled: true, automatic_review_version: 1, last_authentication_failure_at: null }]);
      expect((await pool.query("SELECT id,round FROM reviews WHERE id=$1", [reviewId])).rows).toEqual([{ id: reviewId, round: 1 }]);
      expect((await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='repository_webhook_events' ORDER BY ordinal_position"))
        .rows.map((row) => row.column_name)).toEqual(["id", "team_id", "repository_id", "received_at", "event_type", "action", "iid", "result", "reason", "review_id"]);
      expect(await migrate(pool, previous)).toEqual([]);
    } finally { await rm(previous, { recursive: true, force: true }); }
  });

  it("仓库级排除迁移删除团队配置，保留历史评审快照且不会为已有仓库复制配置", async () => {
    const source = fileURLToPath(new URL("../../migrations/", import.meta.url));
    const previous = await mkdtemp(join(tmpdir(), "ureview-repository-settings-migration-"));
    try {
      for (const file of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < "0016")) {
        await copyFile(join(source, file), join(previous, file));
      }
      await migrate(pool, previous);
      const repositoryId = randomUUID();
      const reviewId = randomUUID();
      const otherTeamId = randomUUID();
      await pool.query("INSERT INTO teams(id,name) VALUES($1,'物流团队')", [otherTeamId]);
      await pool.query(`INSERT INTO review_settings(team_id,excluded_directories,version)
        VALUES($1,'["features/steps"]',3),($2,'["fixtures"]',2)`, [DEFAULT_TEAM_ID, otherTeamId]);
      await pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
        VALUES($1,'https://gitlab.example.test',42,'inventory','commerce/inventory','https://gitlab.example.test/commerce/inventory',
          'https://gitlab.example.test/commerce/inventory.git',$2)`, [repositoryId, Buffer.from("fixture")]);
      await pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,excluded_directories,excluded_file_count)
        VALUES($1,$2,'historical-exclusion',1,'fixture-head','库存评审','张伟',1,'["features/steps"]',2)`, [reviewId, repositoryId]);

      const filename = "0016_repository_review_settings.sql";
      await copyFile(join(source, filename), join(previous, filename));
      expect(await migrate(pool, previous)).toEqual([filename]);
      expect((await pool.query("SELECT to_regclass('review_settings') AS relation")).rows).toEqual([{ relation: null }]);
      expect((await pool.query("SELECT * FROM repository_review_settings")).rows).toEqual([]);
      expect((await pool.query("SELECT excluded_directories,excluded_file_count FROM reviews WHERE id=$1", [reviewId])).rows)
        .toEqual([{ excluded_directories: ["features/steps"], excluded_file_count: 2 }]);
      expect((await pool.query("SELECT id FROM repositories WHERE id=$1", [repositoryId])).rows).toEqual([{ id: repositoryId }]);
      expect(await migrate(pool, previous)).toEqual([]);
    } finally { await rm(previous, { recursive: true, force: true }); }
  });

  it("按文件名顺序执行待执行的迁移，并说清楚执行了哪几个", async () => {
    const dir = await prepareMigrationsDir({
      "0002_add_column.sql": "ALTER TABLE team ADD COLUMN name text NOT NULL DEFAULT ''",
      "0001_create_table.sql": "CREATE TABLE team (id uuid PRIMARY KEY)",
    });

    const applied = await migrate(pool, dir);

    // 0002 依赖 0001 建的表，顺序错了它就跑不过——这条断言同时验了顺序与执行
    expect(applied).toEqual(["0001_create_table.sql", "0002_add_column.sql"]);
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'team' ORDER BY column_name",
    );
    expect(rows.map((r) => r["column_name"])).toEqual(["id", "name"]);
  });

  it("已经执行过的迁移不会再执行一次", async () => {
    const dir = await prepareMigrationsDir({
      "0001_create_table.sql": "CREATE TABLE team (id uuid PRIMARY KEY)",
    });

    await migrate(pool, dir);
    const secondRun = await migrate(pool, dir);

    // 第二次什么都不做。真会重跑的话，CREATE TABLE 会直接报错
    expect(secondRun).toEqual([]);
  });

  it("新增的迁移只跑新的那个，老的不动", async () => {
    const dir = await prepareMigrationsDir({
      "0001_create_table.sql": "CREATE TABLE team (id uuid PRIMARY KEY)",
    });
    await migrate(pool, dir);

    await writeFile(join(dir, "0002_add_column.sql"), "ALTER TABLE team ADD COLUMN name text", "utf8");
    const secondRun = await migrate(pool, dir);

    expect(secondRun).toEqual(["0002_add_column.sql"]);
  });

  it("每次执行都被记下来，升级时才知道跑到哪了", async () => {
    const dir = await prepareMigrationsDir({
      "0001_create_table.sql": "CREATE TABLE team (id uuid PRIMARY KEY)",
      "0002_add_column.sql": "ALTER TABLE team ADD COLUMN name text",
    });

    await migrate(pool, dir);

    const { rows } = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(rows.map((r) => r.filename)).toEqual(["0001_create_table.sql", "0002_add_column.sql"]);
  });

  it("某个迁移写错了，报错要点名是哪个文件", async () => {
    const dir = await prepareMigrationsDir({
      "0001_create_table.sql": "CREATE TABLE team (id uuid PRIMARY KEY)",
      "0002_broken.sql": "ALTER TABLE no_such_table ADD COLUMN name text",
    });

    await expect(migrate(pool, dir)).rejects.toThrowError(/0002_broken\.sql/);
  });

  it("中途失败时，失败的那个不留痕迹，之前成功的仍然算数", async () => {
    const dir = await prepareMigrationsDir({
      "0001_create_table.sql": "CREATE TABLE team (id uuid PRIMARY KEY)",
      "0002_half_broken.sql":
        "CREATE TABLE member (id uuid PRIMARY KEY); ALTER TABLE no_such_table ADD COLUMN x text",
    });

    await expect(migrate(pool, dir)).rejects.toThrow();

    const { rows } = await pool.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations ORDER BY filename",
    );
    expect(rows.map((r) => r.filename)).toEqual(["0001_create_table.sql"]);

    // 0002 里那句成功的 CREATE TABLE 也要一并回滚，否则重跑时它会撞车
    const { rows: tables } = await pool.query(
      "SELECT tablename FROM pg_tables WHERE tablename = 'member'",
    );
    expect(tables).toHaveLength(0);
  });
});
