import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { startReviewGitLab, lockPath, releaseCode, releasePath } from "../support/review-gitlab-fixture.js";
import { fixtureFinding } from "../support/review-scenario.js";
import { ManagedRuleScenario } from "../../packages/server/src/rules/managed/test-support.js";
import { GitLabPlatform } from "../../packages/server/src/platform/gitlab.js";
import { withTeam } from "../../packages/server/src/db/tenant.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer, type MockModelOptions } from "../../packages/server/src/runtime/test-support.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";
import type { ReviewSettings } from "../../packages/server/src/reviews/settings.js";

const testPath = "features/steps/inventory.go";
const testSentinel = "EXCLUDED_INVENTORY_STEP_CONTEXT_6f09";
const testCode = `package steps\n\nfunc ReleaseInventoryScenario() { println("${testSentinel}") }\n`;
const discoveryCalls = [
  { name: "glob", input: { pattern: "**/*" } },
  { name: "grep", input: { pattern: "ReleaseInventory" } },
  { name: "read", input: { file_path: testPath, offset: 1, limit: 10 } },
  { name: "read", input: { file_path: releasePath, offset: 3, limit: 2 } },
  { name: "read", input: { file_path: lockPath, offset: 3, limit: 1 } },
];
interface State {
  app: ManagedRuleScenario;
  directory: string;
  model?: Awaited<ReturnType<typeof startMockModelServer>>;
  host?: Awaited<ReturnType<typeof bootReviewHost>>;
  gitlab?: Awaited<ReturnType<typeof startReviewGitLab>>;
  repositoryId?: string;
  orderGitlab?: Awaited<ReturnType<typeof startReviewGitLab>>;
  orderRepositoryId?: string;
  orderReview?: ReviewDetail;
  orderRequestStart?: number;
  review?: ReviewDetail;
  latestReview?: ReviewDetail;
}
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State { const value = states.get(world); assert.ok(value); return value; }

