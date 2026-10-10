import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ReviewDetail, ReviewSummary } from "../../packages/server/src/reviews/types.js";
import { RepositoryDetailScenario, type DetailRepository, type RepositoryEvent, type WebhookCheck } from "../support/repository-detail-scenario.js";
import type { ApiWorld } from "../support/world.js";

interface State {
  app: RepositoryDetailScenario;
  current?: DetailRepository;
  review?: ReviewDetail;
  rerun?: ReviewDetail;
  queuedId?: string;
  firstEvents?: RepositoryEvent[];
  failureTimes?: string[];
  failureStart?: number;
  failureEnd?: number;
  checks?: WebhookCheck[];
  unreadable?: WebhookCheck;
  checkRequestStart?: number;
  memberStatuses?: number[];
}
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State { const value = states.get(world); assert.ok(value); return value; }
const route = (value: State, suffix = "") => `/api/repositories/${value.app.repository.id}${suffix}`;
const rawSentinel = "PRIVATE_WEBHOOK_PAYLOAD_REPOSITORY_DETAIL";

Before({ tags: "@layer:api and @story:repository-detail and not @repository-deletion", timeout: 60_000 }, async function (this: ApiWorld) {
  const app = new RepositoryDetailScenario(); states.set(this, { app }); await app.start();
});
After({ tags: "@layer:api and @story:repository-detail and not @repository-deletion", timeout: 60_000 }, async function (this: ApiWorld) {
  await states.get(this)?.app.stop(); states.delete(this);
});

Given("张伟管理的库存服务仓库已开启自动评审", async function (this: ApiWorld) {
  const value = state(this);
  const result = await value.app.request<{ repository: DetailRepository }>(route(value));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.repository.automaticReviewEnabled, true);
  assert.ok(Number.isSafeInteger(result.body.repository.automaticReviewVersion));
  assert.ok(result.body.repository.automaticReviewVersion >= 1);
  value.current = result.body.repository;
});
Given("张伟管理的库存服务仓库尚未收到事件", async function (this: ApiWorld) {
  const value = state(this), events = await value.app.events();
  assert.deepEqual(events.events, []);
  assert.equal(events.webhook.lastAuthenticationFailureAt, null);
});
When("张伟关闭库存服务的自动评审", async function (this: ApiWorld) {
  const value = state(this);
  const result = await value.app.request<{ repository: DetailRepository }>(route(value, "/automatic-review"),
    { enabled: false, version: value.current!.automaticReviewVersion }, { method: "PUT" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.repository.automaticReviewEnabled, false);
  assert.equal(result.body.repository.automaticReviewVersion, value.current!.automaticReviewVersion + 1);
  value.current = result.body.repository;
});
When("库存服务收到新合并请求的通知", async function (this: ApiWorld) {
  const result = await state(this).app.deliver();
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(result.body.ignored, true);
});
Then("最近事件说明自动评审已关闭且仓库没有产生评审", async function (this: ApiWorld) {
  const value = state(this), events = await value.app.events();
  assert.equal(events.events.length, 1);
  assert.equal(events.events[0]!.result, "ignored");
  assert.equal(events.events[0]!.reason, "自动评审已关闭");
  assert.equal(events.events[0]!.iid, value.app.gitlab!.iid);
  assert.equal(events.events[0]!.reviewId, null);
  const reviews = await value.app.request<{ reviews: ReviewSummary[] }>(route(value, "/reviews"));
  assert.equal(reviews.status, 200);
  assert.deepEqual(reviews.body.reviews, []);
  assert.equal(value.app.model!.requests.length, 0);
});
Then("张伟使用旧版本设置时看到配置已被修改", async function (this: ApiWorld) {
  const value = state(this);
  const stale = await value.app.request(route(value, "/automatic-review"),
    { enabled: true, version: value.app.repository.automaticReviewVersion }, { method: "PUT" });
  assert.equal(stale.status, 409);
  assert.match(JSON.stringify(stale.body), /automatic_review_conflict/);
});
When("李娜手动发起该库存变更的评审并在完成后重跑", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), gitlab = value.app.gitlab!;
  const first = await value.app.request<{ id: string }>("/api/reviews", {
    url: `${gitlab.baseUrl}/${gitlab.repositoryPath}/-/merge_requests/${gitlab.iid}`, requestId: randomUUID(),
  }, { cookie: value.app.memberCookie });
  assert.equal(first.status, 202, JSON.stringify(first.body));
  value.review = await value.app.waitForReview(first.body.id);
  const second = await value.app.request<{ reviewId: string }>(`/api/reviews/${first.body.id}/rerun`,
    { requestId: randomUUID() }, { cookie: value.app.memberCookie });
  assert.equal(second.status, 202, JSON.stringify(second.body));
  value.rerun = await value.app.waitForReview(second.body.reviewId);
});
Then("两轮评审均完成且仓库的自动评审仍然关闭", async function (this: ApiWorld) {
  const value = state(this);
  assert.equal(value.review!.status, "completed");
  assert.equal(value.rerun!.status, "completed");
  assert.equal(value.rerun!.round, value.review!.round + 1);
  assert.notEqual(value.review!.id, value.rerun!.id);
  assert.ok(value.app.model!.requests.some((request) => request.body.model === "fixture-generator"));
  assert.ok(value.app.model!.requests.some((request) => request.body.model === "fixture-grader"));
  const repositories = await value.app.request<{ repositories: DetailRepository[] }>("/api/repositories");
  assert.equal(repositories.status, 200);
  assert.equal(repositories.body.repositories.find((repository) => repository.id === value.app.repository.id)?.automaticReviewEnabled, false);
  assert.equal((await value.app.events()).events.length, 1);
  assert.deepEqual(value.app.gitlab!.state.writes, []);
});

