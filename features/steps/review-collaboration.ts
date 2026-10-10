import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { createCollaborationFixture } from "../../packages/server/src/collaboration/test-support.js";
import Fastify from "fastify";
import { GitLabHistoryReader } from "../../packages/server/src/rules/history.js";
import type { DiscussionComment } from "../../packages/server/src/collaboration/types.js";
interface DiscussionThread { comments: DiscussionComment[]; unreadIds: string[] }
interface Participation { currentUserId: string; participants: Array<{ userId: string; viewedAt: string; completedAt: string | null }> }
interface Unread { count: number }

import type { PlatformDiscussion } from "../../packages/server/src/collaboration/types.js";

type Fixture = Awaited<ReturnType<typeof createCollaborationFixture>>;
class CollaborationScenario {
  fixture!: Fixture;
  baseUrl = "";
  cookies = new Map<string, string>();
  historyUnavailable = false;
  history: PlatformDiscussion[] = [];
  platformRequests: string[] = [];
  platform = Fastify();
  commentId = "";
  lastStatus = 0;
  lastError = "";
  async start() {
    this.platform.all("/api/v4/projects/1/merge_requests/1/discussions", async (request, reply) => {
      this.platformRequests.push(request.method);
      if (this.historyUnavailable) return reply.code(503).send({ error: "平台暂不可用" });
      return this.history.map((thread) => ({ id: thread.id, notes: thread.notes.map((note) => ({
        id: Number(note.id), author: { id: 16, username: note.author, bot: false }, body: note.body,
        created_at: note.createdAt, system: false, resolved: thread.resolved,
      })) }));
    });
    const instanceUrl = await this.platform.listen({ host: "127.0.0.1", port: 0 });
    const history = new GitLabHistoryReader({ getCredentials: async (id) => ({
      id, instanceUrl, projectId: 1, pathWithNamespace: "commerce/inventory", webUrl: "https://gitlab.example.test/commerce/inventory",
      httpUrlToRepo: `${instanceUrl}/commerce/inventory.git`, token: "fixture-read-only-token",
    }) });
    this.fixture = await createCollaborationFixture({ authenticated: true, history, transport: async () => { throw new Error("出口不可用"); } });
    this.baseUrl = await this.fixture.app.listen({ host: "127.0.0.1", port: 0 });
    for (const actor of ["alice", "bob"]) {
      const response = await fetch(`${this.baseUrl}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json", "x-ureview-request": "1" }, body: JSON.stringify({ username: actor, password: "Fixture-password-2026" }) });
      assert.equal(response.status, 200); await response.json();
      const cookie = response.headers.get("set-cookie")?.split(";")[0]; assert.ok(cookie); this.cookies.set(actor, cookie);
    }
  }
  async request<T>(actor: "alice" | "bob", path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, { method, headers: { cookie: this.cookies.get(actor)!, "content-type": "application/json", "x-ureview-request": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    this.lastStatus = response.status;
    const value = await response.json() as T;
    if (response.status >= 400) this.lastError = (value as { error: { message: string } }).error.message;
    return value;
  }
  async close() { await this.fixture?.service.stop(); await this.fixture?.close(); await this.platform.close(); }
}
const scenarios = new WeakMap<ApiWorld, CollaborationScenario>();
const scenario = (world: ApiWorld) => { const value = scenarios.get(world); assert.ok(value); return value; };
Before({ tags: "@story:review-collaboration" }, async function (this: ApiWorld) { const value = new CollaborationScenario(); scenarios.set(this, value); await value.start(); });
After({ tags: "@story:review-collaboration" }, async function (this: ApiWorld) { await scenarios.get(this)?.close(); });

Given("库存预留评审中已有张伟和李娜两位团队成员", async function (this: ApiWorld) {
  const s = scenario(this); const result = await s.request<{ members: Array<{ id: string }> }>("alice", "/api/collaboration/members");
  assert.equal(result.members.length, 2);
});
When("张伟在库存越界问题下提醒李娜并重复提交同一条讨论", async function (this: ApiWorld) {
  const s = scenario(this); const input = { requestId: randomUUID(), body: "李娜，请确认预留数量超过库存时的边界", mentions: [s.fixture.bob.userId] };
  const first = await s.request<{ comment: { id: string } }>("alice", s.fixture.route, input); assert.equal(s.lastStatus, 201);
  s.commentId = first.comment.id;
  const repeated = await s.request<{ comment: { id: string }; created: boolean }>("alice", s.fixture.route, input);
  assert.equal(s.lastStatus, 200); assert.equal(repeated.comment.id, s.commentId); assert.equal(repeated.created, false);
});
When("李娜回复张伟的讨论", async function (this: ApiWorld) {
  const s = scenario(this); await s.request("bob", s.fixture.route, { requestId: randomUUID(), body: "库存不足时确实应该拒绝预留", parentId: s.commentId }); assert.equal(s.lastStatus, 201);
});
Then("讨论串只有原文和回复两条记录", async function (this: ApiWorld) { const s = scenario(this); const result = await s.request<DiscussionThread>("alice", s.fixture.route); assert.equal(result.comments.length, 2); assert.equal(result.comments[1]!.parentId, s.commentId); });
Then("张伟和李娜各有一条未读讨论", async function (this: ApiWorld) { const s = scenario(this); for (const actor of ["alice", "bob"] as const) assert.equal((await s.request<Unread>(actor, "/api/collaboration/unread")).count, 1); });
When("张伟阅读自己的讨论提醒", async function (this: ApiWorld) { const s = scenario(this); const thread = await s.request<DiscussionThread>("alice", s.fixture.route); await s.request("alice", `${s.fixture.route}/read`, { ids: thread.unreadIds }); });
Then("张伟没有未读讨论而李娜仍有一条", async function (this: ApiWorld) { const s = scenario(this); assert.equal((await s.request<Unread>("alice", "/api/collaboration/unread")).count, 0); assert.equal((await s.request<Unread>("bob", "/api/collaboration/unread")).count, 1); });
Given("张伟已经就库存越界问题发表讨论", async function (this: ApiWorld) { const s = scenario(this); const result = await s.request<{ comment: { id: string } }>("alice", s.fixture.route, { requestId: randomUUID(), body: "库存预留不能产生负库存" }); assert.equal(s.lastStatus, 201); s.commentId = result.comment.id; });
When("张伟尝试在订单金额问题下回复该讨论", async function (this: ApiWorld) { const s = scenario(this); await s.request("alice", `/api/reviews/${s.fixture.secondReviewId}/findings/${s.fixture.secondFindingId}/comments`, { requestId: randomUUID(), body: "错误的回复位置", parentId: s.commentId }); });
Then("工作台提示只能回复当前发现的问题", function (this: ApiWorld) { const s = scenario(this); assert.equal(s.lastStatus, 400); assert.match(s.lastError, /只能回复当前/); });
Then("订单金额问题下没有新增讨论", async function (this: ApiWorld) { const s = scenario(this); const value = await s.request<DiscussionThread>("alice", `/api/reviews/${s.fixture.secondReviewId}/findings/${s.fixture.secondFindingId}/comments`); assert.equal(value.comments.length, 0); });
When("张伟标记库存预留评审已经看完", async function (this: ApiWorld) { const s = scenario(this); await s.request("alice", `/api/reviews/${s.fixture.reviewId}/participation`, { completed: true }, "PUT"); assert.equal(s.lastStatus, 200); });
Then("李娜看到张伟已经看完而自己尚未看完", async function (this: ApiWorld) { const s = scenario(this); const value = await s.request<Participation>("bob", `/api/reviews/${s.fixture.reviewId}/participation`); assert.equal(value.currentUserId, s.fixture.bob.userId); assert.ok(value.participants.find((user) => user.userId === s.fixture.alice.userId)?.completedAt); assert.ok(!value.participants.find((user) => user.userId === s.fixture.bob.userId)?.completedAt); });
When("张伟取消看完标记", async function (this: ApiWorld) { const s = scenario(this); await s.request("alice", `/api/reviews/${s.fixture.reviewId}/participation`, { completed: false }, "PUT"); });
Then("张伟的参与记录保留为已查看", async function (this: ApiWorld) { const s = scenario(this); const value = await s.request<Participation>("bob", `/api/reviews/${s.fixture.reviewId}/participation`); const participant = value.participants.find((user) => user.userId === s.fixture.alice.userId); assert.ok(participant?.viewedAt); assert.equal(participant.completedAt, null); });
Given("GitLab 已有人工库存讨论", function (this: ApiWorld) { scenario(this).history = [{ id: "stock-thread", resolved: true, notes: [{ id: "16", author: "陈明", body: "预留数量超过库存时应拒绝", createdAt: "2026-10-04T00:00:00Z", url: "https://gitlab.example.test/commerce/inventory/-/merge_requests/1#note_16" }] }]; });
When("张伟查看平台历史讨论", async function (this: ApiWorld) { const s = scenario(this); await s.request("alice", `/api/reviews/${s.fixture.reviewId}/platform-discussions`); assert.equal(s.lastStatus, 200); });
Then("能看到 GitLab 人工讨论的作者正文和原文链接", async function (this: ApiWorld) { const s = scenario(this); const value = await s.request<{ discussions: PlatformDiscussion[] }>("alice", `/api/reviews/${s.fixture.reviewId}/platform-discussions`); assert.equal(value.discussions.length, 1); assert.equal(value.discussions[0]!.notes[0]!.author, "陈明"); assert.equal(value.discussions[0]!.notes[0]!.body, "预留数量超过库存时应拒绝"); assert.match(value.discussions[0]!.notes[0]!.url, /merge_requests\/1#note_16$/); });
When("GitLab 历史讨论暂时不可用", function (this: ApiWorld) { scenario(this).historyUnavailable = true; });
Then("工作台明确提示历史讨论读取失败且站内讨论仍然存在", async function (this: ApiWorld) { const s = scenario(this); const value = await s.request<{ error: string }>("alice", `/api/reviews/${s.fixture.reviewId}/platform-discussions`); assert.match(value.error, /无法读取/); assert.equal((await s.request<DiscussionThread>("alice", s.fixture.route)).comments.length, 1); });
Then("GitLab 没有被写入新讨论", function (this: ApiWorld) { const s = scenario(this); assert.ok(s.platformRequests.length >= 1); assert.ok(s.platformRequests.every((method) => method === "GET")); });
Given("管理员已配置一个暂时不可用的通知出口", async function (this: ApiWorld) { const s = scenario(this); await s.request("alice", "/api/notification-settings", { endpoint: "https://notifications.example.test/hook" }, "PUT"); assert.equal(s.lastStatus, 200); s.fixture.service.start(); });
Then("站内讨论已保存且李娜收到一条未读提示", async function (this: ApiWorld) { const s = scenario(this); assert.equal((await s.request<DiscussionThread>("alice", s.fixture.route)).comments.length, 1); assert.equal((await s.request<Unread>("bob", "/api/collaboration/unread")).count, 1); });
Then("通知出口达到重试上限后显示失败", async function (this: ApiWorld) { const s = scenario(this); const deadline = Date.now() + 10_000; let failed = 0; while (Date.now() < deadline) { const value = await s.request<{ deliveries: Record<string, number> }>("alice", "/api/notification-settings"); failed = value.deliveries.failed ?? 0; if (failed) break; await new Promise((resolve) => setTimeout(resolve, 100)); } assert.equal(failed, 1); });
