import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { AgentSessionPage } from "../../packages/server/src/agent-sessions/types.js";
import { fixturePassword } from "../../packages/server/src/auth/test-support.js";
import { withTeam } from "../../packages/server/src/db/tenant.js";
import type { Inbox } from "../../packages/server/src/inbox/service.js";
import type { InstanceHealth } from "../../packages/server/src/instance-health/types.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";
import type { ManagedRule } from "../../packages/server/src/rules/managed-types.js";
import type { TeamOverview } from "../../packages/server/src/team-overview/service.js";
import { RepositoryDetailScenario } from "../support/repository-detail-scenario.js";
import { releaseCode, releasePath, startReviewGitLab } from "../support/review-gitlab-fixture.js";
import type { ApiWorld } from "../support/world.js";

interface Preview {
  repositoryId: string;
  pathWithNamespace: string;
  counts: { reviews: number; findings: number; discussionComments: number; agentSessions: number;
    webhookEvents: number; repositoryRules: number; historicalCandidates: number; managedRules: number };
  runningReviews: number;
}
interface Result { deleted?: boolean; preview?: Preview; error?: { code: string; message: string } }
interface State {
  app: RepositoryDetailScenario;
  preview?: Preview;
  result?: { status: number; body: Result };
  review?: ReviewDetail;
  queuedId?: string;
  sessionIds: string[];
  otherGitlab?: Awaited<ReturnType<typeof startReviewGitLab>>;
  otherRepositoryId?: string;
  otherReview?: ReviewDetail;
  otherTeam?: { repositoryId: string; cookie: string };
  rule?: ManagedRule;
  requestsBefore: number;
  refused: Array<{ status: number; body: Result }>;
  outsideFile?: string;
}
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State { const value = states.get(world); assert.ok(value); return value; }
const route = (value: State, suffix = "") => `/api/repositories/${value.app.repository.id}${suffix}`;

Before({ tags: "@layer:api and @repository-deletion", timeout: 60_000 }, async function (this: ApiWorld) {
  const app = new RepositoryDetailScenario();
  const value: State = { app, requestsBefore: 0, refused: [], sessionIds: [] };
  states.set(this, value);
  await app.start({ deletion: true });
  value.requestsBefore = app.gitlab!.requests.length;
});
After({ tags: "@layer:api and @repository-deletion", timeout: 60_000 }, async function (this: ApiWorld) {
  const value = states.get(this);
  try { await value?.otherGitlab?.dispose(); }
  finally { await value?.app.stop(); states.delete(this); }
});

