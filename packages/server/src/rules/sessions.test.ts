import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTeam } from "../db/tenant.js";
import { buildApp } from "../http.js";
import { ReviewError } from "../reviews/types.js";
import type { ManagedRule, ManagedRuleInput } from "./managed-types.js";
import { ManagedRuleScenario, managedDraft, managedInput } from "./managed/test-support.js";
import type { RuleConversationGenerator, RuleSession } from "./sessions-types.js";

type SessionResponse = { session: RuleSession };
type SaveResponse = SessionResponse & { rule: ManagedRule };
type TurnInput = Parameters<RuleConversationGenerator["continue"]>[0];
type TurnResult = Awaited<ReturnType<RuleConversationGenerator["continue"]>>;
let fixture: ManagedRuleScenario | undefined;
afterEach(async () => { await fixture?.stop(); fixture = undefined; });

async function start(generator?: RuleConversationGenerator) {
  fixture = new ManagedRuleScenario();
  await fixture.start(generator ? { conversationGenerator: generator } : {});
  return fixture;
}
async function create(app: ManagedRuleScenario, ruleId?: string) {
  const result = await app.request<SessionResponse>("/api/rule-sessions", ruleId ? { ruleId } : {});
  expect(result.status).toBe(201);
  return result.body.session;
}
async function get(app: ManagedRuleScenario, id: string) {
  const result = await app.request<SessionResponse>(`/api/rule-sessions/${id}`);
  expect(result.status).toBe(200);
  return result.body.session;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const resultOf = (name = managedDraft.name, checkpoint: unknown = { event: "PRIVATE-CHECKPOINT" }): TurnResult => ({
  draft: { ...managedDraft, name }, reply: `已整理规范：${name}`, checkpoint,
});

describe("可恢复的规范会话", () => {
  it("判断题编辑稿在会话恢复、生成和保存时保留，旧稿读取默认关闭", async () => {
    const inputs: TurnInput[] = [];
    const app = await start({ continue: async (input) => {
      inputs.push(input);
      return { ...resultOf(), draft: { ...managedDraft, judgement: true } };
    } });
    let session = await create(app);
    const copy = { ...managedInput, judgement: true };
    session = (await app.request<SessionResponse>(`/api/rule-sessions/${session.id}`,
      { version: session.version, workingCopy: copy }, { method: "PUT" })).body.session;
    expect((await get(app, session.id)).workingCopy?.judgement).toBe(true);
    session = (await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`,
      { version: session.version, message: "保留例外说明" })).body.session;
    expect(inputs[0]?.draft?.judgement).toBe(true);
    expect(session.turns[0]?.draft?.judgement).toBe(true);
    expect(session.workingCopy?.judgement).toBe(true);
    const saved = await app.request<SaveResponse>(`/api/rule-sessions/${session.id}/save-rule`,
      { version: session.version, workingCopy: { ...session.workingCopy, status: "active" } });
    expect(saved.status).toBe(200);
    expect(saved.body.rule.judgement).toBe(true);
    await withTeam(app.teamId, () => app.pool.query(`UPDATE managed_rule_sessions
      SET working_copy=working_copy-'judgement',turns=jsonb_set(turns,'{0,draft}',(turns->0->'draft')-'judgement') WHERE id=$1`, [session.id]));
    const legacy = await get(app, session.id);
    expect(legacy.workingCopy?.judgement).toBe(false);
    expect(legacy.turns[0]?.draft?.judgement).toBe(false);
  });

  it("多轮保留对话与编辑稿，重建HTTP服务后沿原会话继续，快照不进入接口", async () => {
    const inputs: TurnInput[] = [];
    const generator: RuleConversationGenerator = { continue: async (input) => {
      inputs.push(input);
      return resultOf(inputs.length === 1 ? "金额使用整数分" : "金额校验包含退款", { secret: "PRIVATE-CHECKPOINT", turn: inputs.length });
    } };
    const app = await start(generator);
    let session = await create(app);
    expect(session).toMatchObject({ version: 1, status: "idle", workingCopy: null, ruleId: null, ruleVersion: null, turns: [] });
    const first = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "金额使用整数分" });
    expect(first.status).toBe(200);
    session = first.body.session;
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ message: "金额使用整数分", status: "completed", draft: managedDraft, reply: "已整理规范：金额使用整数分" });
    expect(inputs[0]).toEqual({ sessionId: `ureview-rule-${session.id}`, ruleSessionId: session.id, message: "金额使用整数分" });
    const copy = { ...managedInput, body: "所有扣款先验证整数分，再检查余额。", scope: "repositories", repositories: [{ repositoryId: app.repositoryId, paths: ["src/**"] }] };
    const updated = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}`, { version: session.version, workingCopy: copy }, { method: "PUT" });
    expect(updated.status).toBe(200); session = updated.body.session;
    await app.app!.close();
    app.app = buildApp({ pool: app.pool, auth: app.identity.auth, managedRules: app.managed, repositories: app.repositories,
      reviews: app.reviews, ruleConversationGenerator: generator, publicOrigin: "http://identity.example.test" });
    app.baseUrl = await app.app.listen({ host: "127.0.0.1", port: 0 });
    expect(await get(app, session.id)).toEqual(session);
    const second = await app.request<SessionResponse>(`/api/rule-sessions/${session.id.toUpperCase()}/turns`, { version: session.version, message: "加上退款场景" });
    expect(second.status).toBe(200);
    expect(second.body.session.turns).toHaveLength(2);
    expect(inputs[1]).toMatchObject({ sessionId: inputs[0]!.sessionId, checkpoint: { secret: "PRIVATE-CHECKPOINT", turn: 1 },
      draft: { body: copy.body }, message: "加上退款场景" });
    expect(second.body.session.workingCopy).toMatchObject({ name: "金额校验包含退款", scope: "repositories", repositories: copy.repositories, status: "draft" });
    const list = await app.request<{ sessions: RuleSession[] }>("/api/rule-sessions");
    expect(list.body.sessions).toEqual([second.body.session]);
    expect(JSON.stringify(list.body)).not.toMatch(/checkpoint|PRIVATE/);
    expect((await app.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toEqual([]);
  });

  it("仓库入口预填的空工作稿在首轮生成、启用与恢复后保留仓库范围", async () => {
    const app = await start({ continue: async () => resultOf() });
    let session = await create(app);
    const copy: ManagedRuleInput = { ...managedInput, name: "", body: "", scope: "repositories", repositories: [{ repositoryId: app.repositoryId, paths: [] }] };
    const updated = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}`, { version: session.version, workingCopy: copy }, { method: "PUT" });
    expect(updated.status).toBe(200);
    session = updated.body.session;
    expect(session.workingCopy).toEqual(copy);
    expect((await get(app, session.id)).workingCopy).toEqual(copy);

    const generated = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "该仓库的金额使用整数分" });
    expect(generated.status).toBe(200);
    session = generated.body.session;
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0]).toMatchObject({ status: "completed", draft: managedDraft });
    const generatedCopy: ManagedRuleInput = { ...copy, ...managedDraft };
    expect(session.workingCopy).toEqual(generatedCopy);
    expect((await get(app, session.id)).workingCopy).toEqual(generatedCopy);

    const activeCopy: ManagedRuleInput = { ...generatedCopy, status: "active" };
    const saved = await app.request<SaveResponse>(`/api/rule-sessions/${session.id}/save-rule`, { version: session.version, workingCopy: activeCopy });
    expect(saved.status).toBe(200);
    expect(saved.body.rule).toMatchObject(activeCopy);
    expect(saved.body.session).toMatchObject({ ruleId: saved.body.rule.id, ruleVersion: saved.body.rule.version, workingCopy: activeCopy });
    expect(await get(app, session.id)).toEqual(saved.body.session);
    const rules = await app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
    expect(rules.status).toBe(200);
    expect(rules.body.rules).toEqual([saved.body.rule]);
  });

  it("生成失败和畸形回复保留最近工作稿与成功快照，并记录可重试的失败轮", async () => {
    const inputs: TurnInput[] = [];
    let mode: "success" | "error" | "malformed" = "success";
    const app = await start({ continue: async (input) => {
      inputs.push(input);
      if (mode === "error") throw new Error("PRIVATE PROVIDER RESPONSE");
      if (mode === "malformed") return { ...resultOf(), draft: { ...managedDraft, name: "" } };
      return resultOf();
    } });
    let session = await create(app);
    session = (await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "校验金额" })).body.session;
    const copy = { ...session.workingCopy!, body: "保留这份手工修改的正文。" };
    for (const outcome of ["error", "malformed"] as const) {
      mode = outcome;
      const response = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "补充退款示例", workingCopy: copy });
      expect(response.status).toBe(200); session = response.body.session;
      expect(session.status).toBe("idle");
      expect(session.workingCopy).toEqual(copy);
      expect(session.turns.at(-1)).toMatchObject({ status: "failed", message: "补充退款示例" });
      expect(session.turns.at(-1)?.error).toContain("已保留");
      expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|PROVIDER|checkpoint/);
    }
    mode = "success";
    const final = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "再次补充" });
    expect(final.body.session.turns.map((turn) => turn.status)).toEqual(["completed", "failed", "failed", "completed"]);
    expect(inputs.slice(1).every((input) => JSON.stringify(input.checkpoint) === JSON.stringify({ event: "PRIVATE-CHECKPOINT" }))).toBe(true);
  });

  it("模型未配置也保留输入和会话，可继续手工编辑并保存规范", async () => {
    const app = await start();
    let session = await create(app);
    const response = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "限制重试次数" });
    expect(response.status).toBe(200); session = response.body.session;
    expect(session.turns[0]).toMatchObject({ status: "failed", message: "限制重试次数" });
    expect(session.turns[0]?.error).toContain("配置");
    expect((await app.request(`/api/rule-sessions/${session.id}/save-rule`, { version: session.version, workingCopy: managedInput })).status).toBe(200);
  });

  it("生成失败按已知错误码显示安全原因，未知错误不泄漏原文，重试沿用成功快照和工作稿", async () => {
    const inputs: TurnInput[] = [];
    let failure: Error | undefined;
    const app = await start({ continue: async (input) => {
      inputs.push(input);
      if (failure) throw failure;
      return resultOf();
    } });
    let session = await create(app);
    session = (await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "校验金额" })).body.session;
    const copy = { ...session.workingCopy!, body: "保留手工添加的退款校验。" };
    const generic = "本轮规范生成失败，请重新发送要求。当前工作稿已保留。";
    const cases: Array<{ failure: Error; expected: string }> = [
      { failure: new ReviewError("rule_model_unavailable", "PRIVATE PROVIDER RESPONSE"), expected: "模型连接中断或服务暂时不可用，请稍后重试。当前工作稿已保留。" },
      { failure: new ReviewError("rule_generation_timeout", "PRIVATE PROVIDER RESPONSE"), expected: "规范生成超时，请稍后重试。当前工作稿已保留。" },
      { failure: new ReviewError("invalid_rule_draft", "PRIVATE PROVIDER RESPONSE"), expected: "模型未返回有效的规范草稿，请重新发送要求。当前工作稿已保留。" },
      { failure: new ReviewError("models_not_configured", "PRIVATE PROVIDER RESPONSE"), expected: "请先配置用于生成规范的模型。当前工作稿已保留。" },
      { failure: new ReviewError("rule_generation_failed", "PRIVATE PROVIDER RESPONSE"), expected: generic },
      { failure: new ReviewError("unknown_provider_failure", "PRIVATE PROVIDER RESPONSE"), expected: generic },
      { failure: new Error("PRIVATE PROVIDER RESPONSE"), expected: generic },
    ];
    for (const entry of cases) {
      failure = entry.failure;
      const response = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "补充退款示例", workingCopy: copy });
      expect(response.status).toBe(200); session = response.body.session;
      expect(session.status).toBe("idle");
      expect(session.workingCopy).toEqual(copy);
      expect(session.turns.at(-1)).toMatchObject({ status: "failed", message: "补充退款示例", error: entry.expected });
      expect(await get(app, session.id)).toEqual(session);
      expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|PROVIDER|checkpoint/);
    }
    failure = undefined;
    const retried = await app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "再次补充" });
    expect(retried.body.session.turns.at(-1)?.status).toBe("completed");
    for (const input of inputs.slice(1)) expect(input).toMatchObject({ checkpoint: { event: "PRIVATE-CHECKPOINT" }, draft: { body: copy.body } });
    const history = await app.request<{ sessions: RuleSession[] }>("/api/rule-sessions");
    expect(history.body.sessions[0]?.turns.slice(1, -1).map((turn) => turn.error)).toEqual(cases.map((entry) => entry.expected));
    expect(JSON.stringify(history.body)).not.toMatch(/PRIVATE|PROVIDER|checkpoint/);
  });

  it("运行中的会话可读取，同会话修改和重复生成被拒绝，模型调用不占事务", async () => {
    const entered = deferred<void>(), completion = deferred<TurnResult>();
    let calls = 0;
    const app = await start({ continue: async () => { calls++; entered.resolve(); return completion.promise; } });
    const session = await create(app);
    const pending = app.request<SessionResponse>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "校验金额" });
    try {
      await entered.promise;
      const running = await get(app, session.id);
      expect(running).toMatchObject({ status: "running", version: 2 });
      expect(running.turns[0]?.status).toBe("running");
      for (const [path, body, method] of [
        [`/api/rule-sessions/${session.id}`, { version: running.version, workingCopy: managedInput }, "PUT"],
        [`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "重复要求" }, "POST"],
        [`/api/rule-sessions/${session.id}/save-rule`, { version: running.version, workingCopy: managedInput }, "POST"],
      ] as const) {
        expect(await app.request(path, body, { method })).toMatchObject({ status: 409, body: { error: { code: "session_busy" } } });
      }
      expect(calls).toBe(1);
    } finally { completion.resolve(resultOf()); await pending; }
    expect((await get(app, session.id)).status).toBe("idle");
  });

  it("超时轮次懒恢复，迟到结果不能覆盖后来成功的工作稿", async () => {
    const entered = deferred<void>(), oldResult = deferred<TurnResult>();
    let calls = 0;
    const app = await start({ continue: async () => {
      if (++calls === 1) { entered.resolve(); return oldResult.promise; }
      return resultOf("恢复后的规范", { recovered: true });
    } });
    const initial = await create(app);
    const pending = app.request<SessionResponse>(`/api/rule-sessions/${initial.id}/turns`, { version: initial.version, message: "首次要求", workingCopy: managedInput });
    try {
      await entered.promise;
      await withTeam(app.teamId, () => app.pool.query("UPDATE managed_rule_sessions SET generation_started_at=now()-interval '91 seconds' WHERE id=$1", [initial.id]));
      const recovered = await get(app, initial.id);
      expect(recovered.status).toBe("idle");
      expect(recovered.workingCopy).toEqual(managedInput);
      expect(recovered.turns[0]?.status).toBe("failed");
      const later = await app.request<SessionResponse>(`/api/rule-sessions/${initial.id}/turns`, { version: recovered.version, message: "重新补充要求" });
      expect(later.body.session.workingCopy?.name).toBe("恢复后的规范");
      oldResult.resolve(resultOf("迟到的旧规范"));
      expect((await pending).body.session).toEqual(later.body.session);
      expect(await get(app, initial.id)).toEqual(later.body.session);
    } finally { oldResult.resolve(resultOf()); await pending; }
  });

  it("同一会话版本并发保存只有一次创建，后续保存更新关联规范并核对规则版本", async () => {
    const app = await start();
    const initial = await create(app);
    const responses = await Promise.all(["支付校验", "退款校验"].map((name) => app.request<SaveResponse>(`/api/rule-sessions/${initial.id}/save-rule`,
      { version: initial.version, workingCopy: { ...managedInput, name } })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const saved = responses.find((response) => response.status === 200)!.body;
    expect(saved.session).toMatchObject({ ruleId: saved.rule.id, ruleVersion: 1, version: 2 });
    expect((await app.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toEqual([saved.rule]);
    const external = await app.request<{ rule: ManagedRule }>(`/api/managed-rules/${saved.rule.id}`, { ...managedInput, name: "另一管理员的修改", version: 1 }, { method: "PUT" });
    const change = { ...managedInput, name: "会话内的工作稿", status: "active" };
    expect(await app.request(`/api/rule-sessions/${initial.id}/save-rule`, { version: saved.session.version, workingCopy: change }))
      .toMatchObject({ status: 409, body: { error: { code: "version_conflict" } } });
    expect(await get(app, initial.id)).toEqual(saved.session);
    const confirmed = await app.request<SaveResponse>(`/api/rule-sessions/${initial.id}/save-rule`,
      { version: saved.session.version, workingCopy: change, ruleVersion: external.body.rule.version });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.rule).toMatchObject({ id: saved.rule.id, name: change.name, status: "active", version: 3 });
    const linked = await create(app, saved.rule.id);
    expect(linked).toMatchObject({ ruleId: saved.rule.id, ruleVersion: 3, workingCopy: change, turns: [] });
    expect((await app.request<{ sessions: RuleSession[] }>(`/api/rule-sessions?ruleId=${saved.rule.id}`)).body.sessions).toHaveLength(2);
  });

  it("关联写入故障会回滚规范创建，重试只保存一条规范", async () => {
    const app = await start();
    const session = await create(app);
    await withTeam(app.teamId, async () => {
      await app.pool.query(`CREATE FUNCTION reject_session_link() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.rule_id IS NOT NULL THEN RAISE EXCEPTION '测试关联失败'; END IF; RETURN NEW; END $$`);
      await app.pool.query("CREATE TRIGGER reject_session_link BEFORE UPDATE ON managed_rule_sessions FOR EACH ROW EXECUTE FUNCTION reject_session_link()");
    });
    const failed = await app.request(`/api/rule-sessions/${session.id}/save-rule`, { version: session.version, workingCopy: managedInput });
    expect(failed.status).toBe(500);
    expect((await app.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toEqual([]);
    expect(await get(app, session.id)).toEqual(session);
    await withTeam(app.teamId, () => app.pool.query("DROP TRIGGER reject_session_link ON managed_rule_sessions"));
    expect((await app.request(`/api/rule-sessions/${session.id}/save-rule`, { version: session.version, workingCopy: managedInput })).status).toBe(200);
    expect((await app.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toHaveLength(1);
  });

  it("会话与规范按团队隔离，联合外键和RLS拒绝越队关联，成员只能读", async () => {
    let called = false;
    const app = await start({ continue: async () => { called = true; return resultOf(); } });
    const own = await create(app);
    const saved = await app.request<SaveResponse>(`/api/rule-sessions/${own.id}/save-rule`, { version: own.version, workingCopy: managedInput });
    const other = await app.otherTeam();
    const foreign = await app.request<SessionResponse>("/api/rule-sessions", {}, { cookie: other.cookie });
    expect((await app.request<{ sessions: RuleSession[] }>("/api/rule-sessions", undefined, { cookie: other.cookie })).body.sessions).toEqual([foreign.body.session]);
    for (const request of [
      () => app.request(`/api/rule-sessions/${own.id}`, undefined, { cookie: other.cookie }),
      () => app.request(`/api/rule-sessions/${own.id}`, { version: 2, workingCopy: managedInput }, { method: "PUT", cookie: other.cookie }),
      () => app.request(`/api/rule-sessions/${own.id}/turns`, { version: 2, message: "跨队要求" }, { cookie: other.cookie }),
      () => app.request(`/api/rule-sessions/${own.id}/save-rule`, { version: 2, workingCopy: managedInput }, { cookie: other.cookie }),
      () => app.request("/api/rule-sessions", { ruleId: saved.body.rule.id }, { cookie: other.cookie }),
      () => app.request(`/api/rule-sessions?ruleId=${saved.body.rule.id}`, undefined, { cookie: other.cookie }),
    ]) expect((await request()).status).toBe(404);
    const outsideScope = { ...managedInput, scope: "repositories", repositories: [{ repositoryId: other.repositoryId, paths: [] }] };
    expect((await app.request(`/api/rule-sessions/${own.id}`, { version: 2, workingCopy: outsideScope }, { method: "PUT" })).status).toBe(404);
    expect((await app.request<SessionResponse>(`/api/rule-sessions/${own.id}`, undefined, { cookie: app.memberCookie })).body.session).toEqual(saved.body.session);
    for (const path of ["/api/rule-sessions", `/api/rule-sessions/${own.id}/turns`, `/api/rule-sessions/${own.id}/save-rule`]) {
      expect((await app.request(path, { version: 2, message: "修改", workingCopy: managedInput }, { cookie: app.memberCookie })).status).toBe(403);
    }
    expect((await app.request(`/api/rule-sessions/${own.id}`, { version: 2, workingCopy: managedInput }, { method: "PUT", cookie: app.memberCookie })).status).toBe(403);
    expect((await app.request("/api/rule-sessions", undefined, { cookie: "" })).status).toBe(401);
    expect((await app.pool.query("SELECT id FROM managed_rule_sessions")).rowCount).toBe(0);
    await withTeam(other.teamId, async () => {
      expect((await app.pool.query("SELECT id FROM managed_rule_sessions WHERE id=$1", [own.id])).rowCount).toBe(0);
      await expect(app.pool.query("UPDATE managed_rule_sessions SET rule_id=$2,rule_version=1 WHERE id=$1", [foreign.body.session.id, saved.body.rule.id])).rejects.toMatchObject({ code: "23503" });
      await expect(app.pool.query("UPDATE managed_rule_sessions SET team_id=$2 WHERE id=$1", [foreign.body.session.id, app.teamId])).rejects.toMatchObject({ code: "42501" });
    });
    expect(called).toBe(false);
  });

  it("编辑中的空字段可恢复，完整保存校验失败不影响会话，旧版本写入不覆盖新稿", async () => {
    const app = await start();
    const initial = await create(app);
    const copy = { ...managedInput, name: "", body: "", scope: "repositories", repositories: [] };
    const saved = await app.request<SessionResponse>(`/api/rule-sessions/${initial.id}`, { version: initial.version, workingCopy: copy }, { method: "PUT" });
    expect(saved.status).toBe(200);
    expect((await get(app, initial.id)).workingCopy).toEqual(copy);
    expect((await app.request(`/api/rule-sessions/${initial.id}/save-rule`, { version: saved.body.session.version, workingCopy: copy })).status).toBe(400);
    expect(await app.request(`/api/rule-sessions/${initial.id}`, { version: initial.version, workingCopy: managedInput }, { method: "PUT" }))
      .toMatchObject({ status: 409, body: { error: { code: "session_version_conflict" } } });
    for (const value of [
      { version: saved.body.session.version, workingCopy: managedInput, checkpoint: { injected: true } },
      { version: saved.body.session.version, workingCopy: { ...managedInput, createdBy: randomUUID() } },
      { version: saved.body.session.version, workingCopy: { ...managedInput, body: "x".repeat(12001) } },
    ]) expect((await app.request(`/api/rule-sessions/${initial.id}`, value, { method: "PUT" })).status).toBe(400);
    expect(await get(app, initial.id)).toEqual(saved.body.session);
  });
});
