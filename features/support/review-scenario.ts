import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { AuthService } from "../../packages/server/src/auth/service.js";
import { ManagedRuleService } from "../../packages/server/src/rules/managed.js";
import type { ManagedRule } from "../../packages/server/src/rules/managed-types.js";
import { assertTenantRole, createTenantPool, DEFAULT_TEAM_ID, withTeam } from "../../packages/server/src/db/tenant.js";
import type { WebhookTransport } from "../../packages/server/src/collaboration/webhook.js";
import { CollaborationService } from "../../packages/server/src/collaboration/service.js";
import { RuleCatalogService } from "../../packages/server/src/rules/catalog.js";
import { runMigrations } from "../../packages/server/src/db/migrate.js";
import { buildApp } from "../../packages/server/src/http.js";
import { GitLabPlatform } from "../../packages/server/src/platform/gitlab.js";
import { CredentialCipher } from "../../packages/server/src/repositories/credentials.js";
import { GitLabConnector } from "../../packages/server/src/repositories/gitlab.js";
import { RepositoryService } from "../../packages/server/src/repositories/service.js";
import { JobSlots, ReviewService } from "../../packages/server/src/reviews/service.js";
import { ReviewStore } from "../../packages/server/src/reviews/store.js";
import { ReadingDocumentStore } from "../../packages/server/src/reviews/reading-document-store.js";
import type { ReadingDocumentRecord } from "../../packages/server/src/reviews/reading-document.js";
import { AgentSessionStore } from "../../packages/server/src/agent-sessions/store.js";
import type { ReviewDetail, ReviewFinding, ReviewSummary } from "../../packages/server/src/reviews/types.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer, type MockModelOptions, type MockPhase } from "../../packages/server/src/runtime/test-support.js";
import { testServerUrl } from "../../packages/server/src/test-support.js";
import { lockPath, releasePath, startReviewGitLab } from "./review-gitlab-fixture.js";

export const fixtureFinding = {
  title: "库存释放未加分布式锁",
  description: "并发处理同一个订单超时时可能重复恢复库存，需要在恢复库存前获取订单级锁。",
  severity: "high" as const,
  location: { path: releasePath, startLine: 3, endLine: 4 },
  evidence: [
    { path: releasePath, startLine: 3, endLine: 4, description: "库存恢复入口" },
    { path: lockPath, startLine: 3, endLine: 3, description: "仓库已有订单级锁入口" },
  ],
  fixPrompt: "在 ReleaseInventory 内获取订单级锁，再恢复库存，并覆盖同订单并发超时的测试。",
};

export class ReviewScenario {
  readonly databaseName = `ureview_review_bdd_${randomUUID().replaceAll("-", "")}`;
  eventId: string = randomUUID();
  readonly webhookToken = "review-webhook-fixture-secret";
  readonly modelOptions: MockModelOptions = {
    path: releasePath, startLine: 3, endLine: 4, grepPattern: "ReleaseInventory",
    candidates: [structuredClone(fixtureFinding)],
    beforeReply: async (phase) => { if (!this.heldPhase || phase === this.heldPhase) await this.modelGate; },
  };
  gitlab!: Awaited<ReturnType<typeof startReviewGitLab>>;
  model!: Awaited<ReturnType<typeof startMockModelServer>>;
  baseUrl = "";
  repositoryId = "";
  reviewId = "";
  observedReview: ReviewDetail | undefined;
  observedFinding: ReviewFinding | undefined;
  originalFinding: ReviewFinding | undefined;
  private directory: string | undefined;
  private databaseCreated = false;
  private roleCreated = false;
  private pool: pg.Pool | undefined;
  private readonly disconnected: Promise<void>[] = [];
  private host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
  private modelGate: Promise<void> | undefined;
  private releaseModel: (() => void) | undefined;
  private heldPhase: MockPhase | undefined;
  private stopped = false;
  private extraGitlabs: Array<Awaited<ReturnType<typeof startReviewGitLab>>> = [];
  private cookie = "";
  readonly globalRules = new Map<string, ManagedRule>();
  /** 后台任务的并发名额，场景可以在启动后调整上限。 */
  readonly slots = new JobSlots(1);

