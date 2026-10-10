import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthError, withIdentity } from "../auth/context.js";
import { createCollaborationFixture } from "../collaboration/test-support.js";
import { FindingDispositionService } from "../reviews/dispositions.js";
import type { ReviewFinding } from "../reviews/types.js";
import { registerTeamOverviewRoutes } from "./http.js";
import { TeamOverviewService } from "./service.js";

let fixture: Awaited<ReturnType<typeof createCollaborationFixture>>;
let service: TeamOverviewService;
let dispositions: FindingDispositionService;
const finding = (overrides: Partial<ReviewFinding> = {}): ReviewFinding => ({
  id: randomUUID(), title: "订单释放库存需要幂等", description: "避免并发恢复库存", severity: "medium", code: "restore(order)",
  location: { path: "src/order.ts", startLine: 1, endLine: 1 }, evidence: [], fixPrompt: "按订单去重", ruleId: null,
  generatedAt: new Date().toISOString(), score: 90, status: "Pending", anchor: null,
  generatorModel: { provider: "fixture", model: "generator", vendor: "fixture" },
  graderModel: { provider: "fixture", model: "grader", vendor: "fixture" }, readFiles: [], ...overrides,
});
async function insert(reviewId: string, values: ReviewFinding[]) {
  await withIdentity(fixture.alice, async () => {
    for (const item of values) await fixture.pool.query("INSERT INTO review_findings(id,review_id,payload,status) VALUES($1,$2,$3,$4)",
      [item.id, reviewId, JSON.stringify(item), item.status]);
  });
}
const overview = () => withIdentity(fixture.alice, () => service.get());
beforeEach(async () => {
  fixture = await createCollaborationFixture();
  service = new TeamOverviewService(fixture.pool);
  dispositions = new FindingDispositionService(fixture.pool);
  registerTeamOverviewRoutes(fixture.app, fixture.pool);
  fixture.app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthError) return reply.code(error.statusCode).send({ error: { code: error.code } });
    throw error;
  });
  await withIdentity(fixture.alice, () => fixture.pool.query("DELETE FROM review_findings"));
});
afterEach(async () => { await fixture?.close(); });

