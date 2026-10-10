import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import type { ReviewPage, ReviewSummary } from "../../packages/server/src/reviews/types.js";
import { fixtureFinding, type ReviewScenario } from "../support/review-scenario.js";
import type { ApiWorld } from "../support/world.js";

type Repository = { gitlab: ReviewScenario["gitlab"]; repositoryId: string };
interface ListState {
  repositories: Map<string, Repository>;
  created: Map<string, ReviewSummary>;
  observed: ReviewSummary[];
  total: number;
}
const states = new WeakMap<ApiWorld, ListState>();
function state(world: ApiWorld): ListState {
  let value = states.get(world);
  if (!value) { value = { repositories: new Map(), created: new Map(), observed: [], total: 0 }; states.set(world, value); }
  return value;
}

async function repository(world: ApiWorld, name: string): Promise<Repository> {
  const previous = state(world).repositories.get(name);
  if (previous) return previous;
  let result: Repository;
  if (name === "payment-gateway") {
    await world.review.connect(name);
    result = { gitlab: world.review.gitlab, repositoryId: world.review.repositoryId };
  } else result = await world.review.addRepository(name);
  state(world).repositories.set(name, result);
  return result;
}

async function createReview(world: ApiWorld, name: string, title: string, status = "已完成") {
  const repo = await repository(world, name);
  if ([...state(world).created.values()].some((review) => review.repositoryId === repo.repositoryId)) await repo.gitlab.nextPullRequest();
  repo.gitlab.state.title = title;
  if (status === "进行中") world.review.holdModel();
  const response = await world.review.request<{ reviewId: string; created: boolean }>(
    `/api/repositories/${repo.repositoryId}/events/gitlab`, repo.gitlab.event(), {
      "x-gitlab-token": world.review.webhookToken, "x-gitlab-event": "Merge Request Hook", "webhook-id": randomUUID(),
    });
  assert.equal(response.status, 202);
  assert.equal(response.body.created, true);
  world.review.reviewId = response.body.reviewId;
  const expected = status === "已完成" ? "completed" : "running";
  const review = await world.review.waitForReview((review) => review.status === expected);
  state(world).created.set(title, review);
  return review;
}

function row(world: ApiWorld, title?: string): ReviewSummary {
  const reviews = state(world).observed;
  const review = title === undefined ? reviews[0] : reviews.find((item) => item.title === title);
  assert.ok(review, `列表缺少评审：${title ?? "首条"}`);
  return review;
}

async function readList(world: ApiWorld, query = "") {
  const response = await world.review.request<ReviewPage>(`/api/reviews${query}`);
  assert.equal(response.status, 200);
  assert.ok(Number.isInteger(response.body.total));
  state(world).observed = response.body.reviews;
  state(world).total = response.body.total;
  return response.body;
}

Given("仓库 {string} 中的 PR {string} 由 {string} 提交且已完成评审",
  async function (this: ApiWorld, name: string, title: string, author: string) {
    const repo = await repository(this, name);
    repo.gitlab.state.author = author;
    this.review.modelOptions.candidates!.splice(0, this.review.modelOptions.candidates!.length,
      ...(["high", "high", "medium"] as const).map((severity, index) => ({
        ...structuredClone(fixtureFinding), severity, title: `${fixtureFinding.title}（校验点 ${index + 1}）`,
      })));
    await createReview(this, name, title);
  });

Given("该评审产出了 {int} 条高危 finding 与 {int} 条中危 finding", async function (this: ApiWorld, high: number, medium: number) {
  const review = await this.review.readReview();
  assert.equal(review.status, "completed");
  assert.equal(review.findings.filter((finding) => finding.severity === "high").length, high);
  assert.equal(review.findings.filter((finding) => finding.severity === "medium").length, medium);
});

Given("评审列表中有以下 PR", async function (this: ApiWorld, table: DataTable) {
  const rows = table.hashes();
  assert.ok(rows.every((row) => ["已完成", "进行中"].includes(row["状态"]!)));
  // 阻塞中的模型会占用当前工作进程，先准备所有已完成的评审。
  for (const item of [...rows.filter((item) => item["状态"] === "已完成"), ...rows.filter((item) => item["状态"] === "进行中")]) {
    await createReview(this, item["仓库"]!, item["PR 标题"]!, item["状态"]!);
  }
});