  async start(options: { webDir?: string; port?: number; publicOrigin?: string; disposition?: boolean; notifications?: { transport: WebhookTransport; retryDelayMs?: number } } = {}): Promise<void> {
    try {
      this.directory = await mkdtemp(join(tmpdir(), "ureview-review-bdd-"));
      const admin = new pg.Client({ connectionString: testServerUrl });
      try {
        await admin.connect();
        if (options.disposition) {
          await admin.query(`CREATE ROLE ${this.databaseName} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD 'review-fixture-password'`);
          this.roleCreated = true;
        }
        await admin.query(`CREATE DATABASE ${this.databaseName}${this.roleCreated ? ` OWNER ${this.databaseName}` : ""}`);
        this.databaseCreated = true;
      } finally { await admin.end(); }
      const databaseUrl = new URL(testServerUrl);
      databaseUrl.pathname = `/${this.databaseName}`;
      if (this.roleCreated) { databaseUrl.username = this.databaseName; databaseUrl.password = "review-fixture-password"; }
      const pool = this.pool = createTenantPool(databaseUrl.toString());
      pool.on("connect", (client) => { this.disconnected.push(new Promise<void>((resolve) => client.once("end", resolve))); });
      if (this.roleCreated) await assertTenantRole(pool);
      await runMigrations(pool, fileURLToPath(new URL("../../packages/server/migrations", import.meta.url)));
      this.gitlab = await startReviewGitLab(join(this.directory, "gitlab"));
      this.model = await startMockModelServer(this.modelOptions);
      this.host = await bootReviewHost({
        homeDir: join(this.directory, "dsh"), models: this.model.models,
        sessionRecorder: new AgentSessionStore(pool),
        onReady: async (runtime) => {
          const repositories = new RepositoryService(pool, new GitLabConnector(), new CredentialCipher(randomBytes(32)));
          const managedRules = new ManagedRuleService(pool);
          const documents = new ReadingDocumentStore(pool);
          const reviews = new ReviewService(new ReviewStore(pool), repositories,
            (repository) => new GitLabPlatform(repository), runtime, join(this.directory!, "worktrees"),
            { pollIntervalMs: 25, retryDelayMs: 1000, managedRules: (id) => managedRules.list(id), slots: this.slots, documents });
          const collaboration = options.disposition || options.notifications ? new CollaborationService(pool, {
            cipher: new CredentialCipher(randomBytes(32)), publicOrigin: "https://review.example.test",
            ...(options.notifications ? { webhookTransport: options.notifications.transport, retryDelayMs: options.notifications.retryDelayMs ?? 0 } : {}),
          }) : undefined;
          const app = buildApp({ pool, repositories, reviews, managedRules, auth: new AuthService(pool, "review-setup-token"), webhookToken: this.webhookToken,
            readingDocuments: documents,
            ...(collaboration ? { collaboration, catalog: new RuleCatalogService(pool, repositories) } : {}),
            ...(options.webDir ? { webDir: options.webDir } : {}), ...(options.publicOrigin ? { publicOrigin: options.publicOrigin } : {}) });
          try {
            this.baseUrl = await app.listen({ host: "127.0.0.1", port: options.port ?? 0 });
            await this.request("/api/auth/setup", { token: "review-setup-token", name: "张伟", username: "zhangwei", email: "zhangwei@example.test", password: "fixture-password-long" });
            withTeam(DEFAULT_TEAM_ID, () => reviews.start());
            if (options.notifications) collaboration?.start();
          } catch (error) { await app.close(); throw error; }
          return async () => {
            await collaboration?.stop();
            await reviews.stop();
            await app.close();
          };
        },
      });
    } catch (error) {
      try { await this.stop(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], "评审场景启动和清理失败"); }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.releaseModel?.();
    const errors: unknown[] = [];
    const cleanup = async (dispose: (() => Promise<unknown>) | undefined) => {
      try { await dispose?.(); } catch (error) { errors.push(error); }
    };
    const host = this.host;
    this.host = undefined;
    await cleanup(host && (() => host.dispose()));
    await cleanup(this.model && (() => this.model.dispose()));
    await cleanup(this.gitlab && (() => this.gitlab.dispose()));
    for (const gitlab of this.extraGitlabs) await cleanup(() => gitlab.dispose());
    const pool = this.pool;
    this.pool = undefined;
    await cleanup(pool && (async () => {
      await pool.end();
      // 连接池清空后，空闲连接的 TCP 关闭仍可能在途；删库前等待每条连接真正断开。
      await Promise.all(this.disconnected);
    }));
    if (this.databaseCreated || this.roleCreated) {
      const admin = new pg.Client({ connectionString: testServerUrl });
      try {
        await admin.connect();
        if (this.databaseCreated) { await admin.query(`DROP DATABASE ${this.databaseName} WITH (FORCE)`); this.databaseCreated = false; }
        if (this.roleCreated) { await admin.query(`DROP ROLE ${this.databaseName}`); this.roleCreated = false; }
      } catch (error) { errors.push(error); }
      finally { await cleanup(() => admin.end()); }
    }
    const directory = this.directory;
    this.directory = undefined;
    await cleanup(directory ? () => rm(directory, { recursive: true, force: true }) : undefined);
    if (errors.length) throw new AggregateError(errors, "清理评审场景资源失败");
  }