async function enqueue(value: State): Promise<string> {
  const response = await value.app.deliver();
  assert.equal(response.status, 202, JSON.stringify(response.body));
  assert.ok(response.body.reviewId);
  return response.body.reviewId;
}
async function runReview(value: State, id: string): Promise<ReviewDetail> {
  assert.equal(await withTeam(value.app.teamId, () => value.app.reviews!.runOnce()), true);
  return value.app.waitForReview(id);
}
async function addOtherRepository(value: State, complete = false): Promise<void> {
  value.otherGitlab = await startReviewGitLab(join(value.app.directory!, "settlement"), "settlement-service");
  const connected = await value.app.request<{ repository: { id: string } }>("/api/repositories", value.otherGitlab.input);
  assert.equal(connected.status, 201, JSON.stringify(connected.body));
  value.otherRepositoryId = connected.body.repository.id;
  const response = await value.app.request<{ id: string }>("/api/reviews", {
    url: `${value.otherGitlab.baseUrl}/${value.otherGitlab.repositoryPath}/-/merge_requests/${value.otherGitlab.iid}`,
    requestId: randomUUID(),
  });
  assert.equal(response.status, 202, JSON.stringify(response.body));
  if (complete) value.otherReview = await runReview(value, response.body.id);
  else {
    const detail = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${response.body.id}`);
    assert.equal(detail.status, 200);
    value.otherReview = detail.body.review;
  }
}
async function createSharedRule(value: State): Promise<void> {
  const repositories = [value.app.repository.id, value.otherRepositoryId!].map((repositoryId) => ({ repositoryId, paths: ["internal/**/*.go"] }));
  const response = await value.app.request<{ rule: ManagedRule }>("/api/managed-rules", {
    name: "库存释放保留幂等边界", body: "恢复库存前应确认订单库存尚未释放。", goodExample: "", badExample: "",
    category: "reliability", severity: "error", scope: "repositories", repositories, status: "active",
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  value.rule = response.body.rule;
}
async function remove(value: State): Promise<void> {
  value.result = await value.app.request<Result>(route(value), { pathWithNamespace: value.app.gitlab!.repositoryPath }, { method: "DELETE" });
}
async function assertRepositoryExists(value: State, repositoryId = value.app.repository.id, cookie = value.app.cookie): Promise<void> {
  const response = await value.app.request<{ repository: { id: string } }>(`/api/repositories/${repositoryId}`, undefined, { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.repository.id, repositoryId);
}

Given("库存服务已经接入工作台", async function (this: ApiWorld) { await assertRepositoryExists(state(this)); });
Given("库存服务已有评审、finding、讨论、会话、仓库规范和历史候选", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), app = value.app;
  app.gitlab!.state.reviewers = ["zhangwei"];
  assert.equal((await app.request("/api/account/identities", {
    gitlab: [{ instanceUrl: app.gitlab!.baseUrl, username: "zhangwei" }], mobile: null, feishuOpenId: null, feishuUserId: null,
  }, { method: "PUT" })).status, 200);
  value.review = await runReview(value, await enqueue(value));
  assert.equal(value.review.findings.length, 1);
  const members = await app.request<{ members: Array<{ id: string; name: string }> }>("/api/team/members");
  const member = members.body.members.find((entry) => entry.name === "李娜"); assert.ok(member);
  const comments = `/api/reviews/${value.review.id}/findings/${value.review.findings[0]!.id}/comments`;
  const first = await app.request<{ comment: { id: string } }>(comments, {
    requestId: randomUUID(), body: "李娜，请确认库存释放是否有幂等检查。", mentions: [member.id],
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal((await app.request(comments, { requestId: randomUUID(), body: "订单状态已经提供幂等判断。", parentId: first.body.comment.id }, { cookie: app.memberCookie })).status, 201);
  assert.equal((await app.request(`/api/reviews/${value.review.id}/findings/${value.review.findings[0]!.id}/disposition`,
    { status: "Resolved", version: 0 }, { method: "PATCH" })).status, 200);
  const sessions = await app.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${value.review.id}`);
  assert.equal(sessions.status, 200); assert.ok(sessions.body.total >= 2);
  value.sessionIds = sessions.body.items.map((entry) => entry.id);
  await app.gitlab!.commitFiles({ ".agents/rules/inventory.md": "---\nname: 库存恢复约定\npaths:\n  - internal/**/*.go\n---\n库存恢复必须保留订单级幂等检查。\n" }, "global");
  assert.equal((await app.request(`/api/rules/repositories/${app.repository.id}/sync`, {})).status, 200);
  // 历史挖掘已由独立场景验证，这里构造已存在的候选及其采纳证据。
  const candidateId = randomUUID(), body = "恢复库存前应校验订单当前的释放状态。";
  const candidate = { key: "inventory-release-state", body, suggestedPath: ".agents/rules/inventory-release.md", markdown: body,
    evidence: [5, 6].map((iid) => ({ iid, pullRequestUrl: `${app.gitlab!.baseUrl}/${app.gitlab!.repositoryPath}/-/merge_requests/${iid}`,
      commentUrl: `${app.gitlab!.baseUrl}/${app.gitlab!.repositoryPath}/-/merge_requests/${iid}#note_35`, author: "li.na@example.test",
      path: "internal/inventory/release.go", before: "restoreStock(orderID)", after: "restoreOnce(orderID)",
      beforeSha: app.gitlab!.baseSha, afterSha: app.gitlab!.headSha, commitUrl: `${app.gitlab!.baseUrl}/${app.gitlab!.repositoryPath}/-/commit/${app.gitlab!.headSha}` })) };
  await withTeam(app.teamId, async () => {
    await app.identity.pool.query("INSERT INTO rule_candidates(id,repository_id,candidate_key,payload) VALUES($1,$2,$3,$4)",
      [candidateId, app.repository.id, candidate.key, JSON.stringify(candidate)]);
    await app.identity.pool.query("INSERT INTO rule_proposals(id,source,candidate_id,repository_id,name,body) VALUES($1,'mining',$2,$3,'库存释放约定',$4)",
      [randomUUID(), candidateId, app.repository.id, body]);
  });
  const inbox = await app.request<Inbox>("/api/inbox");
  assert.equal(inbox.status, 200); assert.equal(inbox.body.notifications.length, 1);
  const memberInbox = await app.request<Inbox>("/api/inbox", undefined, { cookie: app.memberCookie });
  assert.equal(memberInbox.body.notifications.length, 1);
});
Given("库存服务还有排队中的评审且结算服务已有独立评审", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this);
  await addOtherRepository(value, true);
  await value.app.gitlab!.nextPullRequest();
  value.queuedId = await enqueue(value);
  await createSharedRule(value);
  value.requestsBefore = value.app.gitlab!.requests.length;
});
When("张伟查看库存服务的删除影响", async function (this: ApiWorld) {
  const value = state(this);
  const response = await value.app.request<{ preview: Preview }>(route(value, "/deletion-preview"));
  assert.equal(response.status, 200, JSON.stringify(response.body)); value.preview = response.body.preview;
});
Then("预览准确列出各类关联记录和受影响的工作台规范数量", function (this: ApiWorld) {
  const value = state(this); assert.ok(value.preview);
  assert.equal(value.preview.repositoryId, value.app.repository.id);
  assert.equal(value.preview.pathWithNamespace, value.app.gitlab!.repositoryPath);
  assert.equal(value.preview.runningReviews, 0);
  assert.deepEqual(value.preview.counts, { reviews: 2, findings: 1, discussionComments: 2, agentSessions: value.sessionIds.length,
    webhookEvents: 2, repositoryRules: 1, historicalCandidates: 1, managedRules: 1 });
});
When("张伟输入完整仓库路径确认删除库存服务", async function (this: ApiWorld) { await remove(state(this)); });
Then("删除结果的数量与预览一致且库存服务关联内容无法再查看", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.result!.status, 200, JSON.stringify(value.result!.body));
  assert.equal(value.result!.body.deleted, true); assert.deepEqual(value.result!.body.preview, value.preview);
  for (const path of [route(value), route(value, "/events"), route(value, "/deletion-preview"),
    `/api/reviews/${value.review!.id}`, `/api/reviews/${value.queuedId}`, ...value.sessionIds.map((id) => `/api/agent-sessions/${id}`),
    `/api/reviews/${value.review!.id}/findings/${value.review!.findings[0]!.id}/comments`]) {
    assert.equal((await value.app.request(path)).status, 404, path);
  }
  const catalog = await value.app.request<{ rules: unknown[]; lints: unknown[]; sync: unknown[] }>("/api/rules");
  assert.equal(catalog.status, 200); assert.deepEqual(catalog.body.rules, []); assert.deepEqual(catalog.body.lints, []); assert.deepEqual(catalog.body.sync, []);
  const candidates = await value.app.request<{ candidates: unknown[] }>("/api/rule-candidates");
  assert.equal(candidates.status, 200); assert.deepEqual(candidates.body.candidates, []);
  const proposals = await value.app.request<{ proposals: unknown[] }>("/api/rule-proposals");
  assert.equal(proposals.status, 200); assert.deepEqual(proposals.body.proposals, []);
});
Then("仓库列表、评审列表、待办、团队概览和实例健康已移除库存服务的数据", async function (this: ApiWorld) {
  const value = state(this), app = value.app;
  const repositories = await app.request<{ repositories: Array<{ id: string }> }>("/api/repositories");
  assert.equal(repositories.status, 200); assert.deepEqual(repositories.body.repositories.map((entry) => entry.id), [value.otherRepositoryId]);
  const reviews = await app.request<{ reviews: Array<{ id: string }> }>("/api/reviews");
  assert.equal(reviews.status, 200); assert.deepEqual(reviews.body.reviews.map((entry) => entry.id), [value.otherReview!.id]);
  for (const cookie of [app.cookie, app.memberCookie]) {
    const inbox = await app.request<Inbox>("/api/inbox", undefined, { cookie });
    assert.equal(inbox.status, 200); assert.deepEqual(inbox.body.notifications, []);
    assert.deepEqual(inbox.body.toReview, []); assert.deepEqual(inbox.body.submitted, []);
  }
  const overview = await app.request<TeamOverview>("/api/team-overview");
  assert.equal(overview.status, 200); assert.equal(overview.body.reviewRounds, 1);
  assert.equal(overview.body.findings.high, value.otherReview!.findings.length);
  const health = await app.request<{ health: InstanceHealth }>("/api/instance-health");
  assert.equal(health.status, 200); assert.equal(health.body.health.queue.queued, 0); assert.equal(health.body.health.queue.running, 0);
  assert.ok(health.body.health.modelMetrics.length >= 2);
  assert.ok(health.body.health.modelMetrics.every((entry) => entry.total === 1));
});
Then("结算服务的评审与仓库记录保持不变", async function (this: ApiWorld) {
  const value = state(this); await assertRepositoryExists(value, value.otherRepositoryId);
  const review = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${value.otherReview!.id}`);
  assert.equal(review.status, 200); assert.deepEqual(review.body.review, value.otherReview);
});
Then("预览和删除没有向代码平台发出请求", function (this: ApiWorld) {
  const value = state(this); assert.equal(value.app.gitlab!.requests.length, value.requestsBefore); assert.deepEqual(value.app.gitlab!.state.writes, []);
});

Given("库存服务有一轮进行中的评审", async function (this: ApiWorld) {
  const value = state(this); value.queuedId = await enqueue(value);
  const claimed = await withTeam(value.app.teamId, () => value.app.reviews!.store.claim());
  assert.equal(claimed?.id, value.queuedId);
  const response = await value.app.request<{ preview: Preview }>(route(value, "/deletion-preview"));
  assert.equal(response.status, 200); assert.equal(response.body.preview.runningReviews, 1);
});
Then("工作台提示等待评审结束且仓库与评审仍然存在", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.result!.status, 409);
  assert.equal(value.result!.body.error?.code, "repository_review_running"); assert.match(value.result!.body.error!.message, /等待.*结束/);
  await assertRepositoryExists(value);
  const review = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${value.queuedId}`);
  assert.equal(review.status, 200); assert.equal(review.body.review.status, "running");
});

