import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { ManagedRuleService } from "../../packages/server/src/rules/managed.js";
import { AuthService } from "../../packages/server/src/auth/service.js";
import { runMigrations } from "../../packages/server/src/db/migrate.js";
import { createTenantPool, DEFAULT_TEAM_ID } from "../../packages/server/src/db/tenant.js";
import { buildApp } from "../../packages/server/src/http.js";
import { RepositoryService } from "../../packages/server/src/repositories/service.js";
import { CredentialCipher } from "../../packages/server/src/repositories/credentials.js";
import { registerRuleCatalogRoutes, RuleCatalogService } from "../../packages/server/src/rules/catalog.js";
import { startCatalogGitLab, ruleBody } from "../../packages/server/src/rules/catalog/test-support.js";
import { testServerUrl } from "../../packages/server/src/test-support.js";

export class RuleCatalogScenario {
  readonly databaseName = `ureview_catalog_bdd_${randomUUID().replaceAll("-", "")}`;
  readonly roleName = `catalog_${randomUUID().replaceAll("-", "")}`;
  private databaseCreated = false;
  private roleCreated = false;
  private pool: pg.Pool | undefined;
  private adminPool: pg.Pool | undefined;
  private app: FastifyInstance | undefined;
  private cookie = "";
  gitlab!: Awaited<ReturnType<typeof startCatalogGitLab>>;
  baseUrl = "";
  repositoryId = "";

  async start(): Promise<void> {
    try {
      this.gitlab = await startCatalogGitLab();
      const admin = new pg.Client({ connectionString: testServerUrl });
      try {
        await admin.connect(); await admin.query(`CREATE DATABASE ${this.databaseName}`); this.databaseCreated = true;
        await admin.query(`CREATE ROLE ${this.roleName} NOLOGIN NOSUPERUSER NOBYPASSRLS`); this.roleCreated = true;
      } finally { await admin.end(); }
      const url = new URL(testServerUrl); url.pathname = `/${this.databaseName}`;
      this.adminPool = new pg.Pool({ connectionString: url.toString() });
      await runMigrations(this.adminPool, fileURLToPath(new URL("../../packages/server/migrations", import.meta.url)));
      await this.adminPool.query(`GRANT USAGE ON SCHEMA public TO ${this.roleName}`);
      await this.adminPool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${this.roleName}`);
      url.searchParams.set("options", `-c role=${this.roleName}`);
      this.pool = createTenantPool(url.toString());
      const instanceUrl = this.gitlab.instanceUrl;
      const repositories = new RepositoryService(this.pool, { verify: async (input) => ({ instanceUrl,
        projectId: input.projectPath === "commerce/payment-gateway" ? 11 : 12,
        name: input.projectPath.split("/").at(-1)!, pathWithNamespace: input.projectPath,
        webUrl: `${instanceUrl}/${input.projectPath}`, httpUrlToRepo: `${instanceUrl}/${input.projectPath}.git` }) }, new CredentialCipher(randomBytes(32)));
      this.app = buildApp({ pool: this.pool, repositories, managedRules: new ManagedRuleService(this.pool), auth: new AuthService(this.pool, "catalog-setup-token"), publicOrigin: "http://localhost:3000" });
      registerRuleCatalogRoutes(this.app, { pool: this.pool, repositories,
        service: new RuleCatalogService(this.pool, repositories) });
      this.baseUrl = await this.app.listen({ host: "127.0.0.1", port: 0 });
      await this.request("/api/auth/setup", { token: "catalog-setup-token", name: "张伟", username: "zhangwei", email: "zhangwei@example.test", password: "fixture-password-long" });
      this.repositoryId = (await this.connect("commerce/payment-gateway")).id;
      const rule = await this.request("/api/managed-rules", { name: "全局金额规范", body: "金额使用整数分",
        goodExample: "", badExample: "", category: "correctness", severity: "error", scope: "global", repositories: [], status: "active" });
      if (rule.status !== 201) throw new Error("全局规范创建失败");
    } catch (error) { await this.stop(); throw error; }
  }

  async connect(projectPath: string): Promise<{ id: string }> {
    const response = await this.request<{ repository: { id: string } }>("/api/repositories", {
      instanceUrl: this.gitlab.instanceUrl, projectPath, token: "fixture-token",
    });
    if (response.status !== 201) throw new Error("场景仓库接入失败");
    return response.body.repository;
  }

  async request<T = Record<string, unknown>>(path: string, body?: object): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { cookie: this.cookie, "x-ureview-request": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = response.headers.get("set-cookie"); if (cookie) this.cookie = cookie.split(";")[0]!;
    return { status: response.status, body: await response.json() as T };
  }

  async seedFindingStates(): Promise<void> {
    const reviewId = randomUUID();
    const rule = { id: "repository:.agents/rules/payment.md", file: { kind: "repository", repositoryId: this.repositoryId } };
    await this.adminPool!.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,status,round,trigger,rules,team_id)
      VALUES($1,$2,$3,7,$4,'校验扣款金额','lina','completed',1,'automatic',$5,$6)`,
    [reviewId, this.repositoryId, randomUUID(), "a".repeat(40), JSON.stringify([rule]), DEFAULT_TEAM_ID]);
    for (const status of ["Pending", "Resolved", "Ignored", "Dismissed"]) {
      const id = randomUUID();
      await this.adminPool!.query("INSERT INTO review_findings(id,review_id,payload,team_id,status) VALUES($1,$2,$3,$4,$5)",
        [id, reviewId, JSON.stringify({ id, ruleId: rule.id, status, severity: "high", score: 90, title: "金额校验缺失",
          location: { path: "src/payment.ts", startLine: 1, endLine: 1 }, description: ruleBody }), DEFAULT_TEAM_ID, status]);
    }
  }

  async ageMining(): Promise<void> {
    await this.adminPool!.query("UPDATE rule_sync_state SET mined_at=now()-interval '15 days' WHERE repository_id=$1", [this.repositoryId]);
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    const close = async (operation: (() => Promise<unknown>) | undefined) => { try { await operation?.(); } catch (error) { errors.push(error); } };
    await close(this.app && (() => this.app!.close())); this.app = undefined;
    await close(this.pool && (() => this.pool!.end())); this.pool = undefined;
    await close(this.adminPool && (() => this.adminPool!.end())); this.adminPool = undefined;
    await close(this.gitlab && (() => this.gitlab.close()));
    const admin = new pg.Client({ connectionString: testServerUrl });
    try {
      await admin.connect();
      if (this.databaseCreated) { await admin.query(`DROP DATABASE ${this.databaseName} WITH (FORCE)`); this.databaseCreated = false; }
      if (this.roleCreated) { await admin.query(`DROP ROLE ${this.roleName}`); this.roleCreated = false; }
    } catch (error) { errors.push(error); } finally { await admin.end(); }
    if (errors.length) throw new AggregateError(errors, "规范场景清理失败");
  }
}