  holdModel(phase?: MockPhase): void {
    this.heldPhase = phase;
    this.modelGate = new Promise((resolve) => { this.releaseModel = resolve; });
  }

  resumeModel(): void { this.releaseModel?.(); this.modelGate = undefined; this.heldPhase = undefined; }

  async addRepository(name: string) {
    assert.ok(this.directory);
    const gitlab = await startReviewGitLab(join(this.directory, name), name);
    this.extraGitlabs.push(gitlab);
    const response = await this.request<{ repository: { id: string } }>("/api/repositories", gitlab.input);
    assert.equal(response.status, 201);
    return { gitlab, repositoryId: response.body.repository.id };
  }

  async saveGlobalRule(name: string, body: string): Promise<ManagedRule> {
    const previous = this.globalRules.get(name);
    const input = { name, body, goodExample: "", badExample: "", category: "correctness", severity: "error",
      scope: "global", repositories: [], status: "active", ...(previous ? { version: previous.version } : {}) };
    const response = await this.request<{ rule: ManagedRule }>(previous ? `/api/managed-rules/${previous.id}` : "/api/managed-rules",
      input, {}, previous ? "PUT" : "POST");
    assert.equal(response.status, previous ? 200 : 201);
    this.globalRules.set(name, response.body.rule);
    return response.body.rule;
  }

  async connect(name: string): Promise<void> {
    assert.equal(name, "payment-gateway");
    if (this.repositoryId) return;
    const response = await this.request<{ repository: { id: string; name: string } }>("/api/repositories", this.gitlab.input);
    assert.equal(response.status, 201);
    assert.equal(response.body.repository.name, name);
    this.repositoryId = response.body.repository.id;
  }

  async openPullRequest(author: string, title: string): Promise<void> {
    await this.connect("payment-gateway");
    this.gitlab.state.title = title;
    this.gitlab.state.authorName = author;
    const response = await this.deliverEvent();
    assert.equal(response.status, 202);
    assert.equal(response.body.created, true);
    assert.ok(response.body.reviewId);
    this.reviewId = response.body.reviewId;
  }

  deliverEvent() {
    return this.request<{ reviewId: string; created: boolean }>(
      `/api/repositories/${this.repositoryId}/events/gitlab`, this.gitlab.event(), {
        "x-gitlab-token": this.webhookToken, "x-gitlab-event": "Merge Request Hook", "webhook-id": this.eventId,
      },
    );
  }

  async readReview(): Promise<ReviewDetail> {
    assert.ok(this.reviewId, "尚未通过 webhook 产生评审");
    const response = await this.request<{ review: ReviewDetail }>(`/api/reviews/${this.reviewId}`);
    assert.equal(response.status, 200);
    return this.observedReview = response.body.review;
  }

  async readingDocuments(): Promise<ReadingDocumentRecord[]> {
    const response = await this.request<{ documents: ReadingDocumentRecord[] }>(`/api/reviews/${this.reviewId}/reading-documents`);
    assert.equal(response.status, 200);
    return response.body.documents;
  }

  /** 等本轮最新一份解读结束；失败时不报错，由调用方断言。 */
  async waitForReading(): Promise<ReadingDocumentRecord> {
    const deadline = Date.now() + 25_000;
    do {
      const latest = (await this.readingDocuments())[0];
      if (latest && (latest.status === "completed" || latest.status === "failed")) return latest;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.fail("等待解读结束超时");
  }

  async databaseTime(): Promise<number> {
    assert.ok(this.pool);
    const result = await this.pool.query<{ time: Date }>("SELECT clock_timestamp() AS time");
    return result.rows[0]!.time.getTime();
  }

  async listReviews(): Promise<ReviewSummary[]> {
    const response = await this.request<{ reviews: ReviewSummary[] }>(`/api/repositories/${this.repositoryId}/reviews`);
    assert.equal(response.status, 200);
    return response.body.reviews;
  }

  async waitForReview(predicate: (review: ReviewDetail) => boolean): Promise<ReviewDetail> {
    const deadline = Date.now() + 25_000;
    do {
      const review = await this.readReview();
      if (predicate(review)) return review;
      if (review.status === "failed") assert.fail(`评审失败：${review.failureReason}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.fail(`等待评审状态超时：${JSON.stringify(this.observedReview)}`);
  }

  async request<T>(path: string, body?: object, headers: Record<string, string> = {}, method = body === undefined ? "GET" : "POST"): Promise<{ status: number; body: T }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method, headers: { cookie: this.cookie, "x-ureview-request": "1", "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookie = response.headers.get("set-cookie"); if (cookie) this.cookie = cookie.split(";")[0]!;
    return { status: response.status, body: await response.json() as T };
  }
}
