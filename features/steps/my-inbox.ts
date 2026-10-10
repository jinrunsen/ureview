import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { ReviewScenario } from "../support/review-scenario.js";
import type { Inbox, InboxNotification } from "../../packages/server/src/inbox/service.js";
import { readingFirstSentence } from "../../packages/server/src/inbox/service.js";
import type { IdentitySettings } from "../../packages/server/src/auth/identities.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";

interface State { app: ReviewScenario; inbox?: Inbox; memberId?: string; status?: number; error?: string; expectedAssigned: string[]; expectedAuthored: string[]; reviews: Map<string, ReviewDetail>; notificationId?: string }
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld) { const value = states.get(world); assert.ok(value); return value; }
const emptyIm = { mobile: null, feishuOpenId: null, feishuUserId: null };
Before({ tags: "@layer:api and @story:my-inbox", timeout: 60_000 }, async function (this: ApiWorld) {
  const app = new ReviewScenario(); states.set(this, { app, expectedAssigned: [], expectedAuthored: [], reviews: new Map() });
  await app.start({ disposition: true }); await app.connect("payment-gateway");
});
After({ tags: "@layer:api and @story:my-inbox", timeout: 60_000 }, async function (this: ApiWorld) { await states.get(this)?.app.stop(); states.delete(this); });
async function addMember(app: ReviewScenario) {
  assert.equal((await app.request("/api/admin/members", { name: "李娜", username: "lina", email: "lina@example.test", password: "fixture-password-long", role: "member" })).status, 201);
  const members = await app.request<{ members: Array<{ id: string; name: string }> }>("/api/team/members");
  return members.body.members.find((member) => member.name === "李娜")!.id;
}
async function createReview(current: State, options: { title: string; author?: string; reviewers?: string[]; assignees?: string[]; prState?: "opened" | "merged" | "closed" }) {
  const app = current.app;
  Object.assign(app.gitlab.state, { author: options.author ?? "lina", reviewers: options.reviewers ?? [], assignees: options.assignees ?? [], prState: options.prState ?? "opened" });
  app.eventId = randomUUID(); await app.openPullRequest(options.author === "zhangwei" ? "张伟" : "李娜", options.title);
  const review = await app.waitForReview((value) => value.status === "completed" && value.readingSummary !== null);
  current.reviews.set(review.id, review);
  return review;
}
Given("张伟已关联支付网关所在实例的 GitLab 用户名", async function (this: ApiWorld) {
  const { app } = state(this);
  const response = await app.request("/api/account/identities", { gitlab: [{ instanceUrl: app.gitlab.baseUrl, username: "zhangwei" }], ...emptyIm }, {}, "PUT");
  assert.equal(response.status, 200);
});
Given("支付网关中存在指派张伟评审和由张伟提交的多轮评审", { timeout: 120_000 }, async function (this: ApiWorld) {
  const current = state(this), app = current.app;
  const first = await createReview(current, { title: "修复订单超时未释放库存", reviewers: ["zhangwei"] });
  const rerun = await app.request<{ reviewId: string }>(`/api/reviews/${first.id}/rerun`, { requestId: randomUUID() });
  assert.equal(rerun.status, 202); app.reviewId = rerun.body.reviewId;
  const latest = await app.waitForReview((value) => value.status === "completed" && value.readingSummary !== null); current.reviews.set(latest.id, latest); current.expectedAssigned.push(latest.id);
  await app.gitlab.nextPullRequest();
  const assigned = await createReview(current, { title: "增加库存预留重试", assignees: ["zhangwei"] }); current.expectedAssigned.push(assigned.id);
  assert.equal((await app.request(`/api/reviews/${assigned.id}/findings/${assigned.findings[0]!.id}/disposition`, { version: 0, status: "Resolved" }, {}, "PATCH")).status, 200);
  current.reviews.set(assigned.id, await app.readReview());
  await app.gitlab.nextPullRequest();
  const authored = await createReview(current, { title: "记录库存恢复结果", author: "zhangwei" }); current.expectedAuthored.push(authored.id);
  await app.gitlab.nextPullRequest(); await createReview(current, { title: "已合并的库存查询", author: "zhangwei", reviewers: ["zhangwei"], prState: "merged" });
  await app.gitlab.nextPullRequest(); await createReview(current, { title: "已关闭的库存调整", author: "zhangwei", assignees: ["zhangwei"], prState: "closed" });
  assert.equal(app.gitlab.state.writes.length, 0);
});
When("张伟查看我的待办", async function (this: ApiWorld) {
  const current = state(this); const response = await current.app.request<Inbox>("/api/inbox"); assert.equal(response.status, 200); current.inbox = response.body;
});
Then("待我评审包含评审人或指派人为张伟的最新开放轮次", function (this: ApiWorld) {
  const current = state(this); assert.equal(current.inbox?.linked, true); assert.deepEqual(current.inbox.toReview.map((item) => item.id).sort(), current.expectedAssigned.sort());
});
Then("我提交的只包含张伟作为作者的最新开放轮次", function (this: ApiWorld) {
  const current = state(this); assert.deepEqual(current.inbox?.submitted.map((item) => item.id).sort(), current.expectedAuthored.sort());
});
Then("每条待办包含规则结论解读首句和当前未处置数", function (this: ApiWorld) {
  const current = state(this); assert.ok(current.inbox);
  for (const item of [...current.inbox.toReview, ...current.inbox.submitted]) {
    const review = current.reviews.get(item.id)!;
    assert.deepEqual(item.conclusion, review.conclusion); assert.equal(item.status, review.status);
    assert.equal(item.readingSummary, readingFirstSentence(review.readingSummary ?? undefined)); assert.ok(item.readingSummary);
    assert.equal(item.pendingCount, review.findings.filter((finding) => finding.status === "Pending").length);
  }
});
When("管理员尝试让李娜关联同一实例的相同用户名", async function (this: ApiWorld) {
  const current = state(this); current.memberId = await addMember(current.app);
  const response = await current.app.request<{ error: { message: string } }>(`/api/admin/members/${current.memberId}/identities`, { ...emptyIm, gitlab: [{ instanceUrl: current.app.gitlab.baseUrl, username: "ZHANGWEI" }] }, {}, "PUT");
  current.status = response.status; current.error = response.body.error.message;
});
Then("工作台提示用户名已被关联且保留两人的原身份", async function (this: ApiWorld) {
  const current = state(this); assert.equal(current.status, 409); assert.match(current.error!, /已被其他账号关联/);
  const self = await current.app.request<IdentitySettings>("/api/account/identities"); assert.equal(self.body.gitlab[0]?.username, "zhangwei");
  const member = await current.app.request<IdentitySettings>(`/api/admin/members/${current.memberId}/identities`); assert.deepEqual(member.body.gitlab, []);
});
Given("尚未关联 GitLab 的李娜收到了库存问题的提及和回复", async function (this: ApiWorld) {
  const current = state(this), app = current.app; current.memberId = await addMember(app);
  const review = await createReview(current, { title: "修复订单超时未释放库存" });
  const route = `/api/reviews/${review.id}/findings/${review.findings[0]!.id}/comments`;
  assert.equal((await app.request(route, { requestId: randomUUID(), body: "李娜，请确认库存恢复边界", mentions: [current.memberId] })).status, 201);
  await app.request("/api/auth/login", { username: "lina", password: "fixture-password-long" });
  const comment = await app.request<{ comment: { id: string } }>(route, { requestId: randomUUID(), body: "还需要确认重复释放" });
  assert.equal(comment.status, 201);
  await app.request("/api/auth/login", { username: "zhangwei", password: "fixture-password-long" });
  assert.equal((await app.request(route, { requestId: randomUUID(), body: "已有订单级锁可以复用", parentId: comment.body.comment.id })).status, 201);
  await app.request("/api/auth/login", { username: "lina", password: "fixture-password-long" });
});
When("李娜查看我的待办并标记其中一条提醒已读", async function (this: ApiWorld) {
  const current = state(this), app = current.app;
  const inbox = await app.request<Inbox>("/api/inbox"); assert.equal(inbox.status, 200); assert.equal(inbox.body.linked, false);
  assert.deepEqual(inbox.body.toReview, []); assert.deepEqual(inbox.body.submitted, []); assert.equal(inbox.body.notifications.length, 2);
  assert.deepEqual(inbox.body.notifications.map((item) => item.kind).sort(), ["mention", "reply"]);
  current.notificationId = inbox.body.notifications[0]!.id;
  assert.equal((await app.request(`/api/notifications/${current.notificationId}/read`, {})).status, 200);
});
Then("未读提醒排在已读提醒之前且保留原评审和问题链接", async function (this: ApiWorld) {
  const current = state(this), app = current.app;
  const response = await app.request<{ notifications: InboxNotification[] }>("/api/notifications"); assert.equal(response.status, 200);
  const notifications = response.body.notifications; assert.equal(notifications[0]!.readAt, null); assert.ok(notifications[1]!.readAt);
  const review = [...current.reviews.values()][0]!;
  for (const notification of notifications) { assert.equal(notification.reviewId, review.id); assert.equal(notification.findingId, review.findings[0]!.id); assert.deepEqual(notification.review.conclusion, review.conclusion); }
  assert.equal((await app.request<{ count: number }>("/api/collaboration/unread")).body.count, 1);
});
Then("张伟不能把李娜的提醒标记已读", async function (this: ApiWorld) {
  const current = state(this), app = current.app; await app.request("/api/auth/login", { username: "zhangwei", password: "fixture-password-long" });
  assert.equal((await app.request(`/api/notifications/${current.notificationId}/read`, {})).status, 404);
});
