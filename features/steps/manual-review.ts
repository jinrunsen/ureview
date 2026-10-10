import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";

const submissions = new WeakMap<ApiWorld, { status: number; body: { id?: string; created?: boolean; error?: { code: string; message: string } } }>();

Given("PR {string} 尚无评审记录", async function (this: ApiWorld, title: string) {
  this.review.gitlab.state.title = title;
  assert.deepEqual(await this.review.listReviews(), []);
});

Given("仓库 {string} 尚未接入评审工作台", function (this: ApiWorld, name: string) {
  assert.equal(name, "payment-gateway");
  assert.equal(this.review.repositoryId, "");
});

When("评审人 {string} 输入该 PR 的链接开始评审", async function (this: ApiWorld, _actor: string) {
  const fixture = this.review.gitlab;
  const response = await this.review.request<{ id?: string; created?: boolean; error?: { code: string; message: string } }>(
    "/api/reviews", { url: `${fixture.baseUrl}/${fixture.repositoryPath}/-/merge_requests/${fixture.iid}`, requestId: randomUUID() });
  submissions.set(this, response);
  if (response.body.id) {
    assert.equal(response.status, 202);
    assert.equal(response.body.created, true);
    this.review.reviewId = response.body.id;
  }
});

Then("该评审记录为手动发起且对应 PR 当前提交", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  assert.equal(review.trigger, "manual");
  assert.equal(review.headSha, this.review.gitlab.headSha);
  assert.equal(review.iid, this.review.gitlab.iid);
  assert.equal(review.findings.length, 1);
  assert.ok(review.fileGroups.length);
  assert.deepEqual(this.review.gitlab.state.writes, []);
});

Then("工作台提示先接入该 PR 所属仓库", function (this: ApiWorld) {
  const response = submissions.get(this)!;
  assert.equal(response.status, 422);
  assert.equal(response.body.error?.code, "repository_not_connected");
  assert.match(response.body.error!.message, /接入/);
});

Then("没有产生评审记录", async function (this: ApiWorld) {
  const response = await this.review.request<{ reviews: unknown[]; total: number }>("/api/reviews");
  assert.equal(response.status, 200);
  assert.equal(response.body.total, 0);
  assert.deepEqual(response.body.reviews, []);
  assert.deepEqual(this.review.gitlab.requests, []);
});