Given("库存服务已经接入且物流团队接入了同一项目", async function (this: ApiWorld) {
  const value = state(this), app = value.app;
  const team = await app.request<{ id: string }>("/api/admin/teams", { name: "物流研发团队" }); assert.equal(team.status, 201);
  const login = await app.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" });
  assert.equal(login.status, 200);
  assert.equal((await app.request("/api/auth/team", { teamId: team.body.id }, { cookie: login.cookie })).status, 200);
  const connected = await app.request<{ repository: { id: string } }>("/api/repositories", app.gitlab!.input, { cookie: login.cookie });
  assert.equal(connected.status, 201); value.otherTeam = { repositoryId: connected.body.repository.id, cookie: login.cookie };
});
async function attemptBoth(value: State, cookie: string): Promise<void> {
  value.refused = [await value.app.request<Result>(route(value, "/deletion-preview"), undefined, { cookie }),
    await value.app.request<Result>(route(value), { pathWithNamespace: value.app.gitlab!.repositoryPath }, { method: "DELETE", cookie })];
}
When("李娜尝试预览和删除库存服务", async function (this: ApiWorld) { const value = state(this); await attemptBoth(value, value.app.memberCookie); });
Then("两项操作均提示需要团队管理员权限", async function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(value.refused.map((result) => result.status), [403, 403]); await assertRepositoryExists(value);
});
When("张伟在物流团队中尝试预览和删除原团队的库存服务", async function (this: ApiWorld) { const value = state(this); await attemptBoth(value, value.otherTeam!.cookie); });
Then("两项操作均提示仓库不存在", async function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(value.refused.map((result) => result.status), [404, 404]); await assertRepositoryExists(value);
});
When("张伟在原团队输入完整仓库路径删除库存服务", async function (this: ApiWorld) { await remove(state(this)); });
Then("物流团队同名项目的仓库记录仍然存在", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.result!.status, 200); await assertRepositoryExists(value, value.otherTeam!.repositoryId, value.otherTeam!.cookie);
});

