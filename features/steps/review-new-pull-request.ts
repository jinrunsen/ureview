import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";
import type { ReviewFinding, ReviewStatus } from "../../packages/server/src/reviews/types.js";
import { lockCode, lockPath, releaseCode, releasePath } from "../support/review-gitlab-fixture.js";
import { fixtureFinding } from "../support/review-scenario.js";
import type { ApiWorld } from "../support/world.js";

function finding(world: ApiWorld): ReviewFinding {
  assert.ok(world.review.observedFinding, "尚未通过评审详情读取 finding");
  return world.review.observedFinding;
}

async function selectFinding(world: ApiWorld): Promise<void> {
  const review = await world.review.readReview();
  assert.equal(review.status, "completed");
  assert.equal(review.findings.length, 1);
  world.review.observedFinding = review.findings[0];
  assert.equal(finding(world).title, world.review.modelOptions.candidates![0]!.title);
}

Given("仓库 {string} 已接入", async function (this: ApiWorld, repositoryName: string) {
  await this.review.connect(repositoryName);
});

When("开发者 {string} 新建 PR {string}", async function (this: ApiWorld, actor: string, title: string) {
  await this.review.openPullRequest(actor, title);
});

Given("开发者 {string} 刚新建了 PR {string}", async function (this: ApiWorld, actor: string, title: string) {
  this.review.holdModel();
  await this.review.openPullRequest(actor, title);
});

Given("该 PR 的评审尚未完成", async function (this: ApiWorld) {
  await this.review.waitForReview((review) => review.status === "running" && this.review.model.requests.length > 0);
});

Given("开发者 {string} 新建 PR {string} 后系统已为其产生一次评审",
  async function (this: ApiWorld, actor: string, title: string) {
    await this.review.openPullRequest(actor, title);
    await this.review.waitForReview((review) => review.status === "completed");
  },
);

When("代码平台因重试再次推送了同一次新建事件", async function (this: ApiWorld) {
  const response = await this.review.deliverEvent();
  assert.equal(response.status, 200);
  assert.equal(response.body.created, false);
  assert.equal(response.body.reviewId, this.review.reviewId);
});

Then("评审列表中包含 PR {string}", async function (this: ApiWorld, title: string) {
  const reviews = await this.review.listReviews();
  assert.equal(reviews.filter((review) => review.title === title).length, 1);
});

Then("该 PR 的评审次数为 {int}", async function (this: ApiWorld, count: number) {
  const response = await this.review.request<{ reviews: import("../../packages/server/src/reviews/types.js").ReviewSummary[] }>(
    `/api/repositories/${this.review.repositoryId}/pull-requests/${this.review.gitlab.iid}/reviews`);
  assert.equal(response.status, 200);
  assert.equal(response.body.reviews.length, count);
});

When("评审人 {string} 查看该 PR 的评审结果", async function (this: ApiWorld, _actor: string) {
  await this.review.readReview();
});

Then("该评审状态为 {string}", async function (this: ApiWorld, label: string) {
  const statuses: Record<string, ReviewStatus> = { "进行中": "running", "已完成": "completed", "失败": "failed" };
  assert.ok(statuses[label], `未知的评审状态：${label}`);
  const review = await this.review.waitForReview((review) => review.status === statuses[label]);
  assert.equal(review.status, statuses[label]);
});

Then("该评审不给出 {string} 的结论", async function (this: ApiWorld, conclusion: string) {
  const review = await this.review.readReview();
  assert.notEqual(review.status, "completed");
  assert.deepEqual(review.findings, []);
  assert.equal(JSON.stringify(review).includes(conclusion), false);
});

Given("模型服务当前不可用", function (this: ApiWorld) {
  this.review.modelOptions.mode = "model-error";
});

Given("代码平台当前不可达", function (this: ApiWorld) {
  this.review.gitlab.state.unavailable = true;
});

Then("该评审的失败原因为 {string}", async function (this: ApiWorld, reason: string) {
  const review = await this.review.readReview();
  assert.equal(review.status, "failed");
  assert.equal(review.failureReason, reason);
  assert.deepEqual(review.findings, []);
});

