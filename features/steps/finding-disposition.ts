import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { fixtureFinding, ReviewScenario } from "../support/review-scenario.js";
import type { ReviewDetail, ReviewFinding } from "../../packages/server/src/reviews/types.js";
import type { FindingDispositionService } from "../../packages/server/src/reviews/dispositions.js";
import type { ManagedRule } from "../../packages/server/src/rules/managed-types.js";

interface State {
  cookies: Map<string, string>;
  actors: Map<string, string>;
  findingId: string;
  initialVersion: number;
  response?: { status: number; body: { error?: { message: string }; finding?: ReviewFinding } };
  operationStarted: number;
  operationFinished: number;
  ruleId?: string;
}
interface Participation { currentUserId: string; participants: Array<{ userId: string; completedAt: string | null }> }
const values = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => { const value = values.get(world); assert.ok(value); return value; };
const categories: Record<string, string> = { "误报": "false_positive", "规范不适用": "rule_not_applicable", "规范有误": "rule_incorrect", "不值得修改": "not_worth_fixing", "其他": "other" };

Before({ tags: "@story:finding-disposition or @story:round-comparison", timeout: 60_000 }, async function (this: ApiWorld) {
  values.set(this, { cookies: new Map(), actors: new Map(), findingId: "", initialVersion: 0, operationStarted: 0, operationFinished: 0 });
  this.review = new ReviewScenario();
  await this.review.start({ disposition: true });
  const session = await this.review.request<{ user: { userId: string } }>("/api/auth/session");
  assert.equal(session.status, 200); state(this).actors.set("张伟", session.body.user.userId);
  const member = await this.review.request("/api/admin/members", { username: "lina", email: "lina@example.test", name: "李娜", password: "fixture-password-long", role: "member" });
  assert.equal(member.status, 201);
  const login = await fetch(`${this.review.baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json", "x-ureview-request": "1" },
    body: JSON.stringify({ username: "lina", password: "fixture-password-long" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie);
  const body = await login.json() as { user: { userId: string } };
  state(this).cookies.set("李娜", cookie); state(this).actors.set("李娜", body.user.userId);
});
After({ tags: "@story:finding-disposition or @story:round-comparison", timeout: 60_000 }, async function (this: ApiWorld) {
  try { if (this.review?.gitlab) assert.deepEqual(this.review.gitlab.state.writes, [], "处置和多轮对比不得写入代码平台"); }
  finally { await this.review?.stop(); }
});

function headers(world: ApiWorld, actor: string): Record<string, string> {
  assert.ok(state(world).actors.has(actor), `场景中尚未登录 ${actor}`);
  return actor === "张伟" ? {} : { cookie: state(world).cookies.get(actor)! };
}
async function finding(world: ApiWorld, title?: string): Promise<ReviewFinding> {
  const review = await world.review.readReview();
  const result = review.findings.find((item) => title ? item.title === title : item.id === state(world).findingId);
  assert.ok(result, `评审中没有 finding ${title ?? state(world).findingId}`);
  return result;
}
async function select(world: ApiWorld, title?: string) {
  const review = await world.review.readReview();
  const result = title ? review.findings.find((item) => item.title === title) : review.findings[0];
  assert.ok(result); assert.ok(result.disposition);
  state(world).findingId = result.id; state(world).initialVersion = result.disposition.version;
  return result;
}
async function finish(world: ApiWorld, title = "修复订单超时未释放库存") {
  await world.review.openPullRequest("李娜", title);
  return world.review.waitForReview((review) => review.status === "completed");
}
async function change(world: ApiWorld, actor: string, status: string, reasons: object = {}, version?: number) {
  const current = await finding(world); assert.ok(current.disposition);
  const value = state(world); value.operationStarted = await world.review.databaseTime();
  value.response = await world.review.request(`/api/reviews/${world.review.reviewId}/findings/${current.id}/disposition`,
    { status, version: version ?? current.disposition.version, ...reasons }, headers(world, actor), "PATCH");
  value.operationFinished = await world.review.databaseTime();
  return value.response;
}
async function history(world: ApiWorld) {
  const response = await world.review.request<Awaited<ReturnType<FindingDispositionService["history"]>>>(
    `/api/reviews/${world.review.reviewId}/findings/${state(world).findingId}/disposition-history`);
  assert.equal(response.status, 200); return response.body.events;
}
async function participation(world: ApiWorld) {
  const response = await world.review.request<Participation>(`/api/reviews/${world.review.reviewId}/participation`, undefined, headers(world, "李娜"));
  assert.equal(response.status, 200); return response.body;
}
function titles(count: number) { return ["库存释放未加分布式锁", "超时时间硬编码为 30 秒", "错误日志缺少订单号", "重复事件未校验订单状态", "库存释放缺少重试", "通知失败未记录"].slice(0, count); }
function candidates(world: ApiWorld, count: number, ruleId?: string) {
  world.review.modelOptions.candidates!.splice(0, Infinity, ...titles(count).map((title) => ({ ...structuredClone(fixtureFinding), title, ...(ruleId ? { ruleId } : {}) })));
}

Given("PR {string} 的 finding {string} 状态为 {string}", async function (this: ApiWorld, title: string, name: string, status: string) {
  assert.equal(status, "Pending");
  this.review.modelOptions.candidates!.splice(0, Infinity, { ...structuredClone(fixtureFinding), title: name });
  await finish(this, title); assert.equal((await select(this, name)).status, status);
});
When("评审人 {string} 采纳该 finding", async function (this: ApiWorld, actor: string) { assert.equal((await change(this, actor, "Resolved")).status, 200); });
When("评审人 {string} 将该 finding 改回待处理", async function (this: ApiWorld, actor: string) { assert.equal((await change(this, actor, "Pending")).status, 200); });
Then("该 finding 的状态变为 {string}", async function (this: ApiWorld, status: string) { assert.equal((await finding(this)).status, status); });
When("评审人 {string} 驳回该 finding，理由类别为 {string}，说明为 {string}", async function (this: ApiWorld, actor: string, category: string, explanation: string) {
  assert.equal((await change(this, actor, "Dismissed", { reasonCategory: categories[category], explanation })).status, 200);
});
Then("该 finding 的驳回理由为 {string}", async function (this: ApiWorld, reason: string) { assert.equal((await finding(this)).disposition?.explanation, reason); });
Then("该 finding 的驳回理由类别为 {string}", async function (this: ApiWorld, category: string) { assert.equal((await finding(this)).disposition?.reasonCategory, categories[category]); });
When("评审人 {string} 在不填写理由的情况下尝试驳回该 finding", async function (this: ApiWorld, actor: string) { await change(this, actor, "Dismissed"); });
When("评审人 {string} 选择 {string} 但未填写说明而尝试驳回该 finding", async function (this: ApiWorld, actor: string, category: string) {
  await change(this, actor, "Dismissed", { reasonCategory: categories[category] });
});
Then("驳回未生效", async function (this: ApiWorld) { assert.equal(state(this).response?.status, 400); assert.equal((await history(this)).length, 0); });
Then("处置提示 {string}", function (this: ApiWorld, message: string) { assert.equal(state(this).response?.body.error?.message, message); });
Then("该 finding 的状态仍为 {string}", async function (this: ApiWorld, status: string) { assert.equal((await finding(this)).status, status); });
Then("该 finding 的处置记录中操作人为 {string}", async function (this: ApiWorld, actor: string) {
  const events = await history(this); assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.actor, { id: state(this).actors.get(actor), name: actor });
});
Then("该 finding 的处置记录中操作时间处于本次操作期间", async function (this: ApiWorld) {
  const events = await history(this); const timestamp = Date.parse(events[0]!.createdAt);
  assert.ok(timestamp >= state(this).operationStarted && timestamp <= state(this).operationFinished);
  assert.equal((await finding(this)).disposition?.updatedAt, events[0]!.createdAt);
});
Then("该 finding 的处置记录记载从 {string} 变为 {string}", async function (this: ApiWorld, previous: string, current: string) {
  const events = await history(this); assert.equal(events[0]!.previousStatus, previous); assert.equal(events[0]!.status, current);
  assert.equal(events[0]!.version, state(this).initialVersion + 1);
});
Given("开发者 {string} 提交的 PR {string} 有 {int} 条 finding", async function (this: ApiWorld, author: string, title: string, count: number) {
  assert.equal(author, "李娜"); candidates(this, count); await finish(this, title);
  assert.equal((await this.review.readReview()).findings.length, count);
});
Given("评审人 {string} 采纳了 {string}", async function (this: ApiWorld, actor: string, title: string) {
  await select(this, title); assert.equal((await change(this, actor, "Resolved")).status, 200);
});
Given("评审人 {string} 驳回了 {string}，理由为 {string}", async function (this: ApiWorld, actor: string, title: string, explanation: string) {
  await select(this, title); assert.equal((await change(this, actor, "Dismissed", { reasonCategory: "false_positive", explanation })).status, 200);
});
When("{string} 查看该 PR 的评审结果", async function (this: ApiWorld, actor: string) {
  const result = await this.review.request<{ review: ReviewDetail }>(`/api/reviews/${this.review.reviewId}`, undefined, headers(this, actor));
  assert.equal(result.status, 200); this.review.observedReview = result.body.review;
});
Then("finding {string} 的状态为 {string}，处置人为 {string}", function (this: ApiWorld, title: string, status: string, actor: string) {
  const item = this.review.observedReview!.findings.find((entry) => entry.title === title); assert.ok(item);
  assert.equal(item.status, status); assert.deepEqual(item.disposition?.actor, { id: state(this).actors.get(actor), name: actor });
});
Then("finding {string} 的驳回理由为 {string}", function (this: ApiWorld, title: string, reason: string) {
  assert.equal(this.review.observedReview!.findings.find((item) => item.title === title)?.disposition?.explanation, reason);
});
Given("张伟和李娜打开了同一条待处理 finding", async function (this: ApiWorld) {
  await finish(this); const current = await select(this);
  const other = await this.review.request<{ review: ReviewDetail }>(`/api/reviews/${this.review.reviewId}`, undefined, headers(this, "李娜"));
  assert.equal(other.status, 200); assert.deepEqual(other.body.review.findings[0], current);
});
When("李娜使用打开时的版本驳回该 finding", async function (this: ApiWorld) {
  await change(this, "李娜", "Dismissed", { reasonCategory: "not_worth_fixing" }, state(this).initialVersion);
});
Then("李娜看到处置已被更新的提示", function (this: ApiWorld) { assert.equal(state(this).response?.status, 409); assert.match(state(this).response?.body.error?.message ?? "", /已被.*更新/); });
Then("该 finding 仍由张伟采纳且只有一条处置记录", async function (this: ApiWorld) {
  const current = await finding(this); assert.equal(current.status, "Resolved"); assert.equal(current.disposition?.actor?.id, state(this).actors.get("张伟"));
  assert.equal((await history(this)).length, 1);
});
Given("库存评审展示五条 finding 并折叠一条", async function (this: ApiWorld) {
  candidates(this, 6); const review = await finish(this); assert.equal(review.findings.length, 5); assert.equal(review.foldedCount, 1);
});
When("张伟采纳其中四条 finding", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  for (const item of review.findings.slice(0, 4)) { await select(this, item.title); assert.equal((await change(this, "张伟", "Resolved")).status, 200); }
});
Then("张伟和李娜均未被记录为本轮看完", async function (this: ApiWorld) { assert.ok((await participation(this)).participants.every((actor) => actor.completedAt === null)); });
When("李娜驳回最后一条展示的 finding", async function (this: ApiWorld) {
  const review = await this.review.readReview(); const pending = review.findings.filter((item) => item.status === "Pending"); assert.equal(pending.length, 1);
  await select(this, pending[0]!.title); assert.equal((await change(this, "李娜", "Dismissed", { reasonCategory: "not_worth_fixing" })).status, 200);
});
Then("本轮只有李娜被记录为看完", async function (this: ApiWorld) {
  const value = await participation(this); assert.equal(value.currentUserId, state(this).actors.get("李娜"));
  assert.deepEqual(value.participants.filter((actor) => actor.completedAt).map((actor) => actor.userId), [state(this).actors.get("李娜")]);
});
Given("库存释放规范命中了三条待处理 finding", async function (this: ApiWorld) {
  const rule = await this.review.saveGlobalRule("库存释放约定", "库存恢复前必须获取订单锁并记录订单号。"); state(this).ruleId = rule.id;
  candidates(this, 3, `managed:${rule.id}`); const review = await finish(this);
  assert.equal(review.findings.length, 3); assert.ok(review.findings.every((item) => item.ruleId === `managed:${rule.id}`));
});
When("张伟采纳一条并驳回另一条 finding", async function (this: ApiWorld) {
  await select(this, titles(3)[0]); assert.equal((await change(this, "张伟", "Resolved")).status, 200);
  await select(this, titles(3)[1]); assert.equal((await change(this, "张伟", "Dismissed", { reasonCategory: "false_positive" })).status, 200);
});
Then("库存释放规范的命中数为 {int}、采纳数为 {int}、被无视数为 {int}", async function (this: ApiWorld, hits: number, adopted: number, ignored: number) {
  const result = await this.review.request<{ managedRules: Array<ManagedRule & { counts: { hits: number; adopted: number; ignored: number } }> }>(`/api/rules?repositoryId=${this.review.repositoryId}`);
  assert.equal(result.status, 200); assert.deepEqual(result.body.managedRules.find((rule) => rule.id === state(this).ruleId)?.counts, { hits, adopted, dismissed: 1, ignored });
});
When("张伟将已采纳的规范 finding 改回待处理", async function (this: ApiWorld) {
  await select(this, titles(3)[0]); assert.equal((await change(this, "张伟", "Pending")).status, 200);
});
