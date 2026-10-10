import type { AppliedLibrarySet, LibrarySummary } from "../library-types.js";
import type { ImportGenerator } from "../../runtime/import-generator.js";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { IdentityScenario, fixturePassword, fixtureRepository } from "../../auth/test-support.js";
import type { SessionView } from "../../auth/service.js";
import { buildApp } from "../../http.js";
import { withTeam } from "../../db/tenant.js";
import { CredentialCipher } from "../../repositories/credentials.js";
import type { RepositoryConnector } from "../../repositories/connector.js";
import { RepositoryService } from "../../repositories/service.js";
import { ReadingDocumentStore } from "../../reviews/reading-document-store.js";
import { ReviewService } from "../../reviews/service.js";
import { ReviewStore } from "../../reviews/store.js";
import { ReviewSettingsService } from "../../reviews/settings.js";
import type { PlatformFactory, ReviewRuntime } from "../../reviews/types.js";
import { loadRuleLibrary, type RuleLibraryService } from "../library.js";
import { RuleCatalogService } from "../catalog.js";
import { ManagedRuleService } from "../managed.js";
import type { GeneratedRuleDraft, ManagedRule, ManagedRuleInput, RuleDraftGenerator } from "../managed-types.js";
import type { RuleConversationGenerator } from "../sessions-types.js";

export const managedDraft: GeneratedRuleDraft = {
  name: "金额使用整数分", body: "金额以整数分存储和计算，禁止使用浮点数表示交易金额。",
  goodExample: "const amountCents = 100;", badExample: "const amount = 1.00;", category: "correctness", severity: "error", judgement: false, layer: "team", languages: [],
};
export const managedInput: ManagedRuleInput = { ...managedDraft, overrides: [], scope: "global", repositories: [], status: "draft" };

/** 登录、团队和数据使用真实 HTTP 与非特权 PostgreSQL；允许接入真实 dsh 运行时。 */
export class ManagedRuleScenario {
  readonly identity = new IdentityScenario();
  pool!: pg.Pool;
  repositories!: RepositoryService;
  reviews!: ReviewService;
  managed!: ManagedRuleService;
  app: FastifyInstance | undefined;
  baseUrl = "";
  cookie = "";
  memberCookie = "";
  teamId = "";
  userId = "";
  repositoryId = "";
  private directory: string | undefined;