Given("新 PR 的代码差异尚未准备好", function (this: ApiWorld) {
  this.review.gitlab.state.diffReady = false;
});

Then("该评审提示 {string}", async function (this: ApiWorld, message: string) {
  const folded = /^还有 (\d+) 条已折叠$/.exec(message);
  if (folded) {
    const review = await this.review.readReview();
    assert.equal(review.status, "completed");
    assert.equal(review.foldedCount, Number(folded[1]));
    return;
  }
  const review = await this.review.waitForReview((review) => review.statusMessage === message);
  assert.equal(review.statusMessage, message);
  assert.equal(review.status, "queued");
  assert.equal(this.review.model.requests.length, 0);
});

When("代码平台准备好该次提交的完整差异", function (this: ApiWorld) {
  this.review.gitlab.state.diffReady = true;
});

Given("PR {string} 的评审产出了 finding {string}", async function (this: ApiWorld, title: string, findingTitle: string) {
  assert.equal(findingTitle, fixtureFinding.title);
  await this.review.openPullRequest("李娜", title);
  await this.review.waitForReview((review) => review.status === "completed");
});

When("评审人 {string} 查看该 finding 的详情", async function (this: ApiWorld, _actor: string) {
  await selectFinding(this);
});

When("评审人 {string} 查看该 finding 的来源信息", async function (this: ApiWorld, _actor: string) {
  await selectFinding(this);
  this.review.originalFinding = structuredClone(finding(this));
});

Then("该 finding 带有问题描述", function (this: ApiWorld) {
  assert.equal(finding(this).description, fixtureFinding.description);
  assert.equal(finding(this).severity, "high");
  assert.equal(finding(this).status, "Pending");
});

Then("该 finding 锚定的文件为 {string}", function (this: ApiWorld, path: string) {
  assert.equal(finding(this).location.path, path);
  assert.deepEqual(finding(this).location, fixtureFinding.location);
});

Then("该 finding 带有一张证据链接表，列出这条结论参考过的文件", function (this: ApiWorld) {
  const evidence = finding(this).evidence;
  assert.equal(evidence.length, 2);
  for (const expected of fixtureFinding.evidence) {
    const actual = evidence.find((item) => item.path === expected.path);
    assert.ok(actual);
    assert.deepEqual({ ...actual, url: undefined, code: undefined }, { ...expected, url: undefined, code: undefined });
    const suffix = `#L${expected.startLine}${expected.startLine === expected.endLine ? "" : `-${expected.endLine}`}`;
    assert.equal(actual.url,
      `${this.review.gitlab.baseUrl}/${this.review.gitlab.repositoryPath}/-/blob/${this.review.gitlab.headSha}/${expected.path}${suffix}`);
  }
});

function linesOf(source: string, range: { startLine: number; endLine: number }): string {
  return source.split("\n").slice(range.startLine - 1, range.endLine).join("\n");
}

Then("该 finding 的每条证据都带有评审时读取的那几行代码", function (this: ApiWorld) {
  const sources: Record<string, string> = { [releasePath]: releaseCode, [lockPath]: lockCode };
  const evidence = finding(this).evidence;
  assert.equal(evidence.length, fixtureFinding.evidence.length);
  for (const item of evidence) assert.equal(item.code, linesOf(sources[item.path]!, item));
});

Then("本次没有改动的 {string} 上的证据也带有代码", function (this: ApiWorld, path: string) {
  assert.equal(path, lockPath);
  assert.ok(!this.review.observedReview!.files.some((file) => file.newPath === path || file.oldPath === path));
  const item = finding(this).evidence.find((evidence) => evidence.path === path);
  assert.ok(item);
  assert.equal(item.code, linesOf(lockCode, item));
});

Then("该 finding 带有一段可直接交给编码助手的修复提示词", function (this: ApiWorld) {
  assert.equal(finding(this).fixPrompt, fixtureFinding.fixPrompt);
});

Then("该 finding 展示涉及的代码片段", function (this: ApiWorld) {
  assert.equal(finding(this).code, releaseCode.split("\n").slice(2, 4).join("\n"));
});

Then("该 finding 未命中任何规范", function (this: ApiWorld) {
  assert.equal(finding(this).ruleId, null);
});

