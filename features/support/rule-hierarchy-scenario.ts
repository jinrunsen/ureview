import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTeam } from "../../packages/server/src/db/tenant.js";
import { GitLabPlatform } from "../../packages/server/src/platform/gitlab.js";
import { GitLabConnector } from "../../packages/server/src/repositories/gitlab.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";
import type { GeneratedRuleDraft, ManagedRule, ManagedRuleInput } from "../../packages/server/src/rules/managed-types.js";
import { ManagedRuleScenario } from "../../packages/server/src/rules/managed/test-support.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer, type MockModelOptions } from "../../packages/server/src/runtime/test-support.js";
import { releasePath, startReviewGitLab } from "./review-gitlab-fixture.js";
import { RuleCatalogScenario } from "./rule-catalog-scenario.js";

export const hierarchyDraft: GeneratedRuleDraft = {
  name: "Go 并发入口传递取消信号", body: "Go 并发任务接收调用方的取消信号并在取消后释放资源。",
  goodExample: "select { case <-ctx.Done(): return }", badExample: "for { process() }",
  category: "reliability", severity: "error", judgement: false, layer: "language", languages: ["go"],
};

export class RuleHierarchyScenario {
  readonly app = new ManagedRuleScenario();
  readonly options: MockModelOptions = { path: releasePath, startLine: 3, endLine: 4,
    grepPattern: "ReleaseInventory", candidates: [], ruleDraft: hierarchyDraft };
  readonly rules = new Map<string, ManagedRule>();
  private directory = "";
  private host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
  private extraGitlabs: Array<Awaited<ReturnType<typeof startReviewGitLab>>> = [];
  gitlab: Awaited<ReturnType<typeof startReviewGitLab>> | undefined;
  model: Awaited<ReturnType<typeof startMockModelServer>> | undefined;
  catalog: RuleCatalogScenario | undefined;
  repositoryId = "";

  async start(path = releasePath): Promise<void> {
    if (this.directory) return;
    this.directory = await mkdtemp(join(tmpdir(), "ureview-hierarchy-bdd-"));
    this.options.path = path;
    this.options.startLine = path === releasePath ? 3 : 1;
    this.options.endLine = path === releasePath ? 4 : 2;
    this.gitlab = await startReviewGitLab(join(this.directory, "gitlab"));
    this.model = await startMockModelServer(this.options);
    this.host = await bootReviewHost({ homeDir: join(this.directory, "dsh"), models: this.model.models,
      onReady: async (runtime, generator) => {
        await this.app.start({ runtime, generator: generator.generate.bind(generator),
          worktreeDir: join(this.directory, "worktrees"), platforms: (repository) => new GitLabPlatform(repository),
          connector: { verify: (input) => input.instanceUrl === "https://gitlab.example.test"
            ? Promise.resolve({ instanceUrl: input.instanceUrl, projectId: 41, name: "inventory-service",
              pathWithNamespace: input.projectPath, webUrl: `${input.instanceUrl}/${input.projectPath}`,
              httpUrlToRepo: `${input.instanceUrl}/${input.projectPath}.git` })
            : new GitLabConnector().verify(input) } });
        return () => this.app.stop();
      } });
    this.repositoryId = await this.connect(this.gitlab);
  }

  private async connect(gitlab: Awaited<ReturnType<typeof startReviewGitLab>>): Promise<string> {
    const response = await this.app.request<{ repository: { id: string } }>("/api/repositories", gitlab.input);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.repository.id;
  }

  async addRepository() {
    const gitlab = await startReviewGitLab(join(this.directory, "settlement"), "settlement-service");
    this.extraGitlabs.push(gitlab);
    return { gitlab, repositoryId: await this.connect(gitlab) };
  }

  async create(key: string, input: Partial<ManagedRuleInput> = {}): Promise<ManagedRule> {
    const response = await this.app.request<{ rule: ManagedRule }>("/api/managed-rules", {
      name: key, body: `${key}的规范正文。`, goodExample: "", badExample: "", category: "reliability", severity: "error",
      scope: "global", repositories: [], status: "active", ...input,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    this.rules.set(key, response.body.rule);
    return response.body.rule;
  }

  async review(gitlab = this.gitlab!, repositoryId = this.repositoryId): Promise<ReviewDetail> {
    assert.ok(gitlab);
    const response = await this.app.request<{ id: string }>("/api/reviews", {
      url: `${gitlab.baseUrl}/${gitlab.repositoryPath}/-/merge_requests/${gitlab.iid}`, requestId: randomUUID(),
    });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    assert.equal(await withTeam(this.app.teamId, () => this.app.reviews.runOnce()), true);
    const result = await this.app.request<{ review: ReviewDetail }>(`/api/reviews/${response.body.id}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.review.repositoryId, repositoryId);
    assert.deepEqual(this.model!.scriptErrors, [], "正式 dsh 的工具回执应符合模型脚本预期");
    assert.equal(result.body.review.status, "completed", result.body.review.failureReason ?? "评审未完成");
    return result.body.review;
  }

  async prepareCatalog(files: Record<string, string>): Promise<void> {
    this.options.graderCalls = [{ name: "read", input: { file_path: releasePath, offset: 3, limit: 2 } }];
    this.catalog = new RuleCatalogScenario();
    await this.catalog.start();
    this.catalog.gitlab.state.files = files;
    await this.gitlab!.commitFiles(files);
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    for (const close of [() => this.host ? this.host.dispose() : this.app.stop(),
      () => this.model?.dispose(), () => this.gitlab?.dispose(),
      ...this.extraGitlabs.map((gitlab) => () => gitlab.dispose()), () => this.catalog?.stop(),
      () => this.directory ? rm(this.directory, { recursive: true, force: true }) : undefined]) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "规范层级场景清理失败");
  }
}