Before({ tags: "@layer:api and @story:review-exclusions", timeout: 60_000 }, async function (this: ApiWorld) {
  const value: State = { app: new ManagedRuleScenario(), directory: await mkdtemp(join(tmpdir(), "ureview-exclusions-bdd-")) };
  states.set(this, value);
  value.gitlab = await startReviewGitLab(join(value.directory, "gitlab"), "inventory-service");
  const options: MockModelOptions = { path: releasePath, startLine: 3, endLine: 4,
    candidates: [structuredClone(fixtureFinding)], discoveryCalls, graderCalls: discoveryCalls };
  value.model = await startMockModelServer(options);
  value.host = await bootReviewHost({ homeDir: join(value.directory, "dsh"), models: value.model.models,
    onReady: async (runtime) => {
      await value.app.start({ runtime, worktreeDir: join(value.directory, "worktrees"), platforms: (repository) => new GitLabPlatform(repository),
        connector: { verify: async (input) => ({ instanceUrl: input.instanceUrl, projectId: 42,
          name: input.projectPath.split("/").at(-1)!, pathWithNamespace: input.projectPath,
          webUrl: `${input.instanceUrl}/${input.projectPath}`, httpUrlToRepo: `${input.instanceUrl}/${input.projectPath}.git` }) } });
      return () => value.app.stop();
    } });
});
After({ tags: "@layer:api and @story:review-exclusions", timeout: 60_000 }, async function (this: ApiWorld) {
  const value = states.get(this); if (!value) return;
  const errors: unknown[] = [];
  for (const close of [() => value.host ? value.host.dispose() : value.app.stop(), () => value.model?.dispose(),
    () => value.gitlab?.dispose(), () => value.orderGitlab?.dispose(), () => rm(value.directory, { recursive: true, force: true })]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  states.delete(this);
  if (errors.length) throw new AggregateError(errors, "排除目录场景清理失败");
});

async function prepare(value: State, onlyTests: boolean): Promise<void> {
  assert.ok(value.gitlab);
  await value.gitlab.commitFiles({ [testPath]: testCode,
    ...(onlyTests ? { [releasePath]: releaseCode.replace("restoreStock(orderID)", "lockInventory(orderID)") } : {}) });
  const response = await value.app.request<{ repository: { id: string } }>("/api/repositories", value.gitlab.input);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  value.repositoryId = response.body.repository.id;
}
async function configure(value: State, excludedDirectories: string[]): Promise<void> {
  assert.ok(value.repositoryId);
  const route = `/api/repositories/${value.repositoryId}/review-settings`;
  const current = await value.app.request<{ settings: ReviewSettings }>(route);
  assert.equal(current.status, 200);
  const response = await value.app.request<{ settings: ReviewSettings }>(route,
    { excludedDirectories, version: current.body.settings.version }, { method: "PUT" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(response.body.settings.excludedDirectories, excludedDirectories);
}
async function runReview(value: State, previousId?: string, gitlab = value.gitlab): Promise<ReviewDetail> {
  assert.ok(gitlab);
  const response = previousId
    ? await value.app.request<{ reviewId: string }>(`/api/reviews/${previousId}/rerun`, { requestId: randomUUID() }, { cookie: value.app.memberCookie })
    : await value.app.request<{ id: string }>("/api/reviews", {
      url: `${gitlab.baseUrl}/${gitlab.repositoryPath}/-/merge_requests/${gitlab.iid}`, requestId: randomUUID(),
    }, { cookie: value.app.memberCookie });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  const id = "reviewId" in response.body ? response.body.reviewId : response.body.id;
  assert.equal(await withTeam(value.app.teamId, () => value.app.reviews.runOnce()), true);
  const result = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${id}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.review.status, "completed", result.body.review.failureReason ?? "评审未完成");
  assert.deepEqual(gitlab.state.writes, [], "评审配置和执行不向代码平台写入");
  return result.body.review;
}

Given("张伟管理的库存仓库同时修改了业务代码和测试步骤", async function (this: ApiWorld) { await prepare(state(this), false); });
Given("张伟管理的库存仓库只修改了测试步骤", async function (this: ApiWorld) { await prepare(state(this), true); });
When(/^张伟将 features\/steps 设置为库存仓库的评审排除目录$/, async function (this: ApiWorld) { await configure(state(this), ["features/steps"]); });
When("李娜发起该库存变更的评审", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this); value.review = await runReview(value);
});
Then("本轮只展示业务文件的差异并记录排除了一个测试文件", function (this: ApiWorld) {
  const review = state(this).review!;
  assert.deepEqual(review.files.map((file) => file.newPath), [releasePath]);
  assert.match(review.files[0]!.patch, /restoreStock/);
  assert.deepEqual(review.scope.excludedDirectories, ["features/steps"]);
  assert.equal(review.scope.excludedFileCount, 1);
  assert.equal(review.findings.length, 1);
  assert.deepEqual(review.fileGroups.flatMap((group) => group.files.map((file) => file.path)), [releasePath]);
  assert.ok(review.readFiles.every((file) => file.path !== testPath));
});
Then("生成与评分模型的上下文均不包含测试代码", function (this: ApiWorld) {
  const requests = state(this).model!.requests;
  for (const model of ["fixture-generator", "fixture-grader"]) {
    const turns = requests.filter((request) => request.body.model === model);
    assert.ok(turns.length > 1, `${model} 必须完成实际工具交互`);
    assert.ok(turns.every((request) => !JSON.stringify(request.body).includes(testSentinel)), `${model} 不得收到排除目录的代码`);
    assert.ok(turns.some((request) => JSON.stringify(request.body).includes("restoreStock")), `${model} 应收到业务代码`);
  }
});
Then("两阶段都无法读取被排除的测试文件", function (this: ApiWorld) {
  const requests = state(this).model!.requests;
  for (const model of ["fixture-generator", "fixture-grader"]) {
    const request = requests.findLast((entry) => entry.body.model === model);
    assert.ok(request);
    const blocks = request.body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
    const read = blocks.find((block) => block.type === "tool_use" && block.name === "read" && block.input?.["file_path"] === testPath);
    assert.ok(read?.id, `${model} 必须尝试直接读取测试文件`);
    const result = blocks.find((block) => block.type === "tool_result" && block.tool_use_id === read.id);
    assert.ok(result);
    assert.match(JSON.stringify(result), /该路径已从本轮评审中排除/);
    for (const tool of ["glob", "grep"]) {
      const call = blocks.find((block) => block.type === "tool_use" && block.name === tool);
      assert.ok(call?.id);
      assert.ok(blocks.some((block) => block.type === "tool_result" && block.tool_use_id === call.id));
    }
  }
});
When("张伟接入同团队的订单仓库，其中也修改了业务代码和测试步骤", async function (this: ApiWorld) {
  const value = state(this);
  value.orderGitlab = await startReviewGitLab(join(value.directory, "order-gitlab"), "order-service");
  await value.orderGitlab.commitFiles({ [testPath]: testCode });
  const response = await value.app.request<{ repository: { id: string } }>("/api/repositories", value.orderGitlab.input);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  value.orderRepositoryId = response.body.repository.id;
});
When("李娜发起该订单变更的评审", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this);
  assert.ok(value.orderGitlab);
  value.orderRequestStart = value.model!.requests.length;
  value.orderReview = await runReview(value, undefined, value.orderGitlab);
});
Then("订单仓库默认不排除目录且本轮包含测试步骤的差异与模型上下文", async function (this: ApiWorld) {
  const value = state(this);
  const settings = await value.app.request<{ settings: ReviewSettings }>(`/api/repositories/${value.orderRepositoryId}/review-settings`,
    undefined, { cookie: value.app.memberCookie });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body.settings.excludedDirectories, []);
  assert.equal(settings.body.settings.version, 0);
  assert.deepEqual(new Set(value.orderReview!.files.map((file) => file.newPath)), new Set([releasePath, testPath]));
  assert.deepEqual(value.orderReview!.scope.excludedDirectories, []);
  assert.equal(value.orderReview!.scope.excludedFileCount, 0);
  const requests = value.model!.requests.slice(value.orderRequestStart);
  for (const model of ["fixture-generator", "fixture-grader"]) {
    assert.ok(requests.some((request) => request.body.model === model && JSON.stringify(request.body).includes(testSentinel)),
      `${model} 应收到订单仓库的测试代码`);
  }
});
Then("库存仓库的排除配置保持不变", async function (this: ApiWorld) {
  const value = state(this);
  const settings = await value.app.request<{ settings: ReviewSettings }>(`/api/repositories/${value.repositoryId}/review-settings`,
    undefined, { cookie: value.app.memberCookie });
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.body.settings.excludedDirectories, ["features/steps"]);
  assert.equal(settings.body.settings.version, 1);
});
Then("评审明确说明全部变更已排除且没有评审结论", function (this: ApiWorld) {
  const review = state(this).review!;
  assert.equal(review.statusMessage, "全部变更文件已被排除，本轮未调用模型评审。");
  assert.deepEqual(review.scope.excludedDirectories, ["features/steps"]);
  assert.equal(review.scope.excludedFileCount, 1);
  assert.deepEqual(review.files, []);
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.readFiles, []);
  assert.deepEqual(review.rules, []);
  assert.deepEqual(review.fileGroups, []);
});
Then("本轮没有向任何模型发起请求", function (this: ApiWorld) { assert.equal(state(this).model!.requests.length, 0); });
When("张伟清空库存仓库的排除目录后重新评审该变更", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this); assert.ok(value.review);
  await configure(value, []);
  value.latestReview = await runReview(value, value.review.id);
});
Then("新评审包含测试步骤的差异且记录未排除文件", function (this: ApiWorld) {
  const value = state(this), review = value.latestReview!;
  assert.deepEqual(new Set(review.files.map((file) => file.newPath)), new Set([releasePath, testPath]));
  assert.deepEqual(review.scope.excludedDirectories, []);
  assert.equal(review.scope.excludedFileCount, 0);
  assert.equal(review.round, value.review!.round + 1);
  assert.ok(value.model!.requests.some((request) => JSON.stringify(request.body).includes(testSentinel)));
});
Then("原评审仍保留当时的排除目录及业务文件差异", async function (this: ApiWorld) {
  const value = state(this); assert.ok(value.review);
  const response = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${value.review.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.review, value.review);
  assert.deepEqual(response.body.review.scope.excludedDirectories, ["features/steps"]);
  assert.deepEqual(response.body.review.files.map((file) => file.newPath), [releasePath]);
});