When("库存服务依次收到新合并请求通知、同一通知的重复投递和关闭通知", async function (this: ApiWorld) {
  const value = state(this), deliveryId = randomUUID();
  const queued = await value.app.deliver(undefined, { deliveryId });
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  assert.equal(queued.body.created, true);
  assert.ok(queued.body.reviewId);
  value.queuedId = queued.body.reviewId;
  const duplicate = await value.app.deliver(undefined, { deliveryId });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.created, false);
  assert.equal(duplicate.body.reviewId, value.queuedId);
  const payload = value.app.gitlab!.event();
  const ignored = await value.app.deliver({ ...payload, object_attributes: { ...payload.object_attributes, action: "close" }, private_note: rawSentinel });
  assert.equal(ignored.status, 202);
  assert.equal(ignored.body.ignored, true);
});
Then("最近事件分别记录已入队、重复投递和已忽略并关联对应评审轮次", async function (this: ApiWorld) {
  const value = state(this), events = (await value.app.events()).events;
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.result), ["ignored", "duplicate", "queued"]);
  const review = await value.app.waitForReview(value.queuedId!);
  for (const event of events) {
    assert.equal(event.iid, value.app.gitlab!.iid);
    assert.ok(event.eventType.length > 0);
    assert.ok(Number.isFinite(Date.parse(event.receivedAt)));
    if (event.result === "ignored") {
      assert.equal(event.action, "close");
      assert.ok(event.reason);
      assert.equal(event.reviewId, null);
      assert.equal(event.reviewRound, null);
    } else {
      assert.equal(event.action, "open");
      assert.equal(event.reviewId, review.id);
      assert.equal(event.reviewRound, review.round);
    }
  }
  value.firstEvents = events;
});
When("库存服务继续收到一百零一条关闭通知", async function (this: ApiWorld) {
  const value = state(this), payload = value.app.gitlab!.event();
  for (let index = 0; index < 101; index++) {
    const response = await value.app.deliver({ ...payload,
      object_attributes: { ...payload.object_attributes, action: "close", iid: 30 + index }, private_note: rawSentinel });
    assert.equal(response.status, 202, JSON.stringify(response.body));
  }
});
Then("张伟只能按接收时间倒序查看最新一百条事件且看不到原始载荷", async function (this: ApiWorld) {
  const value = state(this), result = await value.app.events();
  assert.equal(result.events.length, 100);
  assert.deepEqual(result.events.map((event) => event.iid), Array.from({ length: 100 }, (_, index) => 130 - index));
  assert.ok(result.events.every((event) => !value.firstEvents!.some((previous) => previous.id === event.id)));
  const fields = ["id", "receivedAt", "eventType", "action", "iid", "result", "reason", "reviewId", "reviewRound"].sort();
  for (const [index, event] of result.events.entries()) {
    assert.deepEqual(Object.keys(event).sort(), fields);
    assert.equal(event.result, "ignored");
    if (index) assert.ok(Date.parse(result.events[index - 1]!.receivedAt) >= Date.parse(event.receivedAt));
  }
  assert.ok(!JSON.stringify(result).includes(rawSentinel));
  assert.ok(!JSON.stringify(result).includes(value.app.webhookToken));
});

When("库存服务连续收到两次密钥不匹配的新合并请求通知", async function (this: ApiWorld) {
  const value = state(this); value.failureStart = await value.app.databaseTime(); value.failureTimes = [];
  for (let index = 0; index < 2; index++) {
    const response = await value.app.deliver(undefined, { token: "wrong-webhook-secret" });
    assert.equal(response.status, 401);
    const events = await value.app.events();
    assert.ok(events.webhook.lastAuthenticationFailureAt);
    value.failureTimes.push(events.webhook.lastAuthenticationFailureAt);
    assert.deepEqual(events.events, []);
  }
  value.failureEnd = await value.app.databaseTime();
});
Then("接入信息显示最近一次鉴权失败时间且没有事件记录或评审", async function (this: ApiWorld) {
  const value = state(this), times = value.failureTimes!.map((time) => Date.parse(time));
  assert.ok(times.every((time) => time >= value.failureStart! && time <= value.failureEnd!));
  assert.ok(times[1]! >= times[0]!);
  const detail = await value.app.request<{ repository: DetailRepository }>(route(value));
  assert.equal(detail.status, 200);
  assert.equal(detail.body.repository.lastAuthenticationFailureAt, value.failureTimes![1]);
  assert.deepEqual((await value.app.events()).events, []);
  const reviews = await value.app.request<{ reviews: ReviewSummary[] }>(route(value, "/reviews"));
  assert.equal(reviews.status, 200);
  assert.deepEqual(reviews.body.reviews, []);
});

