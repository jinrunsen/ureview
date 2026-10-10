import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../db/migrate.js";
import { assertTenantRole, createTenantPool, DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import { testServerUrl } from "../test-support.js";

const migrationName = "0018_finding_dispositions.sql";
const source = fileURLToPath(new URL("../../migrations/", import.meta.url));
const legacyFindings = [
  { status: "Resolved", severity: "high", code: "  restoreStock(order);\n" },
  { status: "Dismissed", severity: "medium", code: "return 库存 + delta;" },
  { status: "Ignored", severity: "high", code: "releaseInventory(order);" },
  { status: "Outdated", severity: "medium", code: "await save(order);" },
  { status: "Pending", severity: "medium", code: "return order.total;" },
];
type SeededTeam = { id: string; reviewId: string; userId: string; findingIds: string[] };

async function createFixture() {
  const suffix = randomUUID().replaceAll("-", "");
  const databaseName = `ureview_disposition_migration_${suffix}`;
  const roleName = `ureview_disposition_${suffix}`;
  const password = randomBytes(24).toString("hex");
  let roleCreated = false;
  let databaseCreated = false;
  let directory: string | undefined;
  let pool: pg.Pool | undefined;
  async function close() {
    await pool?.end();
    pool = undefined;
    const admin = new pg.Client({ connectionString: testServerUrl });
    try {
      await admin.connect();
      if (databaseCreated) { await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`); databaseCreated = false; }
      if (roleCreated) { await admin.query(`DROP ROLE ${roleName}`); roleCreated = false; }
    } finally { await admin.end(); if (directory) await rm(directory, { recursive: true, force: true }); }
  }
  const admin = new pg.Client({ connectionString: testServerUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE ROLE ${roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${password}'`);
    roleCreated = true;
    await admin.query(`CREATE DATABASE ${databaseName} OWNER ${roleName}`);
    databaseCreated = true;
    const url = new URL(testServerUrl);
    url.pathname = `/${databaseName}`; url.username = roleName; url.password = password;
    const ownerPool = createTenantPool(url.toString(), 2);
    pool = ownerPool;
    await assertTenantRole(ownerPool);
    directory = await mkdtemp(join(tmpdir(), "ureview-disposition-migration-"));
    for (const name of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < "0018")) {
      await copyFile(join(source, name), join(directory, name));
    }
    await migrate(ownerPool, directory);
    const teams: SeededTeam[] = [DEFAULT_TEAM_ID, randomUUID()].map((id) => ({
      id, reviewId: randomUUID(), userId: randomUUID(), findingIds: legacyFindings.map(() => randomUUID()),
    }));
    await ownerPool.query("INSERT INTO teams(id,name) VALUES($1,'库存团队')", [teams[1]!.id]);
    for (const team of teams) {
      await ownerPool.query("INSERT INTO auth_users(id,email,name,password_hash) VALUES($1,$2,'李娜','fixture')", [team.userId, `${team.userId}@example.test`]);
      await ownerPool.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')", [team.id, team.userId]);
      await withTeam(team.id, async () => {
        const repositoryId = randomUUID();
        await ownerPool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
          VALUES($1,'https://gitlab.example.test',42,'inventory','commerce/inventory','https://gitlab.example.test/commerce/inventory',
            'https://gitlab.example.test/commerce/inventory.git',$2)`, [repositoryId, Buffer.from("fixture")]);
        await ownerPool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,status,round)
          VALUES($1,$2,'legacy-disposition',7,'legacy-head','库存释放','李娜','completed',1)`, [team.reviewId, repositoryId]);
        for (const [index, payload] of legacyFindings.entries()) {
          await ownerPool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,$3)", [team.findingIds[index], team.reviewId, JSON.stringify(payload)]);
        }
      });
    }
    const migrationDirectory = directory;
    return { pool: ownerPool, teams, roleName, close, async upgrade() {
      await copyFile(join(source, migrationName), join(migrationDirectory, migrationName));
      return migrate(ownerPool, migrationDirectory);
    } };
  } catch (error) { await close(); throw error; }
  finally { await admin.end(); }
}

