import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { AgentSessionStore } from "../../packages/server/src/agent-sessions/store.js";
import { CollaborationService } from "../../packages/server/src/collaboration/service.js";
import { IdentityScenario, fixturePassword } from "../../packages/server/src/auth/test-support.js";
import { withTeam } from "../../packages/server/src/db/tenant.js";
import { buildApp } from "../../packages/server/src/http.js";
import { GitLabPlatform } from "../../packages/server/src/platform/gitlab.js";
import { GitLabConnector } from "../../packages/server/src/repositories/gitlab.js";
import { CredentialCipher } from "../../packages/server/src/repositories/credentials.js";
import { RepositoryService } from "../../packages/server/src/repositories/service.js";
import { ReviewService } from "../../packages/server/src/reviews/service.js";
import { ReviewStore } from "../../packages/server/src/reviews/store.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";
import { RuleCatalogService } from "../../packages/server/src/rules/catalog.js";
import { ManagedRuleService } from "../../packages/server/src/rules/managed.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer } from "../../packages/server/src/runtime/test-support.js";
import { lockPath, releasePath, startReviewGitLab } from "./review-gitlab-fixture.js";
import { fixtureFinding } from "./review-scenario.js";

export interface DetailRepository {
  id: string;
  automaticReviewEnabled: boolean;
  automaticReviewVersion: number;
  lastAuthenticationFailureAt: string | null;
}
export interface RepositoryEvent {
  id: string;
  receivedAt: string;
  eventType: string;
  action: string | null;
  iid: number | null;
  result: "queued" | "duplicate" | "ignored" | "failed";
  reason: string | null;
  reviewId: string | null;
  reviewRound: number | null;
}
export interface RepositoryEvents {
  webhook: { url: string; tokenConfigured: boolean; lastAuthenticationFailureAt: string | null };
  events: RepositoryEvent[];
}
export interface WebhookCheck {
  status: "configured" | "missing" | "merge_request_events_disabled" | "unreadable" | "unavailable";
  message: string;
  checkedAt: string;
}

/** 场景使用正式 HTTP、独立非特权数据库和 dsh，仅替换 GitLab 与模型协议。 */
export class RepositoryDetailScenario {
  readonly identity = new IdentityScenario();
  readonly publicOrigin = "http://repository.example.test";
  readonly webhookToken = "repository-detail-webhook-fixture";
  directory: string | undefined;
  gitlab: Awaited<ReturnType<typeof startReviewGitLab>> | undefined;
  model: Awaited<ReturnType<typeof startMockModelServer>> | undefined;
  host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
  app: FastifyInstance | undefined;
  reviews: ReviewService | undefined;
  baseUrl = "";
  cookie = "";
  memberCookie = "";
  teamId = "";
  repository!: DetailRepository;
  private stopped = false;

  async start(options: { deletion?: boolean } = {}): Promise<void> {
    try {
      await this.identity.start();
      const session = await this.identity.setup();
      this.cookie = this.identity.cookie;
      this.teamId = session.user!.teamId;
      this.directory = await mkdtemp(join(tmpdir(), "ureview-repository-detail-bdd-"));
      this.gitlab = await startReviewGitLab(join(this.directory, "gitlab"), "inventory-service");
      this.model = await startMockModelServer({ path: releasePath, startLine: 3, endLine: 4,
        candidates: [structuredClone(fixtureFinding)],
        discoveryCalls: [{ name: "read", input: { file_path: releasePath, offset: 3, limit: 2 } },
          { name: "read", input: { file_path: lockPath, offset: 3, limit: 1 } }],
        graderCalls: [{ name: "read", input: { file_path: releasePath, offset: 3, limit: 2 } },
          { name: "read", input: { file_path: lockPath, offset: 3, limit: 1 } }],
      });
      this.host = await bootReviewHost({ homeDir: join(this.directory, "dsh"), models: this.model.models,
        ...(options.deletion ? { sessionRecorder: new AgentSessionStore(this.identity.pool) } : {}),
        onReady: async (runtime) => {
          const repositories = new RepositoryService(this.identity.pool, new GitLabConnector(), new CredentialCipher(randomBytes(32)));
          const reviews = this.reviews = new ReviewService(new ReviewStore(this.identity.pool), repositories,
            (repository) => new GitLabPlatform(repository), runtime, join(this.directory!, "worktrees"),
            { pollIntervalMs: 25, retryDelayMs: 1000 });
          const app = this.app = buildApp({ pool: this.identity.pool, auth: this.identity.auth, repositories, reviews,
            ...(options.deletion ? {
              worktreeDir: join(this.directory!, "worktrees"),
              managedRules: new ManagedRuleService(this.identity.pool),
              catalog: new RuleCatalogService(this.identity.pool, repositories),
              collaboration: new CollaborationService(this.identity.pool, { cipher: new CredentialCipher(randomBytes(32)) }),
            } : {}),
            publicOrigin: this.publicOrigin, webhookToken: this.webhookToken });
          this.baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
          if (!options.deletion) withTeam(this.teamId, () => reviews.start());
          return async () => { await reviews.stop(); await app.close(); this.app = undefined; };
        } });
      const connected = await this.request<{ repository: DetailRepository }>("/api/repositories", this.gitlab.input);
      assert.equal(connected.status, 201, JSON.stringify(connected.body));
      this.repository = connected.body.repository;
      const member = await this.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "member" });
      assert.equal(member.status, 201);
      const login = await this.request("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
      assert.equal(login.status, 200);
      this.memberCookie = login.cookie;
    } catch (error) { await this.stop(); throw error; }
  }

  async request<T = unknown>(path: string, data?: object, options: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; cookie?: string; headers?: Record<string, string> } = {}): Promise<{ status: number; body: T; cookie: string }> {
    const response = await fetch(`${this.baseUrl}${path}`, { method: options.method ?? (data === undefined ? "GET" : "POST"),
      headers: { cookie: options.cookie ?? this.cookie, "x-ureview-request": "1", ...(data === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() as T, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
  }

  deliver(payload: object = this.gitlab!.event(), options: { deliveryId?: string; token?: string } = {}) {
    return this.request<{ reviewId?: string; created?: boolean; ignored?: boolean }>(`/api/repositories/${this.repository.id}/events/gitlab`, payload,
      { cookie: "", headers: { "x-gitlab-token": options.token ?? this.webhookToken,
        "x-gitlab-event": "Merge Request Hook", "webhook-id": options.deliveryId ?? randomUUID() } });
  }

  async events(cookie = this.cookie): Promise<RepositoryEvents> {
    const response = await this.request<RepositoryEvents>(`/api/repositories/${this.repository.id}/events`, undefined, { cookie });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }

  async databaseTime(): Promise<number> {
    const result = await this.identity.pool.query<{ time: Date }>("SELECT clock_timestamp() AS time");
    return result.rows[0]!.time.getTime();
  }

  async waitForReview(id: string): Promise<ReviewDetail> {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const response = await this.request<{ review: ReviewDetail }>(`/api/reviews/${id}`);
      assert.equal(response.status, 200);
      const review = response.body.review;
      assert.notEqual(review.status, "failed", review.failureReason ?? "评审失败");
      if (review.status === "completed") return review;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail("等待仓库评审完成超时");
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const errors: unknown[] = [];
    for (const dispose of [() => this.host?.dispose(), () => this.reviews?.stop(), () => this.app?.close(),
      () => this.model?.dispose(), () => this.gitlab?.dispose(), () => this.identity.stop(),
      () => this.directory ? rm(this.directory, { recursive: true, force: true }) : undefined]) {
      try { await dispose(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "仓库详情场景清理失败");
  }
}