When("评审人 {string} 查看评审列表", async function (this: ApiWorld, _actor: string) { await readList(this); });
When("评审人 {string} 筛选仓库 {string} 且状态 {string}", async function (this: ApiWorld, _actor: string, name: string, status: string) {
  const states: Record<string, string> = { "已完成": "completed", "进行中": "running" };
  assert.ok(states[status]);
  await readList(this, `?repositoryId=${(await repository(this, name)).repositoryId}&status=${states[status]}`);
});
Then("列表中包含 {string}", function (this: ApiWorld, title: string) { assert.equal(row(this, title).title, title); });
Then("列表中只包含 {string}", function (this: ApiWorld, title: string) {
  assert.deepEqual(state(this).observed.map((review) => review.title), [title]);
  assert.equal(state(this).total, 1);
});
Then("这一条的状态为 {string}", function (this: ApiWorld, status: string) {
  assert.equal(status, "已完成"); assert.equal(row(this).status, "completed");
});
Then("这一条的仓库为 {string}", function (this: ApiWorld, name: string) { assert.equal(row(this).repositoryName, name); });
Then("这一条的作者为 {string}", function (this: ApiWorld, author: string) { assert.equal(row(this).author, author); });
Then("这一条的高危 finding 数为 {int}", function (this: ApiWorld, count: number) { assert.equal(row(this).findingCounts.high, count); });
Then("这一条的中危 finding 数为 {int}", function (this: ApiWorld, count: number) { assert.equal(row(this).findingCounts.medium, count); });

Given("PR {string} 已完成评审且没有任何人查看过它的评审", async function (this: ApiWorld, title: string) {
  const review = await createReview(this, "payment-gateway", title);
  assert.equal(review.viewedAt, null);
});
Given("PR {string} 已完成评审且评审人 {string} 查看过它的评审", async function (this: ApiWorld, title: string, _actor: string) {
  const review = await createReview(this, "payment-gateway", title);
  const response = await this.review.request<{ viewedAt: string }>(`/api/reviews/${review.id}/viewed`, {});
  assert.equal(response.status, 200);
  assert.ok(Number.isFinite(Date.parse(response.body.viewedAt)));
});
Then("{string} 被标记为 {string}", function (this: ApiWorld, title: string, label: string) {
  assert.equal(label, "还没人看过"); assert.equal(row(this, title).viewedAt, null);
});
Then("{string} 不带 {string} 标记", function (this: ApiWorld, title: string, label: string) {
  assert.equal(label, "还没人看过"); assert.ok(Number.isFinite(Date.parse(row(this, title).viewedAt!)));
});

When("评审人 {string} 逐页查看每页 {int} 条的评审列表", async function (this: ApiWorld, _actor: string, pageSize: number) {
  const observed: ReviewSummary[] = [];
  let total = 0;
  for (let page = 1; page === 1 || observed.length < total; page++) {
    assert.ok(page < 10, "分页没有终止");
    const result = await readList(this, `?page=${page}&pageSize=${pageSize}`);
    assert.equal(result.page, page);
    assert.equal(result.pageSize, pageSize);
    total = result.total;
    assert.equal(result.reviews.length, Math.min(pageSize, total - (page - 1) * pageSize));
    observed.push(...result.reviews);
  }
  state(this).observed = observed;
  state(this).total = total;
});
Then("所有 PR 恰好出现一次且总数为 {int}", function (this: ApiWorld, count: number) {
  const value = state(this);
  assert.equal(value.total, count);
  assert.equal(value.observed.length, count);
  assert.equal(new Set(value.observed.map((review) => review.id)).size, count);
  assert.deepEqual(value.observed.map((review) => review.title).sort(), [...value.created.keys()].sort());
});

When("PR {string} 完成新一轮评审", async function (this: ApiWorld, title: string) {
  const original = state(this).created.get(title)!;
  assert.ok(original);
  const response = await this.review.request<{ reviewId: string; created: boolean }>(`/api/reviews/${original.id}/rerun`, { requestId: randomUUID() });
  assert.equal(response.status, 202);
  assert.equal(response.body.created, true);
  this.review.reviewId = response.body.reviewId;
  const latest = await this.review.waitForReview((review) => review.status === "completed");
  assert.equal(latest.round, original.round + 1);
  const old = await this.review.request<{ review: ReviewSummary }>(`/api/reviews/${original.id}`);
  assert.equal(old.status, 200);
  assert.ok(old.body.review.viewedAt);
  state(this).created.set(title, latest);
});
