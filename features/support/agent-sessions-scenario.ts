import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IdentityScenario, fixtureRepository } from "../../packages/server/src/auth/test-support.js";
import { withTeam } from "../../packages/server/src/db/tenant.js";
import { buildApp } from "../../packages/server/src/http.js";
import { CredentialCipher } from "../../packages/server/src/repositories/credentials.js";
import { RepositoryService } from "../../packages/server/src/repositories/service.js";
import { ReviewService } from "../../packages/server/src/reviews/service.js";
import { ReviewStore } from "../../packages/server/src/reviews/store.js";
import type { PlatformPort, ReviewDetail } from "../../packages/server/src/reviews/types.js";
import { ManagedRuleService } from "../../packages/server/src/rules/managed.js";
import { AgentSessionStore } from "../../packages/server/src/agent-sessions/store.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer, type MockModelOptions } from "../../packages/server/src/runtime/test-support.js";

/** 正式 dsh、非特权 PostgreSQL 和 HTTP；只替换模型与代码平台。 */
export class AgentSessionsScenario {
  readonly identity = new IdentityScenario();
  readonly modelOptions: MockModelOptions = {};
  readonly cipher = new CredentialCipher(randomBytes(32));
  model: Awaited<ReturnType<typeof startMockModelServer>> | undefined;
  host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
  private directory = "";
  teamId = "";
  repositoryId = "";
  private webPort: number | undefined;
  private gateRelease: (() => void) | undefined;

  async start(webPort?: number): Promise<void> {
    this.webPort = webPort;
    this.directory = await mkdtemp(join(tmpdir(), "ureview-sessions-"));
    await this.identity.start();
    const initial = await this.identity.setup();
    this.teamId = initial.user!.teamId;
    await this.identity.app!.close();
    this.identity.app = undefined;
    this.model = await startMockModelServer(this.modelOptions);
    await this.boot();
    const connected = await this.identity.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    assert.equal(connected.status, 201);
    this.repositoryId = connected.body.repository.id;
  }

  private async boot(): Promise<void> {
    const pool = this.identity.pool;
    const platform: PlatformPort = {
      onEvent: () => null,
      getPullRequest: async (iid) => ({ iid, title: "扣款金额校验", description: "检查金额为正数", author: "张伟",
        webUrl: `https://gitlab.example.test/commerce/inventory-service/-/merge_requests/${iid}`,
        sourceBranch: "fix/payment", targetBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40), startSha: "b".repeat(40) }),
      getDiff: async () => [{ oldPath: "src/payment.ts", newPath: "src/payment.ts", patch: "@@ -1,3 +1,3 @@\n export function pay(amount: number) {\n-  return amount;\n+  return amount - 1;\n }", newFile: false, deletedFile: false, renamedFile: false }],
      getFileContent: async () => { throw new Error("样例没有远程规范文件"); },
      getGroupingSignals: async () => ({ labels: [] }),
      getCommits: async () => [],
      getClosingIssues: async () => [],
      cloneOrUpdate: async (_pr, directory) => {
        await mkdir(join(directory, "src"), { recursive: true });
        await writeFile(join(directory, "src/payment.ts"), "export function pay(amount: number) {\n  return amount - 1;\n}\n");
        return directory;
      },
    };
    this.host = await bootReviewHost({ homeDir: join(this.directory, "dsh"), models: this.model!.models,
      sessionRecorder: new AgentSessionStore(pool), onReady: async (runtime, generator) => {
        const repositories = new RepositoryService(pool, { verify: async (input) => ({ instanceUrl: input.instanceUrl, projectId: 42,
          name: "inventory-service", pathWithNamespace: input.projectPath, webUrl: `${input.instanceUrl}/${input.projectPath}`,
          httpUrlToRepo: `${input.instanceUrl}/${input.projectPath}.git` }) }, this.cipher);
        const managedRules = new ManagedRuleService(pool);
        const reviews = new ReviewService(new ReviewStore(pool), repositories, () => platform, runtime, join(this.directory, "worktrees"),
          { pollIntervalMs: 20, managedRules: (id) => managedRules.list(id) });
        const app = this.identity.app = buildApp({ pool, repositories, reviews, managedRules, auth: this.identity.auth,
          ruleConversationGenerator: generator, ...(this.webPort ? {
            webDir: fileURLToPath(new URL("../../packages/web/dist", import.meta.url)),
            sessionViewerDir: fileURLToPath(new URL("../../packages/session-viewer/dist", import.meta.url)),
            publicOrigin: `http://127.0.0.1:${this.webPort}`,
          } : {}) });
        this.identity.baseUrl = await app.listen({ host: "127.0.0.1", port: this.webPort ?? 0 });
        withTeam(this.teamId, () => reviews.start());
        return async () => { await reviews.stop(); await app.close(); this.identity.app = undefined; };
      } });
  }

  pauseModel(): void {
    const gate = new Promise<void>((resolve) => { this.gateRelease = resolve; });
    this.modelOptions.beforeReply = () => gate;
  }
  resumeModel(): void { this.gateRelease?.(); this.gateRelease = undefined; delete this.modelOptions.beforeReply; }

  async review(): Promise<string> {
    const result = await this.identity.request<{ id: string }>("/api/reviews", {
      url: "https://gitlab.example.test/commerce/inventory-service/-/merge_requests/7", requestId: randomUUID(),
    });
    assert.equal(result.status, 202);
    return result.body.id;
  }

  async waitForReview(id: string): Promise<ReviewDetail> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await this.identity.request<{ review: ReviewDetail }>(`/api/reviews/${id}`);
      if (["completed", "failed"].includes(result.body.review.status)) return result.body.review;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("评审未按时结束");
  }

  async restart(): Promise<void> { await this.host?.dispose(); this.host = undefined; await this.boot(); }
  async stop(): Promise<void> {
    this.resumeModel();
    try { await this.host?.dispose(); }
    finally { try { await this.model?.dispose(); } finally { await this.identity.stop(); if (this.directory) await rm(this.directory, { recursive: true, force: true }); } }
  }
}
