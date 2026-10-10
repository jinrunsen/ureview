import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import type { ReadingDocumentRecord } from "../../packages/server/src/reviews/reading-document.js";
import type { ReviewDetail, ReviewPage, ReviewSummary } from "../../packages/server/src/reviews/types.js";
import { makeMockDocumentScript } from "../../packages/server/src/runtime/test-support.js";
import { releaseCode, releasePath } from "../support/review-gitlab-fixture.js";
import type { ApiWorld } from "../support/world.js";

const originals = new WeakMap<ApiWorld, ReviewDetail>();
const attempts = new WeakMap<ApiWorld, { reviewId: string; created: boolean }[]>();

async function rerun(world: ApiWorld, requestId = randomUUID()) {
  const original = originals.get(world)!;
  const response = await world.review.request<{ reviewId: string; created: boolean }>(
    `/api/reviews/${original.id}/rerun`, { requestId });
  assert.equal(response.status, response.body.created ? 202 : 200);
  assert.ok(response.body.reviewId);
  world.review.reviewId = response.body.reviewId;
  return response.body;
}

Given("PR {string} 已完成一次评审", async function (this: ApiWorld, title: string) {
  await this.review.openPullRequest("李娜", title);
  await this.review.waitForReview((review) => review.status === "completed");
  // 解读可能晚于评审结束，等它结束后再记下这一轮，详情里的解读概要才稳定。
  await this.review.waitForReading();
  originals.set(this, structuredClone(await this.review.readReview()));
});

When("开发者 {string} 向该 PR 推送了新的提交", async function (this: ApiWorld, _actor: string) {
  const oldSha = this.review.gitlab.headSha;
  await this.review.gitlab.commitFiles({ [releasePath]: releaseCode.replace("restoreStock(orderID)", "restoreStockOnce(orderID)") });
  const payload = this.review.gitlab.event();
  const response = await this.review.request<{ reviewId: string; created: boolean }>(
    `/api/repositories/${this.review.repositoryId}/events/gitlab`, {
      ...payload, object_attributes: { ...payload.object_attributes, action: "update", oldrev: oldSha },
    }, { "x-gitlab-token": this.review.webhookToken, "x-gitlab-event": "Merge Request Hook", "webhook-id": randomUUID() });
  assert.equal(response.status, 202);
  assert.equal(response.body.created, true);
  assert.notEqual(response.body.reviewId, originals.get(this)!.id);
  this.review.reviewId = response.body.reviewId;
});

Then("该 PR 的评审结果为最新一次评审的结果", async function (this: ApiWorld) {
  const latest = await this.review.waitForReview((review) => review.status === "completed");
  const response = await this.review.request<ReviewPage>(`/api/reviews?repositoryId=${this.review.repositoryId}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.reviews.length, 1);
  assert.equal(response.body.reviews[0]!.id, latest.id);
  assert.equal(latest.round, 2);
  assert.equal(latest.headSha, this.review.gitlab.headSha);
  assert.notEqual(latest.headSha, originals.get(this)!.headSha);
  assert.ok(latest.findings[0]!.code.includes("restoreStockOnce"));
});

Given("仓库 {string} 的规范在此之后新增了一条 {string}", async function (this: ApiWorld, name: string, rule: string) {
  assert.equal(name, "payment-gateway");
  const separator = rule.indexOf(" ");
  assert.ok(separator > 0);
  await this.review.saveGlobalRule(rule.slice(0, separator), rule.slice(separator + 1));
});

When("评审人 {string} 对该 PR 手动重跑评审", async function (this: ApiWorld, _actor: string) {
  const result = await rerun(this);
  assert.equal(result.created, true);
});

Then("最新一次评审的依据来源中注入的规范包含 {string}", async function (this: ApiWorld, id: string) {
  const latest = await this.review.waitForReview((review) => review.status === "completed");
  assert.ok(latest.rules.some((rule) => rule.name === id));
  assert.equal(latest.trigger, "manual");
  assert.equal(latest.headSha, originals.get(this)!.headSha);
  assert.ok(!originals.get(this)!.rules.some((rule) => rule.name === id));
  for (const model of ["fixture-generator", "fixture-grader"]) {
    assert.ok(this.review.model.requests.some((request) => request.body.model === model && JSON.stringify(request.body).includes(id)));
  }
});

When("评审人 {string} 重试同一次手动重跑操作", async function (this: ApiWorld, _actor: string) {
  const requestId = randomUUID();
  attempts.set(this, [await rerun(this, requestId), await rerun(this, requestId)]);
});

Then("两次操作打开的是同一轮评审", function (this: ApiWorld) {
  const results = attempts.get(this)!;
  assert.equal(results.length, 2);
  assert.equal(results[0]!.reviewId, results[1]!.reviewId);
  assert.deepEqual(results.map((result) => result.created), [true, false]);
});

Given("下一轮解读的概要为 {string}", function (this: ApiWorld, summary: string) {
  this.review.modelOptions.readingScript = makeMockDocumentScript(releasePath, 3, 4, originals.get(this)!.title).map((step) =>
    step.name === "write_section" && (step.input as { id: string }).id === "summary"
      ? { ...step, input: { id: "summary", html: `<p>${summary}</p>` } } : step);
});

Then("默认打开的解读概要为 {string}", async function (this: ApiWorld, summary: string) {
  const latest = await this.review.waitForReview((review) => review.status === "completed");
  const response = await this.review.request<ReviewPage>(`/api/reviews?repositoryId=${this.review.repositoryId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.reviews.map((review) => review.id), [latest.id]);
  const reading = await this.review.waitForReading();
  assert.equal(reading.status, "completed");
  assert.equal(reading.content?.sections["summary"], `<p>${summary}</p>`);
});

Then("上一轮的解读、代码与追溯信息保持不变", async function (this: ApiWorld) {
  const original = originals.get(this)!;
  const history = await this.review.request<{ reviews: ReviewSummary[] }>(
    `/api/repositories/${this.review.repositoryId}/pull-requests/${original.iid}/reviews`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.reviews.map((review) => review.round), [2, 1]);
  assert.deepEqual(history.body.reviews.map((review) => review.id), [this.review.reviewId, original.id]);
  const response = await this.review.request<{ review: ReviewDetail }>(`/api/reviews/${original.id}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.review, original);
  const readings = await this.review.request<{ documents: ReadingDocumentRecord[] }>(`/api/reviews/${original.id}/reading-documents`);
  assert.deepEqual(readings.body.documents.map((document) => document.status), ["completed"]);
  assert.notEqual(readings.body.documents[0]!.content?.sections["summary"], (await this.review.readingDocuments())[0]!.content?.sections["summary"]);
});

Given("后续评审的模型尚未结束", function (this: ApiWorld) { this.review.holdModel(); });

Then("列表显示新一轮正在评审，上一轮仍可查看", async function (this: ApiWorld) {
  const response = await this.review.request<ReviewPage>(`/api/reviews?repositoryId=${this.review.repositoryId}`);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.reviews.map((review) => [review.id, review.status]), [[this.review.reviewId, "running"]]);
  const previous = await this.review.request<{ review: ReviewDetail }>(`/api/reviews/${originals.get(this)!.id}`);
  assert.equal(previous.status, 200);
  assert.equal(previous.body.review.status, "completed");
  assert.deepEqual(previous.body.review, originals.get(this));
});
