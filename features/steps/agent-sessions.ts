import assert from "node:assert/strict";
import { Before, After, Given, When, Then } from "@cucumber/cucumber";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import type { ApiWorld } from "../support/world.js";
import { AgentSessionsScenario } from "../support/agent-sessions-scenario.js";
import type { AgentSessionEvents, AgentSessionPage, AgentSessionSummary } from "../../packages/server/src/agent-sessions/types.js";
import type { RuleSession } from "../../packages/server/src/rules/sessions-types.js";

interface State { app: AgentSessionsScenario; reviewId?: string; records?: AgentSessionSummary[];
  events?: SessionEvent[]; snapshots?: Record<string, SessionEvent[]>; requestCount?: number;
  sessionId?: string; after?: number; ruleId?: string; failedId?: string; denied?: number[] }
const states = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => { const value = states.get(world); assert.ok(value); return value; };
Before({ tags: "@story:agent-sessions and @layer:api", timeout: 60_000 }, async function(this: ApiWorld) {
  const app = new AgentSessionsScenario(); states.set(this, { app }); await app.start();
});
After({ tags: "@story:agent-sessions and @layer:api", timeout: 60_000 }, async function(this: ApiWorld) { await states.get(this)?.app.stop(); states.delete(this); });
Given("张伟已接入库存服务并登录工作台", function(this: ApiWorld) { assert.ok(state(this).app.repositoryId); });
When("张伟发起库存服务的评审并等待完成", async function(this: ApiWorld) {
  const s = state(this); s.reviewId = await s.app.review(); assert.equal((await s.app.waitForReview(s.reviewId)).status, "completed");
});
Then("张伟能分别查看生成评审与核验评分的原始会话", async function(this: ApiWorld) {
  const s = state(this), result = await s.app.identity.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${s.reviewId}`);
  assert.equal(result.status, 200); assert.equal(result.body.total, 2); s.records = result.body.items;
  assert.deepEqual(s.records.map((item) => item.kind).sort(), ["review_generator", "review_grader"]);
  s.snapshots = {};
  for (const record of s.records) {
    const events = await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${record.id}/events`);
    assert.equal(events.status, 200); s.snapshots[record.id] = events.body.events;
    assert.ok(events.body.events.some((event) => event.type === "tool/call"));
    assert.ok(events.body.events.some((event) => event.type === "tool/result"));
    assert.equal(events.body.session.status, "completed");
  }
  s.requestCount = s.app.model!.requests.length;
});
When("工作台服务重新启动", async function(this: ApiWorld) { await state(this).app.restart(); });
Then("张伟仍能查看相同的会话内容", async function(this: ApiWorld) {
  const s = state(this);
  for (const [id, events] of Object.entries(s.snapshots!)) {
    const result = await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${id}/events`);
    assert.equal(result.status, 200); assert.deepEqual(result.body.events, events);
  }
  assert.equal(s.app.model!.requests.length, s.requestCount);
});
When("张伟在模型等待期间查看评审会话", async function(this: ApiWorld) {
  const s = state(this); s.app.pauseModel(); s.reviewId = await s.app.review();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await s.app.identity.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${s.reviewId}`);
    const item = result.body.items[0];
    if (item && s.app.model!.requests.length) {
      const events = (await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${item.id}/events`)).body.events;
      if (events.some((event) => event.type === "user/message")) { s.sessionId = item.id; return; }
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("运行中的会话未出现");
});
Then("张伟可以先看到已提交的评审要求", async function(this: ApiWorld) {
  const s = state(this), result = await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${s.sessionId}/events`);
  assert.equal(result.status, 200); assert.equal(result.body.session.status, "running");
  assert.ok(result.body.events.some((event) => event.type === "user/message")); s.events = result.body.events; s.after = result.body.nextAfter;
});
When("模型完成评审", async function(this: ApiWorld) {
  const s = state(this); s.app.resumeModel(); assert.equal((await s.app.waitForReview(s.reviewId!)).status, "completed");
});
Then("张伟从已读位置取得后续记录且没有重复", async function(this: ApiWorld) {
  const s = state(this), result = await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${s.sessionId}/events?after=${s.after}`);
  assert.equal(result.status, 200); assert.ok(result.body.events.length); assert.ok(result.body.events.every((event) => event.seq > s.after!));
  const all = (await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${s.sessionId}/events`)).body;
  assert.deepEqual([...s.events!, ...result.body.events], all.events);
});
When("张伟生成金额校验规范后遇到一次调整失败并再次调整成功", { timeout: 30_000 }, async function(this: ApiWorld) {
  const s = state(this), created = await s.app.identity.request<{ session: RuleSession }>("/api/rule-sessions", {});
  assert.equal(created.status, 201); let current = created.body.session; s.ruleId = current.id;
  for (const [mode, message] of [["success", "扣款金额必须为正整数分"], ["error", "仅约束仓库的 repo 层"], ["success", "补充 Go 语言的合规示例"]] as const) {
    s.app.modelOptions.ruleGenerationMode = mode;
    const result = await s.app.identity.request<{ session: RuleSession }>(`/api/rule-sessions/${current.id}/turns`, {
      version: current.version, message,
    });
    assert.equal(result.status, 200); current = result.body.session;
    assert.equal(current.turns.at(-1)?.status, mode === "error" ? "failed" : "completed");
    if (mode === "error") {
      const records = (await s.app.identity.request<AgentSessionPage>(`/api/agent-sessions?ruleSessionId=${current.id}`)).body.items;
      s.failedId = records.find((record) => record.status === "failed")!.id;
      s.events = (await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${s.failedId}/events`)).body.events;
    }
  }
});
Then("张伟能查看三次运行记录且失败过程没有被覆盖", async function(this: ApiWorld) {
  const s = state(this), result = await s.app.identity.request<AgentSessionPage>(`/api/agent-sessions?ruleSessionId=${s.ruleId}`);
  assert.equal(result.body.total, 3); assert.equal(result.body.items.filter((item) => item.status === "failed").length, 1);
  assert.ok(result.body.items.every((item) => item.ruleSessionId === s.ruleId));
  const failure = await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${s.failedId}/events`);
  assert.deepEqual(failure.body.events, s.events);
  assert.ok(failure.body.events.some((event) => event.type === "user/message" && JSON.stringify(event.data).includes("仅约束仓库的 repo 层")));
  assert.ok(failure.body.events.some((event) => event.type === "turn/end" && event.data.reason.kind === "error"));
  assert.ok(!JSON.stringify(failure.body).includes("PRIVATE_MODEL_ERROR_SENTINEL"));
});
When("张伟切换到独立的结算团队查看会话", async function(this: ApiWorld) {
  const s = state(this); s.records = (await s.app.identity.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${s.reviewId}`)).body.items;
  const team = await s.app.identity.request<{ id: string }>("/api/admin/teams", { name: "结算平台" }); assert.equal(team.status, 201);
  assert.equal((await s.app.identity.request("/api/auth/team", { teamId: team.body.id })).status, 200);
});
Then("原团队会话不会出现且直接查看也被拒绝", async function(this: ApiWorld) {
  const s = state(this), result = await s.app.identity.request<AgentSessionPage>("/api/agent-sessions");
  assert.equal(result.body.total, 0);
  for (const item of s.records!) {
    assert.equal((await s.app.identity.request(`/api/agent-sessions/${item.id}`)).status, 404);
    assert.equal((await s.app.identity.request(`/api/agent-sessions/${item.id}/events`)).status, 404);
  }
});
When("张伟尝试从会话查看入口继续对话或删除会话", async function(this: ApiWorld) {
  const s = state(this), records = (await s.app.identity.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${s.reviewId}`)).body.items;
  s.sessionId = records[0]!.id; s.events = (await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${s.sessionId}/events`)).body.events;
  s.denied = [(await s.app.identity.request(`/api/agent-sessions/${s.sessionId}/messages`, { message: "重新运行评审" })).status,
    (await s.app.identity.request(`/api/agent-sessions/${s.sessionId}`, undefined, { method: "DELETE" })).status];
});
Then("工作台拒绝会话修改且原始记录保持完整", async function(this: ApiWorld) {
  const s = state(this); assert.ok(s.denied!.every((status) => status === 404 || status === 405));
  assert.deepEqual((await s.app.identity.request<AgentSessionEvents>(`/api/agent-sessions/${s.sessionId}/events`)).body.events, s.events);
});