  async start(options: { importGenerator?: ImportGenerator; webDir?: string; port?: number; publicOrigin?: string; library?: (pool: pg.Pool) => RuleLibraryService; generator?: RuleDraftGenerator; conversationGenerator?: RuleConversationGenerator; runtime?: ReviewRuntime; worktreeDir?: string; platforms?: PlatformFactory; connector?: RepositoryConnector } = {}): Promise<void> {
    try {
      await this.identity.start();
      const session = await this.identity.setup();
      this.pool = this.identity.pool;
      this.cookie = this.identity.cookie;
      this.teamId = session.user!.teamId;
      this.userId = session.user!.userId;
      let projectNumber = 40;
      const projects = new Map<string, number>();
      const connector: RepositoryConnector = options.connector ?? { verify: async (input) => {
        const projectId = projects.get(input.projectPath) ?? ++projectNumber;
        projects.set(input.projectPath, projectId);
        return { instanceUrl: input.instanceUrl, projectId, name: input.projectPath.split("/").at(-1)!, pathWithNamespace: input.projectPath,
          webUrl: `${input.instanceUrl}/${input.projectPath}`, httpUrlToRepo: `${input.instanceUrl}/${input.projectPath}.git` };
      } };
      this.repositories = new RepositoryService(this.pool, connector, new CredentialCipher(randomBytes(32)));
      this.managed = new ManagedRuleService(this.pool);
      const worktreeDir = options.worktreeDir ?? (this.directory = await mkdtemp(join(tmpdir(), "ureview-managed-")));
      this.reviews = new ReviewService(new ReviewStore(this.pool), this.repositories,
        options.platforms ?? (() => { throw new Error("规范接口用例不会读取代码平台"); }),
        options.runtime ?? { review: async () => { throw new Error("规范接口用例不会执行评审"); } }, worktreeDir,
        { managedRules: () => this.managed.list(), ...(options.runtime ? { documents: new ReadingDocumentStore(this.pool) } : {}),
          excludedDirectories: async (repositoryId) => (await new ReviewSettingsService(this.pool).get(repositoryId)).excludedDirectories });
      this.app = buildApp({ ...(options.importGenerator ? { importGenerator: options.importGenerator, startImportWorker: true } : {}), ...(options.webDir ? { webDir: options.webDir, catalog: new RuleCatalogService(this.pool, this.repositories) } : {}), pool: this.pool, auth: this.identity.auth, repositories: this.repositories, reviews: this.reviews,
        managedRules: this.managed, ...(options.library ? { ruleLibrary: options.library(this.pool) } : {}), ...(options.generator ? { ruleGenerator: options.generator } : {}),
        ...(options.conversationGenerator ? { ruleConversationGenerator: options.conversationGenerator } : {}), publicOrigin: options.publicOrigin ?? "http://identity.example.test" });
      this.baseUrl = await this.app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
      const connected = await this.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
      if (connected.status !== 201) throw new Error("测试仓库接入失败");
      this.repositoryId = connected.body.repository.id;
      const member = await this.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "member" });
      if (member.status !== 201) throw new Error("测试成员创建失败");
      const login = await this.request("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
      if (login.status !== 200 || !login.cookie) throw new Error("测试成员登录失败");
      this.memberCookie = login.cookie;
    } catch (error) { await this.stop(); throw error; }
  }

  async readLibrary(query = "", options: { cookie?: string } = {}) {
    const response = await this.request<{ sets: LibrarySummary[] }>(`/api/rule-library${query}`, undefined, options);
    const sets = await Promise.all(response.body.sets.map(async (set): Promise<AppliedLibrarySet> => ({ ...set,
      entries: (await this.request<{ entries: AppliedLibrarySet["entries"] }>(`/api/rule-library/${set.id}/entries`, undefined, options)).body.entries })));
    return { ...response, body: { sets } };
  }

  async request<T = unknown>(path: string, data?: object, options: { method?: "GET" | "POST" | "PUT" | "DELETE"; cookie?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; cookie: string }> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: options.method ?? (data === undefined ? "GET" : "POST"),
      headers: { cookie: options.cookie ?? this.cookie, "x-ureview-request": "1", ...(data === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() as T, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  async otherTeam(): Promise<{ teamId: string; cookie: string; repositoryId: string }> {
    const team = await this.request<{ id: string }>("/api/admin/teams", { name: "物流研发团队" });
    if (team.status !== 201) throw new Error("测试团队创建失败");
    const login = await this.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" });
    const session = await this.request<SessionView>("/api/auth/team", { teamId: team.body.id }, { cookie: login.cookie });
    if (session.status !== 200) throw new Error("测试团队切换失败");
    const repository = await this.request<{ repository: { id: string } }>("/api/repositories", { ...fixtureRepository, projectPath: "logistics/dispatch-service" }, { cookie: login.cookie });
    if (repository.status !== 201) throw new Error("另一团队仓库接入失败");
    return { teamId: team.body.id, cookie: login.cookie, repositoryId: repository.body.repository.id };
  }

  async seedLegacyLibraryDraft(setId: string, entryId: string): Promise<ManagedRule> {
    const set = (await loadRuleLibrary()).find((set) => set.id === setId);
    const entry = set?.entries.find((entry) => entry.id === entryId);
    if (!set || !entry) throw new Error("历史规范库草稿样本不存在");
    const created = await this.request<{ rule: ManagedRule }>("/api/managed-rules", {
      name: entry.title, body: entry.body, goodExample: entry.goodExample, badExample: entry.badExample,
      category: entry.category, severity: entry.severity, judgement: entry.judgement ?? set.judgement ?? false,
      layer: set.layer, languages: set.languages, overrides: [], scope: "global", repositories: [], status: "draft",
    });
    if (created.status !== 201) throw new Error("历史规范库草稿样本创建失败");
    const librarySource = { setId, entryId, version: "2026.10.0", body: entry.body,
      judgement: created.body.rule.judgement, exampleLanguage: entry.exampleLanguage };
    await withTeam(this.teamId, () => this.pool.query(`WITH linked AS (
      UPDATE managed_rules SET library_source=$2 WHERE id=$1 RETURNING id
    ) UPDATE rule_proposals proposal SET source='library' FROM linked WHERE proposal.managed_rule_id=linked.id`,
    [created.body.rule.id, JSON.stringify(librarySource)]));
    return { ...created.body.rule, librarySource };
  }

  async stop(): Promise<void> {
    await this.reviews?.stop();
    await this.app?.close();
    this.app = undefined;
    if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = undefined; }
    await this.identity.stop();
  }
}