When("张伟分别使用空路径、路径片段、不同大小写和带空白的路径确认删除", async function (this: ApiWorld) {
  const value = state(this), path = value.app.gitlab!.repositoryPath;
  for (const pathWithNamespace of ["", "inventory-service", path.toUpperCase(), ` ${path}`, `${path} `]) {
    value.refused.push(await value.app.request<Result>(route(value), { pathWithNamespace }, { method: "DELETE" }));
    await assertRepositoryExists(value);
  }
});
Then("每次均提示仓库路径不匹配且保留原仓库", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.refused.length, 5);
  for (const response of value.refused) { assert.equal(response.status, 400); assert.equal(response.body.error?.code, "repository_path_mismatch"); }
  await assertRepositoryExists(value);
});
Then("旧仓库事件地址提示仓库不存在", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.result!.status, 200, JSON.stringify(value.result!.body));
  assert.equal((await value.app.deliver()).status, 404);
});
Then("删除和旧地址接收事件没有向代码平台发出请求", function (this: ApiWorld) {
  const value = state(this); assert.equal(value.app.gitlab!.requests.length, value.requestsBefore); assert.deepEqual(value.app.gitlab!.state.writes, []);
});
When("张伟重新接入同一个库存服务项目", async function (this: ApiWorld) {
  const value = state(this);
  const response = await value.app.request<{ repository: { id: string } }>("/api/repositories", value.app.gitlab!.input);
  assert.equal(response.status, 201, JSON.stringify(response.body)); value.otherRepositoryId = response.body.repository.id;
});
Then("新仓库具有不同的标识且没有原仓库的评审与事件", async function (this: ApiWorld) {
  const value = state(this); assert.notEqual(value.otherRepositoryId, value.app.repository.id);
  await assertRepositoryExists(value, value.otherRepositoryId);
  const reviews = await value.app.request<{ reviews: unknown[] }>(`/api/repositories/${value.otherRepositoryId}/reviews`);
  assert.equal(reviews.status, 200); assert.deepEqual(reviews.body.reviews, []);
  const events = await value.app.request<{ events: unknown[] }>(`/api/repositories/${value.otherRepositoryId}/events`);
  assert.equal(events.status, 200); assert.deepEqual(events.body.events, []);
});

