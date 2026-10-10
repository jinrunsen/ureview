import { RuleCatalogService } from "../rules/catalog.js";
import { ManagedRuleService } from "../rules/managed.js";
import { SsoConfiguration } from "./sso-config.js";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { migrate } from "../db/migrate.js";
import { assertTenantRole, createTenantPool } from "../db/tenant.js";
import { buildApp } from "../http.js";
import { CredentialCipher } from "../repositories/credentials.js";
import { RepositoryService } from "../repositories/service.js";
import type { RepositoryConnector } from "../repositories/connector.js";
import { ReviewService } from "../reviews/service.js";
import { ReviewStore } from "../reviews/store.js";
import { testServerUrl } from "../test-support.js";
import { AuthService, type SessionView } from "./service.js";

import { ServiceSettings } from "../service-settings/service.js";
import type { ModelProbe } from "../runtime/model-probe.js";

export const fixturePassword = "Sichuan-Chengdu-2026!";
export const fixtureRepository = { instanceUrl: "https://gitlab.example.test", projectPath: "commerce/inventory-service", token: "fixture-readonly" };

/** 每个实例有独立数据库和真正无绕过权限的 owner 角色。 */
export class IdentityScenario {
  constructor(private readonly options: { webDir?: string; port?: number; publicOrigin?: string;
    serviceEnvironment?: NodeJS.ProcessEnv; modelProbe?: ModelProbe } = {}) {}
  private readonly suffix = randomUUID().replaceAll("-", "");
  private readonly databaseName = `ureview_identity_${this.suffix}`;
  private readonly roleName = `ureview_identity_${this.suffix}`;
  private readonly rolePassword = randomBytes(24).toString("hex");
  readonly setupToken = randomBytes(32).toString("base64url");
  private createdRole = false;
  private createdDatabase = false;
  pool!: pg.Pool;
  auth!: AuthService;
  serviceSettings!: ServiceSettings;
  app: FastifyInstance | undefined;
  baseUrl = "";
  cookie = "";

  async start(): Promise<void> {
    const admin = new pg.Client({ connectionString: testServerUrl });
    try {
      await admin.connect();
      await admin.query(`CREATE ROLE ${this.roleName} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${this.rolePassword}'`);
      this.createdRole = true;
      await admin.query(`CREATE DATABASE ${this.databaseName} OWNER ${this.roleName}`);
      this.createdDatabase = true;
      const url = new URL(testServerUrl);
      url.pathname = `/${this.databaseName}`;
      url.username = this.roleName;
      url.password = this.rolePassword;
      this.pool = createTenantPool(url.toString(), 2);
      await assertTenantRole(this.pool);
      await migrate(this.pool, fileURLToPath(new URL("../../migrations/", import.meta.url)));
      this.auth = new AuthService(this.pool, this.setupToken);
      const connector: RepositoryConnector = { verify: async (input) => ({
        instanceUrl: input.instanceUrl, projectId: 42, name: "inventory-service", pathWithNamespace: input.projectPath,
        webUrl: `${input.instanceUrl}/${input.projectPath}`, httpUrlToRepo: `${input.instanceUrl}/${input.projectPath}.git`,
      }) };
      const cipher = new CredentialCipher(randomBytes(32));
      const repositories = new RepositoryService(this.pool, connector, cipher);
      this.serviceSettings = new ServiceSettings(this.pool, cipher, this.options.serviceEnvironment ?? {}, this.options.modelProbe);
      const reviews = new ReviewService(new ReviewStore(this.pool), repositories, () => { throw new Error("认证用例不会读取代码平台"); },
        { review: async () => { throw new Error("认证用例不会调用模型"); } }, "/tmp/ureview-identity-unused");
      this.app = buildApp({ ...(this.options.webDir ? { webDir: this.options.webDir, catalog: new RuleCatalogService(this.pool, repositories), managedRules: new ManagedRuleService(this.pool) } : {}), ssoConfiguration: new SsoConfiguration(this.pool, cipher, this.options.publicOrigin ?? "http://identity.example.test"), pool: this.pool, auth: this.auth, serviceSettings: this.serviceSettings, repositories, reviews, publicOrigin: this.options.publicOrigin ?? "http://identity.example.test", webhookToken: "fixture-webhook" });
      this.baseUrl = await this.app.listen({ host: "127.0.0.1", port: this.options.port ?? 0 });
    } catch (error) { await this.stop(); throw error; }
    finally { await admin.end(); }
  }

  async request<T = unknown>(path: string, data?: object, options: { method?: string; cookie?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; cookie: string }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? (data === undefined ? "GET" : "POST"),
      headers: { cookie: options.cookie ?? this.cookie, "x-ureview-request": "1", ...(data ? { "content-type": "application/json" } : {}), ...options.headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json() as T, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  async setup(): Promise<SessionView> {
    const result = await this.request<SessionView>("/api/auth/setup", { token: this.setupToken, username: "zhang.wei", email: "zhang.wei@example.test", name: "张伟", password: fixturePassword });
    if (result.status !== 200 || !result.body.user) throw new Error("初始化管理员失败");
    this.cookie = result.cookie;
    return result.body;
  }

  async stop(): Promise<void> {
    await this.app?.close();
    this.app = undefined;
    await this.pool?.end();
    const admin = new pg.Client({ connectionString: testServerUrl });
    try {
      await admin.connect();
      if (this.createdDatabase) { await admin.query(`DROP DATABASE ${this.databaseName} WITH (FORCE)`); this.createdDatabase = false; }
      if (this.createdRole) { await admin.query(`DROP ROLE ${this.roleName}`); this.createdRole = false; }
    } finally { await admin.end(); }
  }
}