describe("负责人团队概览", () => {
  it("没有处置时保留空采纳率和五类零计数", async () => {
    const result = await overview();
    expect(result.reviewRounds).toBe(2);
    expect(result.adoptionRate).toBeNull();
    expect(result.dismissalReasons).toHaveLength(5);
    expect(result.dismissalReasons.every((item) => item.count === 0)).toBe(true);
    expect(result.mostDismissedRules).toEqual([]);
    expect(result.totals).toEqual({ repositories: 1, pullRequests: 2, completed: 2, queued: 0, running: 0 });
    expect(Date.parse(result.period.to) - Date.parse(result.period.from)).toBe(28 * 24 * 60 * 60 * 1000);
  });

  it("仅统计最近四周发起的轮次，历史重跑均计入且总计按最新轮次", async () => {
    await withIdentity(fixture.alice, async () => {
      await fixture.pool.query("UPDATE reviews SET created_at=now()-interval '29 days' WHERE id=$1", [fixture.secondReviewId]);
      await fixture.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,status,created_at)
        SELECT $1,repository_id,$2,iid,'rerun','复查库存','author',2,'running',now()-interval '27 days' FROM reviews WHERE id=$3`,
      [randomUUID(), randomUUID(), fixture.reviewId]);
      await fixture.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,status,created_at)
        SELECT $1,repository_id,$2,3,'future','未来样本','author',1,'queued',now()+interval '1 day' FROM reviews WHERE id=$3`,
      [randomUUID(), randomUUID(), fixture.reviewId]);
    });
    await insert(fixture.secondReviewId, [finding({ severity: "high" })]);
    const result = await overview();
    expect(result.reviewRounds).toBe(2);
    expect(result.findings).toEqual({ high: 0, medium: 0, resolved: 0, dismissed: 0 });
    expect(result.totals).toEqual({ repositories: 1, pullRequests: 3, completed: 1, queued: 1, running: 1 });
  });

  it("展示数沿用前五策略，折叠和低危不计入，系统状态不进采纳分母", async () => {
    const items = [finding({ severity: "high", score: 99 }), finding({ score: 98 }), finding({ score: 97, status: "Ignored" }),
      finding({ severity: "high", score: 96, status: "Outdated" }), finding({ score: 95 }),
      finding({ severity: "high", score: 80, status: "Resolved" }), finding({ severity: "low", score: 100, status: "Resolved" })];
    await insert(fixture.reviewId, items);
    await withIdentity(fixture.alice, async () => {
      await dispositions.change(fixture.reviewId, items[0]!.id, { version: 0, status: "Resolved" });
      await dispositions.change(fixture.reviewId, items[1]!.id, { version: 0, status: "Dismissed", reasonCategory: "false_positive" });
    });
    const result = await overview();
    expect(result.findings).toEqual({ high: 2, medium: 3, resolved: 1, dismissed: 1 });
    expect(result.adoptionRate).toBe(0.5);
    expect(result.dismissalReasons.find((item) => item.category === "false_positive")?.count).toBe(1);
  });

  it("处置修改和撤回只按当前版本计数，理由来自对应处置记录", async () => {
    const item = finding(); await insert(fixture.reviewId, [item]);
    await withIdentity(fixture.alice, async () => {
      await dispositions.change(fixture.reviewId, item.id, { version: 0, status: "Resolved" });
      await dispositions.change(fixture.reviewId, item.id, { version: 1, status: "Dismissed", reasonCategory: "false_positive" });
      await dispositions.change(fixture.reviewId, item.id, { version: 2, status: "Dismissed", reasonCategory: "rule_incorrect" });
    });
    const dismissed = await overview();
    expect(dismissed.adoptionRate).toBe(0);
    expect(dismissed.findings).toMatchObject({ resolved: 0, dismissed: 1 });
    expect(dismissed.dismissalReasons.filter((reason) => reason.count > 0)).toEqual([{ category: "rule_incorrect", count: 1 }]);
    await withIdentity(fixture.alice, () => dispositions.change(fixture.reviewId, item.id, { version: 3, status: "Pending" }));
    expect((await overview()).adoptionRate).toBeNull();
    expect((await overview()).dismissalReasons.every((reason) => reason.count === 0)).toBe(true);
  });

  it("被驳回规范按次数取前五并使用评审快照名称", async () => {
    const ruleIds = Array.from({ length: 6 }, () => `managed:${randomUUID()}`);
    await withIdentity(fixture.alice, () => fixture.pool.query("UPDATE reviews SET rules=$1", [JSON.stringify(ruleIds.map((id) => ({ id, name: id === ruleIds[0] ? "库存释放约定" : id, body: "规范正文", file: { kind: "database" } })))]));
    const first = ruleIds.slice(0, 5).map((ruleId) => finding({ ruleId }));
    const second = [ruleIds[0]!, ruleIds[0]!, ruleIds[5]!].map((ruleId) => finding({ ruleId }));
    await insert(fixture.reviewId, first); await insert(fixture.secondReviewId, second);
    await withIdentity(fixture.alice, async () => {
      for (const [reviewId, items] of [[fixture.reviewId, first], [fixture.secondReviewId, second]] as const) {
        for (const item of items) await dispositions.change(reviewId, item.id, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
      }
    });
    const result = await overview();
    expect(result.mostDismissedRules).toHaveLength(5);
    expect(result.mostDismissedRules[0]).toEqual({ id: ruleIds[0], name: "库存释放约定", repositoryId: null, repositoryName: null, count: 3 });
    expect(result.dismissalReasons.find((reason) => reason.category === "rule_not_applicable")?.count).toBe(8);
  });

  it("同路径 Git 规范按仓库分别统计", async () => {
    const repositoryId = randomUUID();
    await withIdentity(fixture.alice, async () => {
      await fixture.pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
        VALUES($1,'https://gitlab.example.test',3,'支付','team/payment','https://gitlab.example.test/team/payment','https://gitlab.example.test/team/payment.git',$2)`, [repositoryId, Buffer.from("fixture")]);
      await fixture.pool.query("UPDATE reviews SET repository_id=$1 WHERE id=$2", [repositoryId, fixture.secondReviewId]);
    });
    for (const id of [fixture.reviewId, fixture.secondReviewId]) {
      const item = finding({ ruleId: "repository:.agents/rules/idempotency.md" }); await insert(id, [item]);
      await withIdentity(fixture.alice, () => dispositions.change(id, item.id, { version: 0, status: "Dismissed", reasonCategory: "other", explanation: "本轮允许重入" }));
    }
    const result = await overview();
    expect(result.mostDismissedRules).toHaveLength(2);
    expect(new Set(result.mostDismissedRules.map((rule) => rule.repositoryName))).toEqual(new Set(["库存", "支付"]));
    expect(result.mostDismissedRules.map((rule) => rule.count)).toEqual([1, 1]);
  });

  it("负责人接口要求管理员且其他团队没有当前团队数据", async () => {
    const own = await fixture.app.inject({ url: "/api/team-overview" });
    expect(own.statusCode).toBe(200); expect(own.headers["cache-control"]).toBe("no-store");
    expect((await fixture.app.inject({ url: "/api/team-overview", headers: { "x-fixture-user": "bob" } })).statusCode).toBe(403);
    const other = await fixture.app.inject({ url: "/api/team-overview", headers: { "x-fixture-user": "outsider" } });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ reviewRounds: 0, findings: { high: 0, medium: 0, resolved: 0, dismissed: 0 }, totals: { repositories: 0, pullRequests: 0 } });
    await expect(service.get()).rejects.toMatchObject({ statusCode: 401 });
  });
});
