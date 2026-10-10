import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import pg from "pg";
import { withIdentity, type Identity } from "../auth/context.js";
import { AuthService } from "../auth/service.js";
import { installAuthentication } from "../auth/http.js";
import { hashPassword } from "../auth/password.js";
import { createTenantPool, DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import { runMigrations } from "../db/migrate.js";
import { testServerUrl } from "../test-support.js";
import { registerCollaborationRoutes } from "./http.js";
import { CollaborationService } from "./service.js";
import { CredentialCipher } from "../repositories/credentials.js";
import type { WebhookTransport } from "./webhook.js";
import type { PlatformDiscussionReader } from "./types.js";

export async function createCollaborationFixture(options: { history?: PlatformDiscussionReader; transport?: WebhookTransport; authenticated?: boolean; deliveryIntervalMs?: number; retryDelayMs?: number } = {}) {
  const cleanups: Array<() => Promise<unknown>> = [];
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, "清理协作测试资源失败");
  };
  try {
    const suffix = randomUUID().replaceAll("-", "");
    const database = `collaboration_${suffix}`;
    const role = `collab_${suffix}`;
    const admin = new pg.Client({ connectionString: testServerUrl });
    await admin.connect();
    cleanups.push(() => admin.end());
    await admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'fixture-password'`);
    cleanups.push(() => admin.query(`DROP ROLE ${role}`));
    await admin.query(`CREATE DATABASE ${database} OWNER ${role}`);
    cleanups.push(() => admin.query(`DROP DATABASE ${database} WITH (FORCE)`));
    const url = new URL(testServerUrl); url.pathname = `/${database}`; url.username = role; url.password = "fixture-password";
    const pool = createTenantPool(url.href);
    const disconnected: Promise<void>[] = [];
    pool.on("connect", (client) => { disconnected.push(new Promise<void>((resolve) => client.once("end", resolve))); });
    cleanups.push(async () => { await pool.end(); await Promise.all(disconnected); });
    await runMigrations(pool, fileURLToPath(new URL("../../migrations", import.meta.url)));
    const identity = (username: string, teamId: string, role: "admin" | "member"): Identity => ({ userId: randomUUID(), username, email: `${username}@fixture.test`, name: username === "alice" ? "张伟" : username === "bob" ? "李娜" : "王磊", teamId, teamName: teamId === DEFAULT_TEAM_ID ? "库存平台" : "订单平台", role });
    const otherTeam = randomUUID();
    await pool.query("INSERT INTO teams(id,name) VALUES($1,'团队乙')", [otherTeam]);
    const alice = identity("alice", DEFAULT_TEAM_ID, "admin");
    const bob = identity("bob", DEFAULT_TEAM_ID, "member");
    const outsider = identity("outsider", otherTeam, "admin");
    const passwordHash = await hashPassword("Fixture-password-2026");
    for (const user of [alice, bob, outsider]) {
      await pool.query("INSERT INTO auth_users(id,username,email,name,password_hash) VALUES($1,$2,$3,$4,$5)", [user.userId, user.username, user.email, user.name, passwordHash]);
      await pool.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,$3)", [user.teamId, user.userId, user.role]);
    }
    const reviewId = randomUUID(), secondReviewId = randomUUID(), findingId = randomUUID(), secondFindingId = randomUUID();
    await withTeam(DEFAULT_TEAM_ID, async () => {
      const repository = randomUUID();
      await pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext) VALUES($1,'https://gitlab.example.test',1,'库存','team/inventory','https://gitlab.example.test/team/inventory','https://gitlab.example.test/team/inventory.git',$2)`, [repository, Buffer.from("fixture")]);
      for (const [id, finding, iid] of [[reviewId, findingId, 1], [secondReviewId, secondFindingId, 2]]) {
        await pool.query("INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,status) VALUES($1,$2,$3,$4,'abc','检查库存','author',1,'completed')", [id, repository, randomUUID(), iid]);
        await pool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,'{}')", [finding, id]);
      }
    });
    const service = new CollaborationService(pool, { ...(options.history ? { history: options.history } : {}), webhookTransport: options.transport ?? (async () => {}), cipher: new CredentialCipher(randomBytes(32)), publicOrigin: "https://review.example.test", retryDelayMs: options.retryDelayMs ?? 0, deliveryIntervalMs: options.deliveryIntervalMs ?? 0 });
    const app = Fastify();
    if (options.authenticated) installAuthentication(app, new AuthService(pool, "fixture-setup-token"), "http://127.0.0.1");
    else app.addHook("onRequest", (request, _reply, next) => {
      const current = request.headers["x-fixture-user"] === "bob" ? bob : request.headers["x-fixture-user"] === "outsider" ? outsider : alice;
      withIdentity(current, next);
    });
    registerCollaborationRoutes(app, { service });
    cleanups.push(() => app.close());
    const route = `/api/reviews/${reviewId}/findings/${findingId}/comments`;
    return { app, pool, service, alice, bob, outsider, reviewId, findingId, secondReviewId, secondFindingId, route, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "启动与清理协作测试失败"); }
    throw error;
  }
}