Given("库存服务与结算服务各有遗留工作副本且共同应用一条工作台规范", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this); value.review = await runReview(value, await enqueue(value));
  await addOtherRepository(value, true); await createSharedRule(value);
  // 进程中断可能留下已完成评审的工作副本；正常 worker 会在结束时清理目录。
  for (const review of [value.review, value.otherReview!]) {
    const directory = join(value.app.directory!, "worktrees", review.id);
    const file = join(directory, "checkout-retained", releasePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, releaseCode);
    await writeFile(join(directory, "retained-marker.txt"), review.repositoryId);
  }
  value.outsideFile = join(value.app.directory!, "retained-marker.txt");
  await writeFile(value.outsideFile, "目录外的文件");
});
Then("库存服务的工作副本已清理且结算服务与目录外文件保持不变", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.result!.status, 200, JSON.stringify(value.result!.body));
  const root = join(value.app.directory!, "worktrees");
  await assert.rejects(access(join(root, value.review!.id)), { code: "ENOENT" });
  assert.equal(await readFile(join(root, value.otherReview!.id, "retained-marker.txt"), "utf8"), value.otherRepositoryId);
  assert.equal(await readFile(join(root, value.otherReview!.id, "checkout-retained", releasePath), "utf8"), releaseCode);
  assert.equal(await readFile(value.outsideFile!, "utf8"), "目录外的文件");
});
Then("工作台规范保留且作用范围只剩结算服务", async function (this: ApiWorld) {
  const value = state(this);
  const response = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(response.status, 200); assert.equal(response.body.rules.length, 1);
  const rule = response.body.rules[0]!;
  assert.equal(rule.version, value.rule!.version + 1);
  assert.ok(Date.parse(rule.updatedAt) >= Date.parse(value.rule!.updatedAt));
  assert.deepEqual(rule, { ...value.rule!, version: rule.version, updatedAt: rule.updatedAt,
    repositories: value.rule!.repositories.filter((entry) => entry.repositoryId === value.otherRepositoryId) });
});
