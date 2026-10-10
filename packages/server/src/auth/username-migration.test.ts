import { createHash, randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect, it } from "vitest";
import { migrate } from "../db/migrate.js";
import { DEFAULT_TEAM_ID } from "../db/tenant.js";
import { testServerUrl } from "../test-support.js";
import { hashPassword } from "./password.js";
import { AuthService } from "./service.js";

it("用户名迁移保留账号、密码、团队与会话，重复前缀避让已有前缀且可重复启动", async () => {
  const databaseName = `ureview_username_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: testServerUrl });
  const previous = await mkdtemp(join(tmpdir(), "ureview-username-migration-"));
  let pool: pg.Pool | undefined;
  let created = false;
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    created = true;
    const url = new URL(testServerUrl);
    url.pathname = `/${databaseName}`;
    pool = new pg.Pool({ connectionString: url.toString() });
    const source = fileURLToPath(new URL("../../migrations/", import.meta.url));
    const filename = "0032_username_login.sql";
    for (const file of (await readdir(source)).filter((name) => name.endsWith(".sql") && name < filename)) {
      await copyFile(join(source, file), join(previous, file));
    }
    await migrate(pool, previous);
    const password = "Chengdu-2026!";
    const passwordHash = await hashPassword(password);
    const token = randomBytes(32).toString("base64url");
    const accounts = [
      { id: "00000000-0000-4000-8000-000000000001", email: "alice@a.test", username: "alice", date: "2026-01-01" },
      { id: "00000000-0000-4000-8000-000000000002", email: "alice@b.test", username: "alice-4", date: "2026-01-01" },
      { id: "00000000-0000-4000-8000-000000000003", email: "alice-2@a.test", username: "alice-2", date: "2026-01-02" },
      { id: "00000000-0000-4000-8000-000000000004", email: "alice-3@a.test", username: "alice-3", date: "2026-01-02" },
      { id: "00000000-0000-4000-8000-000000000005", email: "alice@c.test", username: "alice-5", date: "2026-01-02" },
      { id: "00000000-0000-4000-8000-000000000006", email: `${"z".repeat(254)}@a.test`, username: "z".repeat(254), date: "2026-01-03" },
      { id: "00000000-0000-4000-8000-000000000007", email: `${"z".repeat(254)}@b.test`, username: `${"z".repeat(252)}-2`, date: "2026-01-03" },
    ];
    for (const account of [...accounts].reverse()) {
      await pool.query("INSERT INTO auth_users(id,email,name,password_hash,created_at) VALUES($1,$2,'成员',$3,$4)", [account.id,account.email,passwordHash,account.date]);
      await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')", [DEFAULT_TEAM_ID,account.id]);
    }
    const first = accounts[0]!;
    await pool.query("UPDATE auth_users SET service_role='service_admin' WHERE id=$1", [first.id]);
    await pool.query("INSERT INTO auth_sessions(token_hash,user_id,team_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
      [createHash("sha256").update(token).digest("hex"),first.id,DEFAULT_TEAM_ID]);
    await copyFile(join(source, filename), join(previous, filename));
    expect(await migrate(pool, previous)).toEqual([filename]);
    expect(await migrate(pool, previous)).toEqual([]);
    const migrated = await pool.query("SELECT id,username,email,password_hash FROM auth_users ORDER BY id");
    expect(migrated.rows).toEqual(accounts.map(({ id, username, email }) => ({ id,username,email,password_hash: passwordHash })));
    expect((await pool.query("SELECT team_id,user_id,role FROM team_members ORDER BY user_id")).rows)
      .toEqual(accounts.map(({ id }) => ({ team_id: DEFAULT_TEAM_ID, user_id: id, role: "member" })));
    // 当前登录服务运行在完整迁移后的 schema 上。
    await migrate(pool, source);
    const auth = new AuthService(pool, "unused");
    expect(await auth.getIdentity(token)).toMatchObject({ userId: first.id, username: "alice", email: first.email, serviceRole: "service_admin" });
    expect(await auth.getIdentity(await auth.login("alice", password))).toMatchObject({ userId: first.id });
    expect(await auth.getIdentity(await auth.login("alice-4", password))).toMatchObject({ userId: accounts[1]!.id });
    await expect(auth.login(first.email, password)).rejects.toMatchObject({ code: "invalid_username" });
    await pool.query("UPDATE auth_users SET email=NULL WHERE id=$1", [first.id]);
    await pool.query("UPDATE auth_users SET email='shared@example.test' WHERE id<>$1", [first.id]);
    await expect(pool.query("UPDATE auth_users SET username='alice' WHERE id=$1", [accounts[1]!.id]))
      .rejects.toMatchObject({ code: "23505", constraint: "auth_users_username_key" });
    await expect(pool.query("UPDATE auth_users SET username=NULL WHERE id=$1", [first.id])).rejects.toMatchObject({ code: "23502" });
  } finally {
    await pool?.end();
    if (created) await admin.query(`DROP DATABASE ${databaseName} WITH (FORCE)`);
    await admin.end();
    await rm(previous, { recursive: true, force: true });
  }
});