Then("该 finding 带有质量评分", function (this: ApiWorld) {
  assert.equal(finding(this).score, 88);
});

Then("该 finding 记录了产出它所用的模型", function (this: ApiWorld) {
  const expected = this.review.model.models.generator;
  assert.deepEqual(finding(this).generatorModel, { model: expected.model, provider: expected.provider, vendor: expected.vendor });
  assert.ok(this.review.model.requests.some((request) => request.body.model === expected.model));
});

Then("该 finding 记录了对它评分所用的模型", function (this: ApiWorld) {
  const expected = this.review.model.models.grader;
  assert.deepEqual(finding(this).graderModel, { model: expected.model, provider: expected.provider, vendor: expected.vendor });
  assert.ok(this.review.model.requests.some((request) => request.body.model === expected.model));
});

Then("评分所用的模型与产出所用的模型不是同一家", function (this: ApiWorld) {
  assert.notEqual(finding(this).generatorModel.vendor.toLowerCase(), finding(this).graderModel.vendor.toLowerCase());
});

Then("该 finding 记录了实际读过的文件与行", function (this: ApiWorld) {
  const reads = finding(this).readFiles;
  assert.ok(reads.some((read) => read.path === releasePath && read.tool === "read" && read.phase === "generator"
    && read.startLine === 3 && read.endLine === 4));
  assert.ok(reads.some((read) => read.path === lockPath && read.tool === "read" && read.phase === "generator"
    && read.startLine === 3 && read.endLine === 3));
  assert.ok(reads.some((read) => read.tool === "grep" && read.path === lockPath && read.startLine === 3));
  const results = this.review.model.requests.flatMap((request) => request.body.messages)
    .flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((part) => part.type === "tool_result");
  assert.ok(JSON.stringify(results).includes("func ReleaseInventoryLock(orderID string)"), "模型必须收到真实文件工具返回的代码");
});

Then("该 finding 记录了产出时间", function (this: ApiWorld) {
  const generatedAt = Date.parse(finding(this).generatedAt);
  assert.ok(Number.isFinite(generatedAt));
  assert.ok(generatedAt >= Date.parse(this.review.observedReview!.createdAt));
  assert.ok(generatedAt <= Date.parse(this.review.observedReview!.completedAt!));
});

When("评审人 {string} 重新打开该 finding 的详情", async function (this: ApiWorld, _actor: string) {
  await selectFinding(this);
});

Then("该 finding 的内容与追溯信息保持一致", function (this: ApiWorld) {
  assert.ok(this.review.originalFinding);
  assert.deepEqual(finding(this), this.review.originalFinding);
});

When("该 PR 的评审已完成", async function (this: ApiWorld) {
  await this.review.waitForReview((review) => review.status === "completed");
});

Then("代码平台上该 PR 没有新增任何评论", function (this: ApiWorld) {
  assert.deepEqual(this.review.gitlab.state.writes.filter((request) => /\/(notes|discussions)(\?|$)/.test(request.path)), []);
});

Then("代码平台上该 PR 的描述没有被修改", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  assert.equal(review.pullRequest?.description, "订单超时后恢复库存。");
  assert.deepEqual(this.review.gitlab.state.writes.filter((request) => request.path.includes("/merge_requests/")), []);
});

Then("代码平台上该 PR 没有被写入任何合并状态", function (this: ApiWorld) {
  assert.deepEqual(this.review.gitlab.state.writes, []);
  assert.ok(this.review.gitlab.requests.some((request) => request.method === "POST" && request.path.endsWith("/git-upload-pack")));
  assert.ok(this.review.gitlab.requests.every((request) => request.method === "GET"
    || (request.method === "POST" && request.path.endsWith("/git-upload-pack"))));
  const allowed = new Set(["read", "grep", "glob", "report_finding", "report_file_groups", "finish_report", "grade_finding",
    "submit_outline", "write_section", "finish_document", "submit_review"]);
  for (const request of this.review.model.requests) {
    assert.ok(request.body.tools?.length);
    assert.ok(request.body.tools.every((tool) => allowed.has(tool.name)), "评审模型只能获得只读工具和上报工具");
  }
});
