import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { withTeam } from "../db/tenant.js";
import type { ReviewFinding, ReviewRule } from "../reviews/types.js";
import type { RuleDetail } from "./detail.js";
import { managedRuleInput } from "./library.js";
import type { ManagedRule } from "./managed-types.js";
import { ManagedRuleScenario, managedDraft, managedInput } from "./managed/test-support.js";
import type { RuleProposal } from "./proposal-types.js";
import type { RuleConversationGenerator, RuleSession } from "./sessions-types.js";

let scenario: ManagedRuleScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });
async function start(generator?: RuleConversationGenerator) {
  scenario = new ManagedRuleScenario(); await scenario.start(generator ? { conversationGenerator: generator } : {}); return scenario;
}
type Rules = { rules: ManagedRule[] };
type Proposals = { proposals: RuleProposal[] };
const rulePath = (rule: ManagedRule) => `/api/managed-rules/${rule.id}`;
async function create(fixture: ManagedRuleScenario, input: object = { ...managedInput, status: "active" }) {
  const result = await fixture.request<{ rule: ManagedRule }>("/api/managed-rules", input);
  expect(result.status).toBe(201); return result.body.rule;
}
async function waitForBlocked(client: pg.Client, count: number) {
  await expect.poll(async () => (await client.query<{ count: number }>(`
    SELECT count(DISTINCT lock.pid)::integer AS count FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid
    WHERE activity.datname=current_database() AND NOT lock.granted`)).rows[0]!.count, { timeout: 5000, interval: 10 }).toBe(count);
}
async function seedReview(fixture: ManagedRuleScenario, rule: ManagedRule, options: { repositoryId?: string; body?: string; version?: number; status?: string } = {}) {
  const reviewId = randomUUID(), ruleId = `managed:${rule.id}`;
  const entry: ReviewFinding = { id: randomUUID(), title: "金额计算使用浮点数", description: "交易金额需要使用整数分", severity: "medium",
    location: { path: "src/payment.ts", startLine: 1, endLine: 1 }, code: "const amount = 1.1", evidence: [], fixPrompt: "使用整数分", ruleId,
    generatedAt: new Date().toISOString(), score: 90, status: "Pending", readFiles: [],
    generatorModel: { provider: "fixture", model: "generator", vendor: "fixture" }, graderModel: { provider: "fixture", model: "grader", vendor: "fixture" } };
  const snapshot: ReviewRule = { id: ruleId, name: rule.name, body: options.body ?? rule.body, goodExample: rule.goodExample, badExample: rule.badExample,
    judgement: rule.judgement, layer: rule.layer, languages: rule.languages, overrides: rule.overrides,
    source: { kind: "generated" }, file: { kind: "database", ruleId: rule.id, version: options.version ?? rule.version, scope: rule.scope }, matchedPaths: ["src/payment.ts"] };
  await withTeam(fixture.teamId, async () => {
    await fixture.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,status,rules,completed_at,round)
      VALUES($1,$2,$3,17,$3,'订单支付金额计算','李娜',$4,$5,now(),
        (SELECT coalesce(max(round),0)+1 FROM reviews WHERE repository_id=$2 AND iid=17))`,
    [reviewId, options.repositoryId ?? fixture.repositoryId, randomUUID(), options.status ?? "completed", JSON.stringify([snapshot])]);
    await fixture.pool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,$3)", [entry.id, reviewId, JSON.stringify(entry)]);
  });
  const change = (value: object) => fixture.identity.request(`/api/reviews/${reviewId}/findings/${entry.id}/disposition`, value, { method: "PATCH" });
  return { reviewId, entry, snapshot, change };
}

describe("删除工作台规范", () => {
  it.each(["active", "draft"] as const)("管理员删除 %s 规范及仓库范围，目录不再返回规范", async (status) => {
    const fixture = await start();
    const rule = await create(fixture, { ...managedInput, status, scope: "repositories", repositories: [{ repositoryId: fixture.repositoryId, paths: ["src/**"] }] });
    const deleted = await fixture.request(rulePath(rule), { version: rule.version }, { method: "DELETE" });
    expect(deleted.status).toBe(200); expect(deleted.body).toEqual({ deleted: true });
    expect((await fixture.request<Rules>("/api/managed-rules")).body.rules).toEqual([]);
    expect((await fixture.request(`/api/rules/managed:${rule.id}/detail`)).status).toBe(404);
    expect(await withTeam(fixture.teamId, async () => (await fixture.pool.query("SELECT * FROM managed_rule_repositories WHERE rule_id=$1", [rule.id])).rowCount)).toBe(0);
    expect((await fixture.request(rulePath(rule), { version: rule.version }, { method: "DELETE" })).status).toBe(404);
  });

  it("删除验证权限、团队、版本及参数，失败时保留规范", async () => {
    const fixture = await start(), rule = await create(fixture), other = await fixture.otherTeam();
    expect((await fixture.request(rulePath(rule), { version: 1 }, { method: "DELETE", cookie: fixture.memberCookie })).status).toBe(403);
    expect((await fixture.request(rulePath(rule), { version: 1 }, { method: "DELETE", cookie: other.cookie })).status).toBe(404);
    expect((await fixture.request(rulePath(rule), { version: 2 }, { method: "DELETE" })).status).toBe(409);
    for (const body of [{}, { version: 0 }, { version: 1.5 }, { version: "1" }, { version: 1, force: true }]) {
      expect((await fixture.request(rulePath(rule), body, { method: "DELETE" })).status).toBe(400);
    }
    expect((await fixture.request("/api/managed-rules/invalid", { version: 1 }, { method: "DELETE" })).status).toBe(400);
    expect((await fixture.request<Rules>("/api/managed-rules")).body.rules).toEqual([rule]);
  });

  it("删除规范库规则后条目恢复未应用，再次应用创建新的生效规则", async () => {
    const fixture = await start(), path = "/api/rule-library/go-guidelines/apply", entryId = "go-guidelines-check-errors";
    const before = (await fixture.request<Rules>(path, { entryIds: [entryId] })).body.rules[0]!;
    expect((await fixture.request(rulePath(before), { version: before.version }, { method: "DELETE" })).status).toBe(200);
    const sets = (await fixture.readLibrary()).body.sets;
    expect(sets.find((set) => set.id === "go-guidelines")!.entries.find((entry) => entry.id === entryId)?.appliedRuleId).toBeNull();
    const after = await fixture.request<Rules & { created: number }>(path, { entryIds: [entryId] });
    expect(after.body.created).toBe(1); expect(after.body.rules[0]!.id).not.toBe(before.id);
    expect(after.body.rules[0]).toMatchObject({ status: "active", version: 1, librarySource: before.librarySource });
    expect((await fixture.request<Proposals>("/api/rule-proposals")).body.proposals).toEqual([]);
  });

  it("删除解除会话关联并撤回待审核提案，保留工作稿、对话和审核历史", async () => {
    const checkpoint = { turn: 1, note: "历史会话快照" };
    const fixture = await start({ continue: async (input) => ({ draft: input.draft ?? managedDraft, reply: "已保留外部请求的错误处理约定。", checkpoint }) });
    const original = await fixture.seedLegacyLibraryDraft("go-guidelines", "go-guidelines-check-errors");
    const first = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals[0]!;
    expect((await fixture.request(`/api/rule-proposals/${first.id}/review`, { status: "rejected", reason: "先明确适用范围" })).status).toBe(200);
    const revised = (await fixture.request<{ rule: ManagedRule }>(rulePath(original), { ...managedRuleInput(original), body: "处理外部请求的错误。", version: 1 }, { method: "PUT" })).body.rule;
    const second = (await fixture.request<Proposals>("/api/rule-proposals?status=pending")).body.proposals[0]!;
    const accepted = (await fixture.request<{ rule: ManagedRule }>(`/api/rule-proposals/${second.id}/review`, { status: "accepted" })).body.rule;
    const rule = (await fixture.request<{ rule: ManagedRule }>(rulePath(revised), { ...managedRuleInput(accepted), status: "draft", version: accepted.version }, { method: "PUT" })).body.rule;
    let session = (await fixture.request<{ session: RuleSession }>("/api/rule-sessions", { ruleId: rule.id })).body.session;
    const turn = await fixture.request<{ session: RuleSession }>(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: "核对外部请求的错误处理约定。" });
    expect(turn.status).toBe(200); session = turn.body.session;
    expect(session.turns).toMatchObject([{ status: "completed" }]);
    const history = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals;
    expect((await fixture.request(rulePath(rule), { version: rule.version }, { method: "DELETE" })).status).toBe(200);
    const detached = (await fixture.request<{ session: RuleSession }>(`/api/rule-sessions/${session.id}`)).body.session;
    expect(detached).toMatchObject({ ruleId: null, ruleVersion: null, version: session.version + 1, workingCopy: session.workingCopy, turns: session.turns });
    expect(await withTeam(fixture.teamId, async () => (await fixture.pool.query("SELECT checkpoint FROM managed_rule_sessions WHERE id=$1", [session.id])).rows[0].checkpoint)).toEqual(checkpoint);
    expect((await fixture.request(`/api/rule-sessions/${session.id}/save-rule`, { version: session.version, workingCopy: session.workingCopy })).status).toBe(409);
    expect((await fixture.request("/api/rule-sessions", { ruleId: rule.id })).status).toBe(404);
    const after = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals;
    expect(after).toEqual(history.map((proposal) => ({ ...proposal, managedRuleId: null, status: proposal.status === "pending" ? "withdrawn" : proposal.status })));
    const pending = history.find((proposal) => proposal.status === "pending")!;
    expect((await fixture.request(`/api/rule-proposals/${pending.id}/review`, { status: "accepted" })).status).toBe(409);
  });

  it("使用大写规范标识删除仍清理豁免和覆盖引用，覆盖方版本递增且其他引用保留", async () => {
    const fixture = await start();
    const base = await create(fixture, { ...managedInput, layer: "general", status: "active" });
    const retained = await create(fixture, { ...managedInput, name: "退款使用整数分", layer: "general", status: "active" });
    const override = await create(fixture, { ...managedInput, overrides: [`managed:${base.id}`, `managed:${retained.id}`] });
    expect((await fixture.request(`${rulePath(base)}/waivers/${fixture.repositoryId}`, { reason: "迁移期采用支付规范" }, { method: "PUT" })).status).toBe(200);
    expect((await fixture.request(`/api/managed-rules/${base.id.toUpperCase()}`, { version: base.version }, { method: "DELETE" })).status).toBe(200);
    const rules = (await fixture.request<Rules>("/api/managed-rules")).body.rules;
    expect(rules.find((rule) => rule.id === retained.id)).toEqual(retained);
    expect(rules.find((rule) => rule.id === override.id)).toMatchObject({ overrides: [`managed:${retained.id}`], version: override.version + 1, updatedBy: fixture.userId });
    expect((await fixture.request(rulePath(override), { ...managedRuleInput(override), version: override.version }, { method: "PUT" })).status).toBe(409);
    expect(await withTeam(fixture.teamId, async () => (await fixture.pool.query("SELECT * FROM managed_rule_waivers WHERE rule_id=$1", [base.id])).rowCount)).toBe(0);
  });

  it("删除后详情读取同团队最近完成的数据库快照，并按仓库过滤执行记录", async () => {
    const fixture = await start(), rule = await create(fixture);
    const secondRepository = (await fixture.request<{ repository: { id: string } }>("/api/repositories", {
      instanceUrl: "https://gitlab.example.test", projectPath: "commerce/refund-service", token: "fixture-readonly",
    })).body.repository.id;
    const first = await seedReview(fixture, rule);
    const latest = await seedReview(fixture, rule, { repositoryId: secondRepository, body: "退款使用整数分。", version: 2 });
    await seedReview(fixture, rule, { body: "尚未完成的评审正文。", version: 3, status: "running" });
    expect((await fixture.request(rulePath(rule), { version: rule.version }, { method: "DELETE" })).status).toBe(200);
    const path = `/api/rules/managed:${rule.id}/detail`;
    const detail = await fixture.request<RuleDetail>(path, undefined, { cookie: fixture.memberCookie });
    expect(detail.status).toBe(200);
    expect(detail.body.rule).toMatchObject({ status: "snapshot", version: 2, body: latest.snapshot.body, name: rule.name,
      goodExample: rule.goodExample, badExample: rule.badExample, judgement: rule.judgement, source: { kind: "managed" } });
    expect(detail.body.rule.managedRule).toBeUndefined(); expect(detail.body.summary.hits).toBe(2);
    expect(detail.body.records.map((record) => record.reviewId).sort()).toEqual([first.reviewId, latest.reviewId].sort());
    const filtered = await fixture.request<RuleDetail>(`${path}?repositoryId=${fixture.repositoryId}`);
    expect(filtered.body.rule).toMatchObject({ body: first.snapshot.body, version: 1 });
    expect(filtered.body.records).toMatchObject([{ reviewId: first.reviewId, ruleVersion: 1 }]);
    const other = await fixture.otherTeam();
    expect((await fixture.request(path, undefined, { cookie: other.cookie })).status).toBe(404);
    expect((await fixture.request(`${path}?repositoryId=${other.repositoryId}`)).status).toBe(404);
  });

  it("删除撤回待审核反馈并保留已审核反馈，旧 finding 处置不再创建提案", async () => {
    const fixture = await start(), rule = await create(fixture);
    const first = await seedReview(fixture, rule), second = await seedReview(fixture, rule), untouched = await seedReview(fixture, rule);
    expect((await first.change({ version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价允许精确小数" })).status).toBe(200);
    const accepted = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals[0]!;
    expect((await fixture.request(`/api/rule-proposals/${accepted.id}/review`, { status: "rejected", reason: "现有规范仅约束结算金额" })).status).toBe(200);
    expect((await second.change({ version: 0, status: "Dismissed", reasonCategory: "rule_incorrect" })).status).toBe(200);
    const before = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals;
    expect((await fixture.request(rulePath(rule), { version: rule.version }, { method: "DELETE" })).status).toBe(200);
    const expected = before.map((proposal) => ({ ...proposal, managedRuleId: null, status: proposal.status === "pending" ? "withdrawn" : proposal.status }));
    expect((await fixture.request<Proposals>("/api/rule-proposals")).body.proposals).toEqual(expected);
    expect((await untouched.change({ version: 0, status: "Dismissed", reasonCategory: "rule_incorrect" })).status).toBe(200);
    expect((await second.change({ version: 1, status: "Pending" })).status).toBe(200);
    expect((await second.change({ version: 2, status: "Dismissed", reasonCategory: "rule_incorrect" })).status).toBe(200);
    expect((await fixture.request<Proposals>("/api/rule-proposals")).body.proposals).toEqual(expected);
  });

  it("删除失败回滚会话、提案和规范", async () => {
    const fixture = await start(), rule = await create(fixture, managedInput);
    const session = (await fixture.request<{ session: RuleSession }>("/api/rule-sessions", { ruleId: rule.id })).body.session;
    const proposals = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals;
    await withTeam(fixture.teamId, () => fixture.pool.query(`CREATE FUNCTION reject_rule_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION '删除失败样本'; END $$; CREATE TRIGGER reject_rule_deletion BEFORE DELETE ON managed_rules
      FOR EACH ROW EXECUTE FUNCTION reject_rule_deletion()`));
    expect((await fixture.request(rulePath(rule), { version: 1 }, { method: "DELETE" })).status).toBe(500);
    expect((await fixture.request<Rules>("/api/managed-rules")).body.rules).toEqual([rule]);
    expect((await fixture.request<Proposals>("/api/rule-proposals")).body.proposals).toEqual(proposals);
    expect((await fixture.request<{ session: RuleSession }>(`/api/rule-sessions/${session.id}`)).body.session).toEqual(session);
  });

  it("删除等待正在提交的反馈后撤回提案，双方均正常完成", async () => {
    const fixture = await start(), rule = await create(fixture), review = await seedReview(fixture, rule);
    const blocker = new pg.Client(fixture.pool.options);
    await blocker.connect();
    let deletion: ReturnType<typeof fixture.request> | undefined;
    let disposition: ReturnType<typeof review.change> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-feedback:${fixture.teamId}:managed:${rule.id}`]);
      disposition = review.change({ version: 0, status: "Dismissed", reasonCategory: "rule_incorrect" });
      await waitForBlocked(blocker, 1);
      deletion = fixture.request(`/api/managed-rules/${rule.id.toUpperCase()}`, { version: 1 }, { method: "DELETE" });
      await waitForBlocked(blocker, 2);
      await blocker.query("COMMIT");
      expect((await disposition).status).toBe(200); expect((await deletion).status).toBe(200);
      expect((await fixture.request<Proposals>("/api/rule-proposals")).body.proposals).toMatchObject([{ status: "withdrawn", managedRuleId: null, feedbackCount: 1 }]);
    } finally {
      await blocker.query("ROLLBACK"); await blocker.end(); await Promise.allSettled([deletion, disposition]);
    }
  });

  it.each(["save", "create"] as const)("删除先取得团队锁时并发会话 %s 返回冲突或不存在，规范保持已删除", async (operation) => {
    const fixture = await start(), rule = await create(fixture);
    const session = (await fixture.request<{ session: RuleSession }>("/api/rule-sessions", { ruleId: rule.id })).body.session;
    const blocker = new pg.Client(fixture.pool.options);
    await blocker.connect();
    let deletion: ReturnType<typeof fixture.request> | undefined;
    let sessionChange: ReturnType<typeof fixture.request> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-hierarchy:${fixture.teamId}`]);
      deletion = fixture.request(rulePath(rule), { version: 1 }, { method: "DELETE" });
      await waitForBlocked(blocker, 1);
      sessionChange = operation === "save"
        ? fixture.request(`/api/rule-sessions/${session.id}/save-rule`, { version: session.version, workingCopy: session.workingCopy })
        : fixture.request("/api/rule-sessions", { ruleId: rule.id });
      await waitForBlocked(blocker, 2);
      await blocker.query("COMMIT");
      expect((await deletion).status).toBe(200);
      expect((await sessionChange).status).toBe(operation === "save" ? 409 : 404);
      expect((await fixture.request<Rules>("/api/managed-rules")).body.rules).toEqual([]);
    } finally {
      await blocker.query("ROLLBACK"); await blocker.end(); await Promise.allSettled([deletion, sessionChange]);
    }
  });
});