When("张伟依次检测未配置、已配置和未勾选合并请求事件的接入", async function (this: ApiWorld) {
  const value = state(this), gitlab = value.app.gitlab!;
  value.checkRequestStart = gitlab.requests.length;
  value.checks = [];
  for (const hooks of [[], [{ id: 81, url: `${value.app.publicOrigin}${route(value, "/events/gitlab")}`, merge_requests_events: true }],
    [{ id: 81, url: `${value.app.publicOrigin}${route(value, "/events/gitlab")}`, merge_requests_events: false }]]) {
    gitlab.state.hooks = hooks;
    const response = await value.app.request<{ check: WebhookCheck }>(route(value, "/webhook-check"), {});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    value.checks.push(response.body.check);
  }
});
Then("每次检测都明确说明对应的配置状态", function (this: ApiWorld) {
  const checks = state(this).checks!;
  assert.deepEqual(checks.map((check) => check.status), ["missing", "configured", "merge_request_events_disabled"]);
  assert.ok(checks.every((check) => check.message.length > 0 && Number.isFinite(Date.parse(check.checkedAt))));
});
When("仓库只读令牌无权读取配置时张伟再次检测", async function (this: ApiWorld) {
  const value = state(this); value.app.gitlab!.state.hooksStatus = 403;
  const response = await value.app.request<{ check: WebhookCheck }>(route(value, "/webhook-check"), {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  value.unreadable = response.body.check;
});
Then("检测说明无法读取配置并引导使用代码平台的测试功能", function (this: ApiWorld) {
  const check = state(this).unreadable!;
  assert.equal(check.status, "unreadable");
  assert.match(check.message, /无法读取 webhook 配置/);
  assert.match(check.message, /GitLab/);
  assert.match(check.message, /测试/);
  assert.match(check.message, /最近.*事件/);
});
Then("接入说明提供仓库事件地址与密钥配置状态且检测未修改代码平台", async function (this: ApiWorld) {
  const value = state(this), events = await value.app.events(), gitlab = value.app.gitlab!;
  assert.equal(events.webhook.url, `${value.app.publicOrigin}${route(value, "/events/gitlab")}`);
  assert.equal(events.webhook.tokenConfigured, true);
  assert.equal(events.webhook.lastAuthenticationFailureAt, null);
  assert.ok(!JSON.stringify(events).includes(value.app.webhookToken));
  assert.deepEqual(events.events, []);
  const requests = gitlab.requests.slice(value.checkRequestStart);
  assert.equal(requests.length, 4);
  assert.ok(requests.every((request) => request.method === "GET" && new URL(request.path, gitlab.baseUrl).pathname === "/api/v4/projects/42/hooks"));
  assert.deepEqual(gitlab.state.writes, []);
});

When("成员李娜读取接入信息并尝试关闭自动评审和检测接入", async function (this: ApiWorld) {
  const value = state(this), cookie = value.app.memberCookie;
  const current = await value.app.request<{ repository: DetailRepository }>(route(value), undefined, { cookie });
  assert.equal(current.status, 200);
  assert.equal(current.body.repository.automaticReviewEnabled, true);
  assert.deepEqual((await value.app.events(cookie)).events, []);
  value.checkRequestStart = value.app.gitlab!.requests.length;
  const changed = await value.app.request(route(value, "/automatic-review"),
    { enabled: false, version: current.body.repository.automaticReviewVersion }, { method: "PUT", cookie });
  const checked = await value.app.request(route(value, "/webhook-check"), {}, { cookie });
  value.memberStatuses = [changed.status, checked.status];
});
Then("李娜能看到配置且两项管理操作被拒绝", function (this: ApiWorld) {
  const value = state(this);
  assert.deepEqual(value.memberStatuses, [403, 403]);
  assert.deepEqual(value.app.gitlab!.requests.slice(value.checkRequestStart), []);
});
Then("仓库自动评审与配置版本保持不变", async function (this: ApiWorld) {
  const value = state(this), response = await value.app.request<{ repository: DetailRepository }>(route(value));
  assert.equal(response.status, 200);
  assert.equal(response.body.repository.automaticReviewEnabled, value.current!.automaticReviewEnabled);
  assert.equal(response.body.repository.automaticReviewVersion, value.current!.automaticReviewVersion);
});
