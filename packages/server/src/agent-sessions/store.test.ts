import { randomUUID } from "node:crypto";
import { Session, SessionId, SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withIdentity, type Identity } from "../auth/context.js";
import type { SessionView } from "../auth/service.js";
import { fixturePassword, fixtureRepository, IdentityScenario } from "../auth/test-support.js";
import { withTeam } from "../db/tenant.js";
import { buildApp } from "../http.js";
import { RuleSessionService } from "../rules/sessions.js";
import { AgentSessionStore } from "./store.js";
import type { AgentSessionEvents, AgentSessionPage, AgentSessionSummary } from "./types.js";

let fixture: IdentityScenario;
let actor: Identity;
let store: AgentSessionStore;
let repositoryId: string;
let reviewId: string;
const startEvent = (seq = 0): SessionEvent => ({ seq: SessionSeq(seq), time: 1000 + seq, type: "turn/start", data: { turn: 1 } });
const endEvent = (seq: number): SessionEvent => ({ seq: SessionSeq(seq), time: 1000 + seq, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

beforeEach(async () => {
  fixture = new IdentityScenario(); await fixture.start();
  actor = (await fixture.setup()).user!;
  const connected = await fixture.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
  repositoryId = connected.body.repository.id;
  store = new AgentSessionStore(fixture.pool);
  reviewId = await createReview();
});
afterEach(async () => { await fixture?.stop(); });

async function createReview(round = 1): Promise<string> {
  const id = randomUUID();
  await withTeam(actor.teamId, () => fixture.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round)
    VALUES($1,$2,$3,12,$4,'校验库存扣减','张伟',$5)`, [id, repositoryId, randomUUID(), `commit-${round}`, round]));
  return id;
}
async function begin(id = randomUUID(), associatedReview = reviewId): Promise<string> {
  await withTeam(actor.teamId, () => store.begin({ id, dshSessionId: `dsh-${id}`, kind: "review_generator", reviewId: associatedReview,
    model: "fixture-flash", provider: "fixture" }));
  return id;
}
const path = (id: string) => `/api/agent-sessions/${id}`;
async function member(): Promise<{ cookie: string; userId: string }> {
  expect((await fixture.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "member" })).status).toBe(201);
  const result = await fixture.request<SessionView>("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
  return { cookie: result.cookie, userId: result.body.user!.userId };
}

describe("通用 Agent 会话的数据库与 HTTP 边界", () => {
  it("列表继承来源可见范围，普通成员可读，服务管理员不能通过切换团队读取原团队内容", async () => {
    const id = await begin();
    const user = await member();
    const list = await fixture.request<AgentSessionPage>("/api/agent-sessions?search=库存&pageSize=1", undefined, { cookie: user.cookie });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ total: 1, page: 1, pageSize: 1, items: [{ id, reviewId, repositoryName: fixtureRepository.projectPath,
      title: "校验库存扣减", prNumber: 12, reviewRound: 1, headSha: "commit-1" }] });
    expect((await fixture.request(path(id), undefined, { cookie: user.cookie })).status).toBe(200);
    expect((await fixture.request(path(id), undefined, { cookie: "" })).status).toBe(401);

    const team = await fixture.request<{ id: string }>("/api/admin/teams", { name: "物流团队" });
    const switched = await fixture.request<SessionView>("/api/auth/team", { teamId: team.body.id });
    expect(switched.body.user?.serviceRole).toBe("service_admin");
    expect((await fixture.request<AgentSessionPage>("/api/agent-sessions")).body.total).toBe(0);
    expect((await fixture.request(path(id))).status).toBe(404);
    expect((await fixture.request(`${path(id)}/events`)).status).toBe(404);
    await expect(withTeam(team.body.id, () => store.begin({ id: randomUUID(), dshSessionId: "cross-team", kind: "review_grader", reviewId,
      model: "fixture-pro", provider: "fixture" }))).rejects.toMatchObject({ code: "not_found" });
    expect((await fixture.pool.query("SELECT id FROM agent_sessions")).rowCount).toBe(0);
    expect((await fixture.pool.query("SELECT seq FROM agent_session_events")).rowCount).toBe(0);
  });

  it("每次补齐事件都重新鉴权，移除成员后不能继续轮询", async () => {
    const id = await begin(), user = await member();
    await withTeam(actor.teamId, () => store.append(id, startEvent()));
    expect((await fixture.request(`${path(id)}/events`, undefined, { cookie: user.cookie })).status).toBe(200);
    await fixture.pool.query("DELETE FROM team_members WHERE team_id=$1 AND user_id=$2", [actor.teamId, user.userId]);
    expect((await fixture.request(`${path(id)}/events?after=0`, undefined, { cookie: user.cookie })).status).toBe(401);
    expect((await fixture.request("/api/agent-sessions", undefined, { cookie: user.cookie })).status).toBe(401);
  });

  it("按序分页补齐、重复事件不改历史，失败轮在重建服务后仍可读且不混入下一轮", async () => {
    const id = await begin();
    await withTeam(actor.teamId, async () => {
      await expect(store.append(id, startEvent(1))).rejects.toMatchObject({ code: "session_event_order" });
      await store.append(id, startEvent());
      await store.append(id, { seq: SessionSeq(1), time: 1001, type: "step/start", data: { turn: 1, step: 1 } });
      await store.append(id, { seq: SessionSeq(1), time: 1001, type: "step/start", data: { turn: 99, step: 99 } });
    });
    const first = await fixture.request<AgentSessionEvents>(`${path(id)}/events?limit=1`);
    expect(first.body).toMatchObject({ nextAfter: 0, hasMore: true, session: { status: "running", lastSeq: 1 } });
    await withTeam(actor.teamId, async () => {
      await store.append(id, endEvent(2));
      await store.finish(id, "failed", "invalid_review");
    });
    const second = await fixture.request<AgentSessionEvents>(`${path(id)}/events?after=${first.body.nextAfter}&limit=2`);
    expect(second.body).toMatchObject({ nextAfter: 2, hasMore: false, session: { status: "failed", errorCode: "invalid_review" } });
    expect(second.body.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(second.body.events[0]!.data).toEqual({ turn: 1, step: 1 });
    const nextReview = await createReview(2), nextId = await begin(randomUUID(), nextReview);
    expect((await fixture.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${reviewId}`)).body.items.map((item) => item.id)).toEqual([id]);
    expect((await fixture.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${nextReview}`)).body.items.map((item) => item.id)).toEqual([nextId]);
    await fixture.app!.close();
    fixture.app = buildApp({ pool: fixture.pool, auth: fixture.auth });
    fixture.baseUrl = await fixture.app.listen({ host: "127.0.0.1", port: 0 });
    expect((await fixture.request<AgentSessionEvents>(`${path(id)}/events?after=0`)).body).toEqual(second.body);
    expect((await fixture.request(`${path(id)}/events?after=-2`)).status).toBe(400);
  });

  it("查看接口只读，不能用已知会话 ID 发送消息、停止或删除", async () => {
    const id = await begin();
    for (const suffix of ["", "/events", "/turns", "/stop", "/tools"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect((await fixture.request(`${path(id)}${suffix}`, {}, { method })).status).toBe(404);
      }
    }
    expect((await fixture.request<{ session: AgentSessionSummary }>(path(id))).body.session).toMatchObject({ status: "running", lastSeq: -1 });
  });

  it("规范失败与后续成功分开保存，同一 dsh ID 的事件重用不会覆盖失败轮", async () => {
    const rule = await withIdentity(actor, () => new RuleSessionService(fixture.pool).create({}));
    const failed = randomUUID(), completed = randomUUID();
    await withTeam(actor.teamId, async () => {
      for (const id of [failed, completed]) {
        await store.begin({ id, dshSessionId: `ureview-rule-${rule.id}`, kind: "rule_generation", ruleSessionId: rule.id, model: "fixture-flash", provider: "fixture" });
        await store.append(id, startEvent());
        await store.append(id, endEvent(1));
        await store.finish(id, id === failed ? "failed" : "completed");
      }
    });
    const result = await fixture.request<AgentSessionPage>(`/api/agent-sessions?ruleSessionId=${rule.id}&kind=rule_generation`);
    expect(result.body.total).toBe(2);
    expect(result.body.items.map((item) => item.status).sort()).toEqual(["completed", "failed"]);
    const user = await member();
    expect((await fixture.request(`${path(failed)}/events`, undefined, { cookie: user.cookie })).status).toBe(200);
  });

  it("启动恢复中断状态，已有规范检查点只导入一次并保留来源时间", async () => {
    const interrupted = await begin();
    const rule = await withIdentity(actor, () => new RuleSessionService(fixture.pool).create({}));
    const header = Session.create(SessionId(`ureview-rule-${rule.id}`)).header;
    await withTeam(actor.teamId, async () => {
      await fixture.pool.query("UPDATE managed_rule_sessions SET checkpoint=$2,created_at='2026-01-01',updated_at='2026-01-02' WHERE id=$1",
        [rule.id, { header, inheritedEventCount: 0, events: [startEvent(), endEvent(1)] }]);
      await store.recoverInterrupted();
      await store.importRuleHistory();
      await store.importRuleHistory();
    });
    expect((await fixture.request<{ session: AgentSessionSummary }>(path(interrupted))).body.session).toMatchObject({ status: "failed", errorCode: "service_restarted" });
    const imported = (await fixture.request<AgentSessionPage>(`/api/agent-sessions?ruleSessionId=${rule.id}`)).body;
    expect(imported.total).toBe(1);
    expect(imported.items[0]).toMatchObject({ status: "completed", lastSeq: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" });
    expect((await fixture.request<AgentSessionEvents>(`${path(imported.items[0]!.id)}/events`)).body.events).toEqual([startEvent(), endEvent(1)]);
  });
});