let fixture: Awaited<ReturnType<typeof createFixture>> | undefined;
beforeEach(async () => { fixture = await createFixture(); });
afterEach(async () => { await fixture?.close(); fixture = undefined; });

describe("处置迁移的历史记录与团队隔离", () => {
  it("非特权 owner 为所有团队保留五态并回填高中危指纹，重复迁移不改变数据", async () => {
    const current = fixture!;
    expect(await current.upgrade()).toEqual([migrationName]);
    for (const team of current.teams) {
      await withTeam(team.id, async () => {
        const result = await current.pool.query<{ id: string; status: string; disposition_version: number; payload: Record<string, unknown> }>(
          "SELECT id,status,disposition_version,payload FROM review_findings WHERE review_id=$1", [team.reviewId]);
        expect(result.rows).toHaveLength(legacyFindings.length);
        for (const [index, original] of legacyFindings.entries()) {
          const row = result.rows.find((item) => item.id === team.findingIds[index]);
          expect(row).toEqual({ id: team.findingIds[index], status: original.status, disposition_version: 0,
            payload: { ...original, fingerprint: createHash("sha256").update(original.code).digest("hex") } });
        }
      });
    }
    expect((await current.pool.query("SELECT id FROM review_findings")).rows).toEqual([]);
    const firstTeam = current.teams[0]!;
    await withTeam(firstTeam.id, () => current.pool.query("UPDATE review_findings SET status='Dismissed',disposition_version=1 WHERE id=$1", [firstTeam.findingIds[0]]));
    expect(await current.upgrade()).toEqual([]);
    expect((await withTeam(firstTeam.id, () => current.pool.query("SELECT status,disposition_version FROM review_findings WHERE id=$1", [firstTeam.findingIds[0]]))).rows)
      .toEqual([{ status: "Dismissed", disposition_version: 1 }]);
    expect((await current.pool.query("SELECT filename FROM schema_migrations WHERE filename=$1", [migrationName])).rows).toEqual([{ filename: migrationName }]);
  });

  it("新审计表对表 owner 强制 RLS，无团队不可见且跨团队不能读取或写入", async () => {
    const current = fixture!;
    await current.upgrade();
    const table = await current.pool.query("SELECT relowner::regrole::text AS owner,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='finding_disposition_events'::regclass");
    expect(table.rows).toEqual([{ owner: current.roleName, relrowsecurity: true, relforcerowsecurity: true }]);
    const eventIds: string[] = [];
    for (const team of current.teams) {
      const eventId = randomUUID(); eventIds.push(eventId);
      await withTeam(team.id, () => current.pool.query(`INSERT INTO finding_disposition_events(id,review_id,finding_id,actor_id,actor_name,previous_status,status,reason_category,version)
        VALUES($1,$2,$3,$4,'李娜','Resolved','Dismissed','false_positive',1)`, [eventId, team.reviewId, team.findingIds[0], team.userId]));
    }
    expect((await current.pool.query("SELECT id FROM finding_disposition_events")).rows).toEqual([]);
    for (const [index, team] of current.teams.entries()) {
      const other = current.teams[1 - index]!;
      await withTeam(team.id, async () => {
        expect((await current.pool.query("SELECT id FROM finding_disposition_events")).rows).toEqual([{ id: eventIds[index] }]);
        expect((await current.pool.query("UPDATE finding_disposition_events SET actor_name='不可见' WHERE id=$1", [eventIds[1 - index]])).rowCount).toBe(0);
        await expect(current.pool.query(`INSERT INTO finding_disposition_events(id,team_id,review_id,finding_id,actor_id,actor_name,previous_status,status,version)
          VALUES($1,$2,$3,$4,$5,'其他团队','Dismissed','Resolved',2)`, [randomUUID(), other.id, other.reviewId, other.findingIds[0], other.userId]))
          .rejects.toMatchObject({ code: "42501" });
      });
    }
  });
});
