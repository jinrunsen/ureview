import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTeam } from "../db/tenant.js";
import type { ReviewFinding, ReviewRule } from "../reviews/types.js";
import type { CatalogRule } from "./catalog-source.js";
import { RuleCatalogService } from "./catalog.js";
import type { RuleDetail } from "./detail.js";
import { loadRuleExecutions, ruleExecutionKey } from "./executions.js";
import type { ManagedRule } from "./managed-types.js";
import { ManagedRuleScenario, managedInput } from "./managed/test-support.js";

let scenario: ManagedRuleScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });
async function start() {
  scenario = new ManagedRuleScenario();
  await scenario.start();
  return scenario;
}
const finding = (ruleId: string | null, score = 90): ReviewFinding => ({
  id: randomUUID(), title: "金额计算使用浮点数", description: "交易金额需要使用整数分", severity: "medium",
  location: { path: "src/payment.ts", startLine: 1, endLine: 1 }, code: "const amount = 1.1", evidence: [],
  fixPrompt: "使用整数分", ruleId, generatedAt: "2026-10-06T00:00:00.000Z", score, status: "Pending", readFiles: [],
  generatorModel: { provider: "fixture", model: "generator", vendor: "fixture-a" },
  graderModel: { provider: "fixture", model: "grader", vendor: "fixture-b" },
});
function gitRule(repositoryId: string): CatalogRule {
  return { id: "repository:.agents/rules/payment.md", name: "金额使用整数分", body: "金额使用整数分。",
    scope: "repository", judgement: false, layer: "language", languages: ["typescript"], overrides: [], paths: ["src/**"], enabled: true, lazy: false,
    source: { kind: "manual" }, file: { kind: "repository", repositoryId, repositoryName: "commerce/inventory-service",
      path: ".agents/rules/payment.md", commitSha: "a".repeat(40), url: "https://gitlab.example.test/commerce/inventory-service/-/blob/main/.agents/rules/payment.md" } };
}
async function seedReview(fixture: ManagedRuleScenario, repositoryId: string, rules: ReviewRule[], findings: ReviewFinding[], status = "completed") {
  const id = randomUUID();
  await withTeam(fixture.teamId, async () => {
    await fixture.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,status,rules,completed_at,pull_request,round)
      VALUES($1::uuid,$2,$1::text,17,$3,'订单支付金额计算','李娜',$4,$5,now(),$6,
        (SELECT coalesce(max(round),0)+1 FROM reviews WHERE repository_id=$2 AND iid=17))`,
    [id, repositoryId, randomUUID().replaceAll("-", ""), status, JSON.stringify(rules), JSON.stringify({ webUrl: "https://gitlab.example.test/commerce/inventory-service/-/merge_requests/17" })]);
    for (const entry of findings) await fixture.pool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,$3)", [entry.id, id, JSON.stringify(entry)]);
  });
  return id;
}
function detailPath(id: string, repositoryId?: string) {
  return `/api/rules/${encodeURIComponent(id)}/detail${repositoryId ? `?repositoryId=${repositoryId}` : ""}`;
}

describe("规范详情与统一执行记录", () => {
  it("工作台与 Git 复用展示口径，采纳驳回及撤回来自当前处置", async () => {
    const fixture = await start();
    const managed = (await fixture.request<{ rule: ManagedRule }>("/api/managed-rules", { ...managedInput, status: "active" })).body.rule;
    const managedId = `managed:${managed.id}`;
    const git = gitRule(fixture.repositoryId);
    await withTeam(fixture.teamId, () => fixture.pool.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,$2,$3)", [fixture.repositoryId, git.id, JSON.stringify(git)]));
    const snapshots: ReviewRule[] = [{ id: managedId, body: managed.body, source: { kind: "generated" },
      file: { kind: "database", ruleId: managed.id, version: 1, scope: "global" }, matchedPaths: ["src/payment.ts"] },
    { ...git, matchedPaths: ["src/payment.ts"] }];
    const entries = [finding(managedId, 99), finding(managedId, 98), finding(git.id, 97), finding(git.id, 96),
      finding(null, 95), finding(managedId, 1), { ...finding(git.id, 100), severity: "low" as const }];
    const reviewId = await seedReview(fixture, fixture.repositoryId, snapshots, entries);
    await seedReview(fixture, fixture.repositoryId, snapshots, [finding(managedId)], "running");
    await seedReview(fixture, fixture.repositoryId, [], [finding(managedId), finding(git.id)]);
    for (const [index, entry] of entries.slice(0, 4).entries()) {
      const response = await fixture.identity.request(`/api/reviews/${reviewId}/findings/${entry.id}/disposition`,
        index % 2 ? { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "计算边界需要补充说明" }
          : { version: 0, status: "Resolved" }, { method: "PATCH" });
      expect(response.status).toBe(200);
    }
    for (const id of [managedId, git.id]) {
      const detail = await fixture.request<RuleDetail>(detailPath(id, fixture.repositoryId), undefined, { cookie: fixture.memberCookie });
      expect(detail.status).toBe(200);
      expect(detail.body.summary).toEqual({ hits: 2, adopted: 1, dismissed: 1, ignored: 0, dismissalReasons: { rule_incorrect: 1 } });
      expect(detail.body.records).toHaveLength(2);
      expect(detail.body.records[0]).toMatchObject({ reviewId, repositoryId: fixture.repositoryId, iid: 17, title: "订单支付金额计算", round: 1 });
      expect(detail.body.records.find((record) => record.status === "Dismissed")?.disposition).toMatchObject({
        actor: { id: fixture.userId, name: "张伟" }, reasonCategory: "rule_incorrect", explanation: "计算边界需要补充说明", version: 1,
      });
    }
    const catalog = await withTeam(fixture.teamId, () => new RuleCatalogService(fixture.pool, fixture.repositories).list());
    expect(catalog.rules[0]?.counts).toEqual({ hits: 2, adopted: 1, dismissed: 1, ignored: 0 });
    expect(catalog.managedRules[0]?.counts).toEqual(catalog.rules[0]?.counts);
    expect((await fixture.identity.request(`/api/reviews/${reviewId}/findings/${entries[0]!.id}/disposition`, { version: 1, status: "Pending" }, { method: "PATCH" })).status).toBe(200);
    expect((await fixture.request<RuleDetail>(detailPath(managedId))).body.summary.adopted).toBe(0);
    const current = await fixture.request<RuleDetail>(detailPath(managedId));
    expect(current.body.rule).toMatchObject({ name: managed.name, goodExample: managed.goodExample, badExample: managed.badExample,
      layer: "team", scope: "global", languages: [], source: { kind: "managed" }, version: 1 });
    const gitDetail = (await fixture.request<RuleDetail>(detailPath(git.id, fixture.repositoryId))).body;
    expect(gitDetail.rule).toMatchObject({ source: { kind: "git", file: git.file }, version: git.file.commitSha,
      repositories: [{ repositoryId: fixture.repositoryId, paths: ["src/**"] }], languages: ["typescript"] });
  });

  it("同路径的 Git 规范按仓库隔离，工作台规范汇总跨仓执行并支持仓库筛选", async () => {
    const fixture = await start();
    const managed = (await fixture.request<{ rule: ManagedRule }>("/api/managed-rules", { ...managedInput, status: "active" })).body.rule;
    const otherRepository = (await fixture.request<{ repository: { id: string } }>("/api/repositories", {
      instanceUrl: "https://gitlab.example.test", projectPath: "commerce/order-service", token: "fixture-readonly",
    })).body.repository.id;
    const id = `managed:${managed.id}`;
    for (const repositoryId of [fixture.repositoryId, otherRepository]) {
      const git = gitRule(repositoryId);
      await withTeam(fixture.teamId, () => fixture.pool.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,$2,$3)", [repositoryId, git.id, JSON.stringify(git)]));
      await seedReview(fixture, repositoryId, [{ ...git, matchedPaths: ["src/payment.ts"] },
        { id, body: managed.body, file: { kind: "database", ruleId: managed.id, version: 1, scope: "global" }, source: { kind: "generated" }, matchedPaths: ["src/payment.ts"] }],
      [finding(git.id), finding(id)]);
      expect((await fixture.request<RuleDetail>(detailPath(git.id, repositoryId))).body.summary.hits).toBe(1);
    }
    expect((await fixture.request<RuleDetail>(detailPath(id))).body.summary.hits).toBe(2);
    expect((await fixture.request<RuleDetail>(detailPath(id, otherRepository))).body.summary.hits).toBe(1);
    expect((await fixture.request(detailPath(gitRule(fixture.repositoryId).id))).status).toBe(400);
    const other = await fixture.otherTeam();
    expect((await fixture.request(detailPath(id), undefined, { cookie: other.cookie })).status).toBe(404);
    expect((await fixture.request(detailPath(gitRule(fixture.repositoryId).id, fixture.repositoryId), undefined, { cookie: other.cookie })).status).toBe(404);
    expect((await fixture.request(detailPath(id), undefined, { cookie: "" })).status).toBe(401);
  });

  it("详情返回覆盖关系和完整豁免记录，编辑后保留执行时的规范版本", async () => {
    const fixture = await start();
    const base = (await fixture.request<{ rule: ManagedRule }>("/api/managed-rules", { ...managedInput, layer: "general", status: "active" })).body.rule;
    const baseId = `managed:${base.id}`;
    const override = (await fixture.request<{ rule: ManagedRule }>("/api/managed-rules", {
      ...managedInput, name: "支付金额的语言规范", layer: "language", languages: ["typescript"], overrides: [baseId], status: "active",
    })).body.rule;
    const waiverPath = `/api/managed-rules/${base.id}/waivers/${fixture.repositoryId}`;
    expect((await fixture.request(waiverPath, { reason: "仓库迁移期间使用另一套金额模型" }, { method: "PUT" })).status).toBe(200);
    expect((await fixture.request(waiverPath, undefined, { method: "DELETE" })).status).toBe(200);
    await seedReview(fixture, fixture.repositoryId, [{ id: baseId, body: base.body, source: { kind: "generated" },
      file: { kind: "database", ruleId: base.id, version: 1, scope: "global" }, matchedPaths: ["src/payment.ts"] }], [finding(baseId)]);
    expect((await fixture.request(`/api/managed-rules/${base.id}`, { ...managedInput, layer: "general", status: "active", body: "金额必须使用整数分。", version: 1 }, { method: "PUT" })).status).toBe(200);
    const detail = (await fixture.request<RuleDetail>(detailPath(baseId))).body;
    expect(detail.rule.overriddenBy).toEqual([{ id: `managed:${override.id}`, name: override.name }]);
    expect(detail.rule.waivers).toHaveLength(1);
    expect(detail.rule.waivers[0]?.revokedAt).toBeTruthy();
    expect(detail.rule.version).toBe(2);
    expect(detail.records[0]?.ruleVersion).toBe(1);
  });

  it("非 UUID 的 managed 标识按仓库快照展示详情与处置记录，同名规范跨仓隔离", async () => {
    const fixture = await start();
    const ruleId = "managed:payment-policy";
    const otherRepository = (await fixture.request<{ repository: { id: string } }>("/api/repositories", {
      instanceUrl: "https://gitlab.example.test", projectPath: "commerce/refund-service", token: "fixture-readonly",
    })).body.repository.id;
    const first = { ...gitRule(fixture.repositoryId), id: ruleId, matchedPaths: ["src/payment.ts"] };
    const second = { ...gitRule(otherRepository), id: ruleId, name: "退款金额约定", body: "退款按整数分处理。", matchedPaths: ["src/payment.ts"] };
    const entry = finding(ruleId);
    const firstReviewId = await seedReview(fixture, fixture.repositoryId, [first], [entry]);
    const secondReviewId = await seedReview(fixture, otherRepository, [second], [finding(ruleId)]);
    expect((await fixture.identity.request(`/api/reviews/${firstReviewId}/findings/${entry.id}/disposition`,
      { version: 0, status: "Dismissed", reasonCategory: "rule_incorrect", explanation: "单价允许精确小数" }, { method: "PATCH" })).status).toBe(200);
    const detail = await fixture.request<RuleDetail>(detailPath(ruleId, fixture.repositoryId));
    expect(detail.status).toBe(200);
    expect(detail.body.rule).toMatchObject({ id: ruleId, name: first.name, body: first.body, status: "snapshot", source: { kind: "git", file: first.file } });
    expect(detail.body.rule.managedRule).toBeUndefined();
    expect(detail.body.summary).toEqual({ hits: 1, adopted: 0, dismissed: 1, ignored: 0, dismissalReasons: { rule_incorrect: 1 } });
    expect(detail.body.records).toMatchObject([{ reviewId: firstReviewId, findingId: entry.id, status: "Dismissed" }]);
    const other = await fixture.request<RuleDetail>(detailPath(ruleId, otherRepository));
    expect(other.body.rule.body).toBe(second.body);
    expect(other.body.records).toMatchObject([{ reviewId: secondReviewId, status: "Pending" }]);
    const executions = await withTeam(fixture.teamId, () => loadRuleExecutions(fixture.pool));
    expect(executions.get(ruleExecutionKey(ruleId, fixture.repositoryId))).toHaveLength(1);
    expect(executions.get(ruleExecutionKey(ruleId, otherRepository))).toHaveLength(1);
    expect((await fixture.request(detailPath(ruleId))).status).toBe(400);
  });

  it("未进入目录或已删除的 Git 规范使用同仓最近完成评审快照，当前目录存在时仍优先展示目录", async () => {
    const fixture = await start();
    const git = gitRule(fixture.repositoryId);
    const older: ReviewRule = { ...git, body: "旧轮次的金额约定。", matchedPaths: ["src/payment.ts"] };
    const latest: ReviewRule = { ...git, name: "退款金额约定", body: "退款金额按整数分处理。", goodExample: "const refundCents = 100;",
      badExample: "const refund = 1.0;", file: { ...git.file, commitSha: "b".repeat(40) }, matchedPaths: ["src/refund.ts"],
      layer: "language", languages: ["typescript"], overrides: [], overriddenBy: [{ ruleId: `managed:${randomUUID()}`, paths: ["src/refund.ts"] }] };
    const firstId = await seedReview(fixture, fixture.repositoryId, [older], [finding(git.id)]);
    const latestId = await seedReview(fixture, fixture.repositoryId, [latest], [{ ...finding(git.id), location: { path: "src/refund.ts", startLine: 1, endLine: 1 } }]);
    const runningId = await seedReview(fixture, fixture.repositoryId, [{ ...latest, body: "未完成轮次不作为详情依据。" }], [finding(git.id)], "running");
    await withTeam(fixture.teamId, async () => {
      await fixture.pool.query("UPDATE reviews SET completed_at='2026-10-01T00:00:00Z' WHERE id=$1", [firstId]);
      await fixture.pool.query("UPDATE reviews SET completed_at='2026-10-02T00:00:00Z' WHERE id=$1", [latestId]);
      await fixture.pool.query("UPDATE reviews SET completed_at='2026-10-03T00:00:00Z' WHERE id=$1", [runningId]);
    });
    const path = detailPath(git.id, fixture.repositoryId);
    const detail = await fixture.request<RuleDetail>(path);
    expect(detail.status).toBe(200);
    expect(detail.body.rule).toMatchObject({ status: "snapshot", name: latest.name, body: latest.body,
      goodExample: latest.goodExample, badExample: latest.badExample, layer: latest.layer, languages: latest.languages,
      version: "b".repeat(40), source: { kind: "git", file: latest.file },
      repositories: [{ repositoryId: fixture.repositoryId, paths: ["src/refund.ts"] }],
      overriddenBy: [{ id: latest.overriddenBy![0]!.ruleId, name: latest.overriddenBy![0]!.ruleId }] });
    expect(detail.body.summary.hits).toBe(2);
    expect(detail.body.records.map((record) => record.reviewId)).toEqual([latestId, firstId]);
    await withTeam(fixture.teamId, () => fixture.pool.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,$2,$3)", [fixture.repositoryId, git.id, JSON.stringify(git)]));
    expect((await fixture.request<RuleDetail>(path)).body.rule).toMatchObject({ status: "active", body: git.body, version: git.file.commitSha });
    await withTeam(fixture.teamId, () => fixture.pool.query("DELETE FROM rule_catalog WHERE repository_id=$1", [fixture.repositoryId]));
    expect((await fixture.request<RuleDetail>(path)).body.rule).toMatchObject({ status: "snapshot", body: latest.body });
    expect((await fixture.request(detailPath("repository:.agents/rules/missing.md", fixture.repositoryId))).status).toBe(404);
    const other = await fixture.otherTeam();
    expect((await fixture.request(detailPath(git.id, other.repositoryId), undefined, { cookie: other.cookie })).status).toBe(404);
  });
});
