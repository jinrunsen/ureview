import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import pg from "pg";
import { withIdentity } from "../auth/context.js";
import { withTeam } from "../db/tenant.js";
import { migrate } from "../db/migrate.js";
import { FindingDispositionService, type DispositionInput } from "../reviews/dispositions.js";
import type { ReviewFinding } from "../reviews/types.js";
import { managedRuleInput } from "./library.js";
import { managedInput, ManagedRuleScenario } from "./managed/test-support.js";
import type { ManagedRule } from "./managed-types.js";
import { syncCandidateProposals } from "./proposal-records.js";
import type { RuleProposal } from "./proposal-types.js";

let scenario: ManagedRuleScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });
async function start() { scenario = new ManagedRuleScenario(); await scenario.start(); return scenario; }
type RuleResponse = { rule: ManagedRule };
type Proposals = { proposals: RuleProposal[] };
async function findings(fixture: ManagedRuleScenario, ruleId: string, scope = { teamId: fixture.teamId, repositoryId: fixture.repositoryId }) {
  const reviewId = randomUUID();
  const entries: ReviewFinding[] = [0, 1].map((index) => ({ id: randomUUID(), title: `金额检查 ${index}`, description: "金额处理需要依据规范调整", severity: "medium", score: 90,
    code: "amount = input", location: { path: "src/payment.ts", startLine: index + 1, endLine: index + 1 }, evidence: [], fixPrompt: "检查金额处理", ruleId,
    generatedAt: new Date().toISOString(), status: "Pending", anchor: null, readFiles: [],
    generatorModel: { provider: "fixture", model: "generator", vendor: "fixture" }, graderModel: { provider: "fixture", model: "grader", vendor: "fixture" } }));
  await withTeam(scope.teamId, async () => {
    await fixture.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,status,rules)
      VALUES($1,$2,$3,1,$3,'支付金额调整','张伟',(SELECT coalesce(max(round),0)+1 FROM reviews WHERE repository_id=$2 AND iid=1),'completed',$4)`, [reviewId, scope.repositoryId, randomUUID(), JSON.stringify([{ id: ruleId, name: "金额规范", body: managedInput.body }])]);
    for (const finding of entries) await fixture.pool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,$3)", [finding.id, reviewId, JSON.stringify(finding)]);
  });
  const change = (index: number, value: unknown) => withIdentity({ userId: fixture.userId, teamId: scope.teamId, username: "zhang.wei", email: "zhang.wei@example.test", name: "张伟", teamName: "团队", role: "admin" },
    () => new FindingDispositionService(fixture.pool).change(reviewId, entries[index]!.id, value));
  return { entries, reviewId, change };
}

async function feedback(fixture: ManagedRuleScenario, status?: RuleProposal["status"], cookie?: string) {
  const result = await fixture.request<Proposals>(`/api/rule-proposals?source=feedback${status ? `&status=${status}` : ""}`, undefined, cookie ? { cookie } : {});
  expect(result.status).toBe(200);
  return result.body.proposals;
}

describe("统一规范提案", () => {
  it("升级为各团队旧草稿和历史候选回填待审核提案，重复迁移不改变记录", async () => {
    const fixture = await start();
    const draft = (await fixture.request<RuleResponse>("/api/managed-rules", managedInput)).body.rule;
    await fixture.request("/api/managed-rules", { ...managedInput, status: "active" });
    const candidateId = randomUUID();
    await withTeam(fixture.teamId, () => fixture.pool.query("INSERT INTO rule_candidates(id,repository_id,candidate_key,payload) VALUES($1,$2,'migration',$3)",
      [candidateId, fixture.repositoryId, JSON.stringify({ key: "migration", body: managedInput.body, suggestedPath: ".agents/rules/legacy.md", markdown: managedInput.body, evidence: [] })]));
    const other = await fixture.otherTeam();
    const otherDraft = (await fixture.request<RuleResponse>("/api/managed-rules", managedInput, { cookie: other.cookie })).body.rule;
    await fixture.pool.query(`DROP TABLE rule_proposal_feedback; DROP TABLE rule_proposals;
      ALTER TABLE managed_rules DROP COLUMN library_source;
      ALTER TABLE rule_candidates DROP CONSTRAINT rule_candidates_team_id_id;
      DELETE FROM schema_migrations WHERE filename IN ('0027_rule_library_and_proposals.sql','0031_rule_feedback_withdrawal.sql')`);
    const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    expect(await migrate(fixture.pool, directory)).toEqual(["0027_rule_library_and_proposals.sql", "0031_rule_feedback_withdrawal.sql"]);
    const proposals = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals.find((proposal) => proposal.source === "generation")).toMatchObject({ managedRuleId: draft.id, status: "pending" });
    expect(proposals.find((proposal) => proposal.source === "mining")?.candidate?.id).toBe(candidateId);
    expect((await fixture.request<Proposals>("/api/rule-proposals", undefined, { cookie: other.cookie })).body.proposals).toMatchObject([{ managedRuleId: otherDraft.id, status: "pending" }]);
    expect(await migrate(fixture.pool, directory)).toEqual([]);
    expect((await fixture.request<Proposals>("/api/rule-proposals")).body.proposals).toEqual(proposals);
  });
  it("审核后的草稿修改创建新的待审核提案，保留历史正文、决定与规范库来源", async () => {
    const fixture = await start();
    const original = await fixture.seedLegacyLibraryDraft("power-of-ten", "power-of-ten-bounded-calls");
    const first = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals[0]!;
    await fixture.request(`/api/rule-proposals/${first.id}/review`, { status: "rejected", reason: "先明确间接调用的检查范围" });
    const edited = (await fixture.request<RuleResponse>(`/api/managed-rules/${original.id}`, { ...managedRuleInput(original), body: "调用图包括直接调用与可解析的间接调用。", version: 1 }, { method: "PUT" })).body.rule;
    const second = (await fixture.request<Proposals>("/api/rule-proposals?status=pending")).body.proposals[0]!;
    expect(second).toMatchObject({ source: "library", body: edited.body, managedRuleId: original.id });
    expect(second.id).not.toBe(first.id);
    const active = (await fixture.request<{ rule: ManagedRule }>(`/api/rule-proposals/${second.id}/review`, { status: "accepted" })).body.rule;
    await fixture.request<RuleResponse>(`/api/managed-rules/${original.id}`, { ...managedRuleInput(active), status: "draft", body: "调用图需要覆盖所有直接和间接调用。", version: active.version }, { method: "PUT" });
    const proposals = (await fixture.request<Proposals>("/api/rule-proposals")).body.proposals;
    expect(proposals).toHaveLength(3);
    expect(proposals.find((proposal) => proposal.id === first.id)).toMatchObject({ status: "rejected", body: original.body, rejectionReason: "先明确间接调用的检查范围" });
    expect(proposals.find((proposal) => proposal.id === second.id)).toMatchObject({ status: "accepted", body: edited.body });
    expect(proposals.filter((proposal) => proposal.status === "pending")).toHaveLength(1);
    expect(proposals.find((proposal) => proposal.status === "pending")?.source).toBe("library");
  });
  it("生成草稿与历史规范库草稿保留来源，管理员采纳原子启用规范并保存审核者", async () => {
    const fixture = await start();
    const generated = (await fixture.request<RuleResponse>("/api/managed-rules", managedInput)).body.rule;
    await fixture.seedLegacyLibraryDraft("power-of-ten", "power-of-ten-bounded-calls");
    const proposals = (await fixture.request<Proposals>("/api/rule-proposals?status=pending")).body.proposals;
    expect(proposals.map((proposal) => proposal.source).sort()).toEqual(["generation", "library"]);
    for (const proposal of proposals) {
      const result = await fixture.request<{ proposal: RuleProposal; rule: ManagedRule }>(`/api/rule-proposals/${proposal.id}/review`, { status: "accepted" });
      expect(result.status).toBe(200);
      expect(result.body.proposal).toMatchObject({ status: "accepted", reviewedBy: { id: fixture.userId } });
      expect(result.body.proposal.reviewedAt).toBeTruthy(); expect(result.body.rule).toMatchObject({ status: "active", version: 2 });
    }
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules.find((rule) => rule.id === generated.id)?.status).toBe("active");
    expect((await fixture.request<Proposals>("/api/rule-proposals?status=pending")).body.proposals).toEqual([]);
  });
  it("拒绝必填理由，成员只读，其他团队无法访问和审核", async () => {
    const fixture = await start();
    await fixture.request("/api/managed-rules", managedInput);
    const proposal = (await fixture.request<Proposals>("/api/rule-proposals", undefined, { cookie: fixture.memberCookie })).body.proposals[0]!;
    const route = `/api/rule-proposals/${proposal.id}/review`;
    expect((await fixture.request(route, { status: "rejected" })).status).toBe(400);
    expect((await fixture.request(route, { status: "rejected", reason: "   " })).status).toBe(400);
    expect((await fixture.request(route, { status: "accepted" }, { cookie: fixture.memberCookie })).status).toBe(403);
    const other = await fixture.otherTeam();
    expect((await fixture.request<Proposals>("/api/rule-proposals", undefined, { cookie: other.cookie })).body.proposals).toEqual([]);
    expect((await fixture.request(route, { status: "accepted" }, { cookie: other.cookie })).status).toBe(404);
    const rejected = await fixture.request<{ proposal: RuleProposal }>(route, { status: "rejected", reason: "金额约定需要先限定业务范围" });
    expect(rejected.body.proposal).toMatchObject({ status: "rejected", rejectionReason: "金额约定需要先限定业务范围", reviewedBy: { id: fixture.userId } });
    expect((await fixture.request(route, { status: "accepted" })).status).toBe(409);
    expect((await fixture.pool.query("SELECT id FROM rule_proposals")).rowCount).toBe(0);
  });
  it("反馈按规范和类别合并全部来源，重复处置不累加，审核后新驳回生成新提案", async () => {
    const fixture = await start();
    const rule = (await fixture.request<RuleResponse>("/api/managed-rules", { ...managedInput, status: "active" })).body.rule;
    const source = await findings(fixture, `managed:${rule.id}`);
    for (const index of [0, 1]) await source.change(index, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: `第 ${index + 1} 处允许小数计价` });
    const proposal = (await fixture.request<Proposals>("/api/rule-proposals?source=feedback")).body.proposals[0]!;
    expect(proposal).toMatchObject({ status: "pending", managedRuleId: rule.id, ruleId: `managed:${rule.id}`, reasonCategory: "rule_incorrect", feedbackCount: 2 });
    expect(proposal.feedback.map((item) => item.findingId).sort()).toEqual(source.entries.map((item) => item.id).sort());
    await source.change(1, { version: 1, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "第 2 处允许小数计价" });
    expect((await fixture.request<Proposals>("/api/rule-proposals?source=feedback")).body.proposals[0]!.feedbackCount).toBe(2);
    expect((await fixture.request(`/api/rule-proposals/${proposal.id}/review`, { status: "accepted" })).status).toBe(400);
    const result = await fixture.request<{ proposal: RuleProposal; rule: ManagedRule }>(`/api/rule-proposals/${proposal.id}/review`, { status: "accepted", rule: { ...managedRuleInput(rule), body: "交易金额以整数分表示，单价允许使用精确小数类型。", version: 1 } });
    expect(result.status).toBe(200); expect(result.body.rule.version).toBe(2); expect(result.body.proposal.status).toBe("accepted");
    await source.change(0, { version: 1, status: "Pending" });
    await source.change(0, { version: 2, status: "Dismissed", reasonCategory: "rule_incorrect" });
    const proposals = (await fixture.request<Proposals>("/api/rule-proposals?source=feedback")).body.proposals;
    expect(proposals).toHaveLength(2);
    expect(proposals.find((item) => item.status === "pending")?.feedbackCount).toBe(1);
  });
  it("非 UUID 的 managed 规范标识允许驳回，并以评审快照生成反馈提案", async () => {
    const fixture = await start();
    const ruleId = "managed:payment-policy";
    const source = await findings(fixture, ruleId);
    const entry = source.entries[0]!;
    const response = await fixture.identity.request<{ finding: ReviewFinding }>(`/api/reviews/${source.reviewId}/findings/${entry.id}/disposition`,
      { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价允许使用精确小数" }, { method: "PATCH" });
    expect(response.status).toBe(200);
    expect(response.body.finding).toMatchObject({ status: "Dismissed", disposition: { version: 1, reasonCategory: "rule_incorrect" } });
    const proposals = await feedback(fixture, "pending");
    expect(proposals).toMatchObject([{ managedRuleId: null, ruleId, repositoryId: fixture.repositoryId,
      name: "金额规范", body: managedInput.body, reasonCategory: "rule_incorrect", feedbackCount: 1,
      feedback: [{ findingId: entry.id, reviewId: source.reviewId, explanation: "单价允许使用精确小数" }] }]);
    const accepted = await fixture.request<{ proposal: RuleProposal; rule?: ManagedRule }>(`/api/rule-proposals/${proposals[0]!.id}/review`, { status: "accepted" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.proposal).toMatchObject({ status: "accepted", managedRuleId: null });
    expect(accepted.body.rule).toBeUndefined();
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toEqual([]);
  });
  it("不同理由分开，编辑冲突与处置回滚保留原提案和规范", async () => {
    const fixture = await start();
    const rule = (await fixture.request<RuleResponse>("/api/managed-rules", { ...managedInput, status: "active" })).body.rule;
    const source = await findings(fixture, `managed:${rule.id}`);
    await source.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
    await source.change(1, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect" });
    const proposals = (await fixture.request<Proposals>("/api/rule-proposals?source=feedback")).body.proposals;
    expect(proposals).toHaveLength(2);
    expect((await fixture.request(`/api/rule-proposals/${proposals[0]!.id}/review`, { status: "accepted", rule: { ...managedRuleInput(rule), version: 8 } })).status).toBe(409);
    expect((await fixture.request<Proposals>("/api/rule-proposals?status=pending")).body.proposals).toHaveLength(2);
    await withTeam(fixture.teamId, () => fixture.pool.query(`CREATE FUNCTION reject_feedback() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;
      CREATE TRIGGER reject_feedback BEFORE INSERT ON rule_proposal_feedback FOR EACH ROW EXECUTE FUNCTION reject_feedback()`));
    await source.change(0, { version: 1, status: "Pending" });
    await expect(source.change(0, { version: 2, status: "Dismissed", reasonCategory: "rule_incorrect" })).rejects.toThrow();
    expect(await withTeam(fixture.teamId, async () => (await fixture.pool.query("SELECT status FROM review_findings WHERE id=$1", [source.entries[0]!.id])).rows[0].status)).toBe("Pending");
    const updated = (await fixture.request<Proposals>("/api/rule-proposals?source=feedback")).body.proposals;
    expect(updated.find((proposal) => proposal.reasonCategory === "rule_not_applicable")).toMatchObject({ status: "withdrawn", feedbackCount: 0 });
    expect(updated.find((proposal) => proposal.reasonCategory === "rule_incorrect")).toMatchObject({ status: "pending", feedbackCount: 1 });
  });
  it("历史候选提供可复制内容，其他路径同正文识别为生效", async () => {
    const fixture = await start();
    const candidateId = randomUUID();
    await withTeam(fixture.teamId, async () => {
      const client = await fixture.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("INSERT INTO rule_candidates(id,repository_id,candidate_key,payload) VALUES($1,$2,'fixture',$3)", [candidateId, fixture.repositoryId, JSON.stringify({ key: "fixture", body: managedInput.body, suggestedPath: ".agents/rules/suggested.md", markdown: `---\npaths: [src/**]\n---\n${managedInput.body}`, evidence: [] })]);
        await syncCandidateProposals(client);
        await client.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,'repository:other',$2)", [fixture.repositoryId, JSON.stringify({ body: managedInput.body, enabled: true, lazy: false, file: { path: ".agents/rules/other.md" } })]);
        await client.query("COMMIT");
      } finally { client.release(); }
    });
    const proposal = (await fixture.request<Proposals>("/api/rule-proposals?source=mining")).body.proposals[0]!;
    expect(proposal.candidate).toMatchObject({ id: candidateId, active: true });
    expect(proposal.candidate?.markdown).toContain(managedInput.body);
    expect((await fixture.request<{ proposal: RuleProposal }>(`/api/rule-proposals/${proposal.id}/review`, { status: "accepted" })).body.proposal.status).toBe("accepted");
  });
  it.each<{ name: string; input: DispositionInput }>([
    { name: "撤回处置", input: { version: 1, status: "Pending" } },
    { name: "采纳", input: { version: 1, status: "Resolved" } },
    { name: "改为误报", input: { version: 1, status: "Dismissed", reasonCategory: "false_positive" } },
  ])("$name 逐条撤回反馈，空提案退出待审核并拒绝审核", async ({ input }) => {
    const fixture = await start();
    const source = await findings(fixture, "repository:.agents/rules/amount.md");
    for (const index of [0, 1]) await source.change(index, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
    const original = (await feedback(fixture))[0]!;
    await source.change(0, input);
    expect(await feedback(fixture, "pending")).toMatchObject([{ id: original.id, feedbackCount: 1, feedback: [{ findingId: source.entries[1]!.id }] }]);
    await source.change(1, input);
    expect(await feedback(fixture, "pending")).toEqual([]);
    expect(await feedback(fixture, "withdrawn")).toMatchObject([{ id: original.id, feedbackCount: 0, feedback: [], reviewedAt: null, reviewedBy: null }]);
    expect((await fixture.request(`/api/rule-proposals/${original.id}/review`, { status: "rejected", reason: "核对适用范围" })).status).toBe(409);
    await source.change(0, { version: 2, status: "Dismissed", reasonCategory: "rule_not_applicable" });
    const renewed = await feedback(fixture, "pending");
    expect(renewed).toHaveLength(1); expect(renewed[0]!.id).not.toBe(original.id); expect(renewed[0]!.feedbackCount).toBe(1);
  });
  it("同理由编辑更新一份反馈，更换规范理由时转入对应提案", async () => {
    const fixture = await start();
    const source = await findings(fixture, "repository:.agents/rules/amount.md");
    await source.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价需要小数" });
    const original = (await feedback(fixture))[0]!;
    await source.change(0, { version: 1, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价使用精确小数，结算金额使用整数分" });
    expect(await feedback(fixture)).toMatchObject([{ id: original.id, status: "pending", feedbackCount: 1, feedback: [{ explanation: "单价使用精确小数，结算金额使用整数分" }] }]);
    await source.change(1, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
    const target = (await feedback(fixture)).find((proposal) => proposal.reasonCategory === "rule_not_applicable")!;
    await source.change(0, { version: 2, status: "Dismissed", reasonCategory: "rule_not_applicable" });
    expect(await feedback(fixture, "pending")).toMatchObject([{ id: target.id, feedbackCount: 2 }]);
    expect(await feedback(fixture, "withdrawn")).toMatchObject([{ id: original.id, feedbackCount: 0 }]);
  });
  it.each(["accepted", "rejected"] as const)("%s 提案保留审核时反馈，后续处置不改变历史", async (status) => {
    const fixture = await start();
    const source = await findings(fixture, "repository:.agents/rules/amount.md");
    await source.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价需要小数" });
    const original = (await feedback(fixture))[0]!;
    expect((await fixture.request(`/api/rule-proposals/${original.id}/review`, { status, ...(status === "rejected" ? { reason: "确认规范覆盖范围" } : {}) })).status).toBe(200);
    const frozen = (await feedback(fixture, status))[0]!;
    await source.change(0, { version: 1, status: "Pending" });
    await source.change(0, { version: 2, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "精确小数可用于单价" });
    expect(await feedback(fixture, status)).toEqual([frozen]);
    expect(await feedback(fixture, "pending")).toMatchObject([{ feedbackCount: 1, feedback: [{ explanation: "精确小数可用于单价" }] }]);
  });
  it("撤回提案失败时恢复反馈、当前处置和处置历史", async () => {
    const fixture = await start();
    const source = await findings(fixture, "repository:.agents/rules/amount.md");
    await source.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect" });
    const original = await feedback(fixture);
    await withTeam(fixture.teamId, () => fixture.pool.query(`CREATE FUNCTION reject_withdrawal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='withdrawn' THEN RAISE EXCEPTION '撤回失败样本'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_withdrawal BEFORE UPDATE ON rule_proposals FOR EACH ROW EXECUTE FUNCTION reject_withdrawal()`));
    await expect(source.change(0, { version: 1, status: "Pending" })).rejects.toThrow("撤回失败样本");
    expect(await feedback(fixture)).toEqual(original);
    await withTeam(fixture.teamId, async () => {
      expect((await fixture.pool.query("SELECT status,disposition_version FROM review_findings WHERE id=$1", [source.entries[0]!.id])).rows).toEqual([{ status: "Dismissed", disposition_version: 1 }]);
      expect((await fixture.pool.query("SELECT version FROM finding_disposition_events WHERE finding_id=$1 ORDER BY version", [source.entries[0]!.id])).rows).toEqual([{ version: 1 }]);
    });
  });
  it("不同评审同时交换理由保留两份反馈，最后同时撤回后两个提案均退出待审核", async () => {
    const fixture = await start();
    const first = await findings(fixture, "repository:.agents/rules/amount.md");
    const second = await findings(fixture, "repository:.agents/rules/amount.md");
    await first.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect" });
    await second.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
    await Promise.all([
      first.change(0, { version: 1, status: "Dismissed", reasonCategory: "rule_not_applicable" }),
      second.change(0, { version: 1, status: "Dismissed", reasonCategory: "rule_incorrect" }),
    ]);
    const pending = await feedback(fixture, "pending");
    expect(pending).toHaveLength(2); expect(pending.every((proposal) => proposal.feedbackCount === 1)).toBe(true);
    expect(pending.find((proposal) => proposal.reasonCategory === "rule_not_applicable")!.feedback[0]!.findingId).toBe(first.entries[0]!.id);
    expect(pending.find((proposal) => proposal.reasonCategory === "rule_incorrect")!.feedback[0]!.findingId).toBe(second.entries[0]!.id);
    await Promise.all([first.change(0, { version: 2, status: "Pending" }), second.change(0, { version: 2, status: "Resolved" })]);
    expect(await feedback(fixture, "pending")).toEqual([]);
    expect((await feedback(fixture)).every((proposal) => proposal.status === "withdrawn" && proposal.feedbackCount === 0)).toBe(true);
  });
  it.each(["review", "withdrawal"] as const)("审核与撤回并发时按首个取得提案行锁的操作提交（%s）", async (first) => {
    const fixture = await start();
    const source = await findings(fixture, "repository:.agents/rules/amount.md");
    await source.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect" });
    const proposal = (await feedback(fixture))[0]!;
    const blocker = new pg.Client(fixture.pool.options);
    await blocker.connect();
    await blocker.query("SELECT set_config('app.team_id',$1,false)", [fixture.teamId]);
    let review: ReturnType<typeof fixture.request> | undefined;
    let withdrawal: ReturnType<typeof source.change> | undefined;
    async function waitForBlocked(count: number) {
      await expect.poll(async () => (await blocker.query<{ count: number }>(`SELECT count(DISTINCT lock.pid)::integer AS count
        FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid
        WHERE activity.datname=current_database() AND NOT lock.granted`)).rows[0]!.count,
      { timeout: 5000, interval: 10 }).toBe(count);
    }
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM rule_proposals WHERE id=$1 FOR UPDATE", [proposal.id]);
      if (first === "review") review = fixture.request(`/api/rule-proposals/${proposal.id}/review`, { status: "accepted" });
      else withdrawal = source.change(0, { version: 1, status: "Pending" });
      await waitForBlocked(1);
      if (first === "review") withdrawal = source.change(0, { version: 1, status: "Pending" });
      else review = fixture.request(`/api/rule-proposals/${proposal.id}/review`, { status: "accepted" });
      await waitForBlocked(2);
      await blocker.query("COMMIT");
      expect((await review!).status).toBe(first === "review" ? 200 : 409);
      expect((await withdrawal!).status).toBe("Pending");
      expect(await feedback(fixture)).toMatchObject([{ id: proposal.id, status: first === "review" ? "accepted" : "withdrawn", feedbackCount: first === "review" ? 1 : 0 }]);
    } finally {
      await blocker.query("ROLLBACK"); await blocker.end();
      await Promise.allSettled([review, withdrawal]);
    }
  });
  it("升级清理各团队待审核旧反馈并保留审核快照，重复迁移不改变结果", async () => {
    const fixture = await start();
    const other = await fixture.otherTeam();
    const scopes = [{ teamId: fixture.teamId, repositoryId: fixture.repositoryId, cookie: fixture.cookie }, other];
    const expected: Array<{ cookie: string; withdrawnId: string; pendingId: string; frozen: RuleProposal }> = [];
    for (const scope of scopes) {
      const source = await findings(fixture, "repository:.agents/rules/amount.md", scope);
      await source.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
      const withdrawnId = (await feedback(fixture, "pending", scope.cookie))[0]!.id;
      await source.change(0, { version: 1, status: "Pending" });
      await source.change(1, { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价需要小数" });
      const pendingId = (await feedback(fixture, "pending", scope.cookie))[0]!.id;
      await source.change(1, { version: 1, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价使用精确小数" });
      const audited = await findings(fixture, "repository:.agents/rules/amount.md", scope);
      await audited.change(0, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
      const auditedId = (await feedback(fixture, "pending", scope.cookie)).find((proposal) => proposal.reasonCategory === "rule_not_applicable")!.id;
      expect((await fixture.request(`/api/rule-proposals/${auditedId}/review`, { status: "accepted" }, { cookie: scope.cookie })).status).toBe(200);
      await audited.change(0, { version: 1, status: "Pending" });
      const frozen = (await feedback(fixture, "accepted", scope.cookie))[0]!;
      await withTeam(scope.teamId, async () => {
        await fixture.pool.query("UPDATE rule_proposals SET status='pending' WHERE id=$1", [withdrawnId]);
        for (const [index, proposalId] of [[0, withdrawnId], [1, pendingId]] as const) {
          await fixture.pool.query(`INSERT INTO rule_proposal_feedback(proposal_id,review_id,finding_id,disposition_version,title,explanation)
            VALUES($1,$2,$3,1,$4,'单价需要小数')`, [proposalId, source.reviewId, source.entries[index]!.id, source.entries[index]!.title]);
        }
      });
      expected.push({ cookie: scope.cookie, withdrawnId, pendingId, frozen });
    }
    await fixture.pool.query(`ALTER TABLE rule_proposals DROP CONSTRAINT rule_proposals_status_check;
      ALTER TABLE rule_proposals ADD CONSTRAINT rule_proposals_status_check CHECK(status IN ('pending','accepted','rejected'));
      DELETE FROM schema_migrations WHERE filename='0031_rule_feedback_withdrawal.sql'`);
    const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    expect(await migrate(fixture.pool, directory)).toEqual(["0031_rule_feedback_withdrawal.sql"]);
    for (const value of expected) {
      expect(await feedback(fixture, "withdrawn", value.cookie)).toMatchObject([{ id: value.withdrawnId, feedbackCount: 0 }]);
      expect(await feedback(fixture, "pending", value.cookie)).toMatchObject([{ id: value.pendingId, feedbackCount: 1, feedback: [{ explanation: "单价使用精确小数" }] }]);
      expect(await feedback(fixture, "accepted", value.cookie)).toEqual([value.frozen]);
    }
    const before = await Promise.all(expected.map((value) => feedback(fixture, undefined, value.cookie)));
    expect(await migrate(fixture.pool, directory)).toEqual([]);
    expect(await Promise.all(expected.map((value) => feedback(fixture, undefined, value.cookie)))).toEqual(before);
    expect((await fixture.pool.query("SELECT id FROM rule_proposals")).rows).toEqual([]);
  });
});
