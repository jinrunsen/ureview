import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCollaborationFixture } from "../collaboration/test-support.js";
import { withIdentity } from "../auth/context.js";
import { withTeam } from "../db/tenant.js";
import { registerDispositionRoutes } from "./disposition-http.js";
import { dismissalReasons, FindingDispositionService, loadFindingDispositions } from "./dispositions.js";
import type { ReviewFinding } from "./types.js";

let fixture: Awaited<ReturnType<typeof createCollaborationFixture>>;
let service: FindingDispositionService;
const finding = (id: string, score = 90): ReviewFinding => ({
  id, title: "订单重复恢复库存", description: "库存恢复需要幂等", severity: "medium", code: "restore(order)",
  location: { path: "src/order.ts", startLine: 1, endLine: 1 }, evidence: [], fixPrompt: "按订单去重",
  ruleId: null, generatedAt: new Date().toISOString(), score, status: "Pending", anchor: null,
  generatorModel: { provider: "fixture", model: "generator", vendor: "fixture-a" },
  graderModel: { provider: "fixture", model: "grader", vendor: "fixture-b" }, readFiles: [],
});
beforeEach(async () => {
  fixture = await createCollaborationFixture();
  service = new FindingDispositionService(fixture.pool);
  registerDispositionRoutes(fixture.app, fixture.pool);
  await withIdentity(fixture.alice, () => fixture.pool.query("UPDATE review_findings SET payload=$2 WHERE id=$1", [fixture.findingId, JSON.stringify(finding(fixture.findingId))]));
});
afterEach(async () => { await fixture?.close(); });
const route = () => `/api/reviews/${fixture.reviewId}/findings/${fixture.findingId}/disposition`;

describe("团队 finding 处置", () => {
  it("真实成员采纳、驳回和撤回保留有序审计及服务器时间", async () => {
    // 审计与时间界限共用 PostgreSQL 时钟，避免数据库与宿主时钟偏移。
    const started = (await fixture.pool.query<{ time: Date }>("SELECT clock_timestamp() AS time")).rows[0]!.time.getTime();
    const accept = await fixture.app.inject({ method: "PATCH", url: route(), payload: { version: 0, status: "Resolved" } });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().finding.disposition).toMatchObject({ version: 1, actor: { id: fixture.alice.userId, name: "张伟" } });
    const dismiss = await fixture.app.inject({ method: "PATCH", url: route(), headers: { "x-fixture-user": "bob" }, payload: { version: 1, status: "Dismissed", reasonCategory: "false_positive", explanation: " 已有幂等保护 " } });
    expect(dismiss.statusCode).toBe(200);
    expect(dismiss.json().finding.disposition.explanation).toBe("已有幂等保护");
    const revert = await fixture.app.inject({ method: "PATCH", url: route(), payload: { version: 2, status: "Pending" } });
    expect(revert.statusCode).toBe(200);
    const finished = (await fixture.pool.query<{ time: Date }>("SELECT clock_timestamp() AS time")).rows[0]!.time.getTime();
    const history = await withIdentity(fixture.alice, () => service.history(fixture.reviewId, fixture.findingId));
    expect(history.events.map((event) => [event.previousStatus, event.status, event.version])).toEqual([
      ["Pending", "Resolved", 1], ["Resolved", "Dismissed", 2], ["Dismissed", "Pending", 3],
    ]);
    expect(history.events[1]?.actor.id).toBe(fixture.bob.userId);
    expect(history.events[2]?.reasonCategory).toBeNull();
    for (const event of history.events) {
      expect(Date.parse(event.createdAt)).toBeGreaterThanOrEqual(started);
      expect(Date.parse(event.createdAt)).toBeLessThanOrEqual(finished);
    }
    const persisted = await withIdentity(fixture.alice, () => loadFindingDispositions(fixture.pool, fixture.reviewId));
    expect(persisted.get(fixture.findingId)).toMatchObject({ status: "Pending", version: 3 });
  });

  it("五类驳回理由有效，其他说明必填，禁止伪造归属和系统状态", async () => {
    for (const payload of [
      { version: 0, status: "Dismissed" }, { version: 0, status: "Dismissed", reasonCategory: "other", explanation: "   " },
      { version: 0, status: "Ignored" }, { version: 0, status: "Outdated" }, { version: 0, status: ["Resolved"] },
      { version: 0, status: "Resolved", actor: fixture.bob.userId }, { version: 0, status: "Resolved", explanation: "理由" },
      { version: -1, status: "Resolved" }, { version: 2_147_483_647, status: "Resolved" },
    ]) expect((await fixture.app.inject({ method: "PATCH", url: route(), payload })).statusCode).toBe(400);
    for (const [version, reasonCategory] of dismissalReasons.entries()) {
      const response = await fixture.app.inject({ method: "PATCH", url: route(), payload: { version, status: "Dismissed", reasonCategory, ...(reasonCategory === "other" ? { explanation: "本轮暂缓" } : {}) } });
      expect(response.statusCode).toBe(200);
    }
  });

  it("同版本并发只有一次变更，相同内容重复提交不生成审计", async () => {
    const responses = await Promise.all(["Resolved", "Dismissed"].map((status) => fixture.app.inject({ method: "PATCH", url: route(), payload: { version: 0, status, ...(status === "Dismissed" ? { reasonCategory: "false_positive" } : {}) } })));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const current = responses.find((response) => response.statusCode === 200)!.json().finding;
    const repeat = await fixture.app.inject({ method: "PATCH", url: route(), payload: { version: 1, status: current.status, ...(current.status === "Dismissed" ? { reasonCategory: "false_positive" } : {}) } });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json().finding.disposition.version).toBe(1);
    expect((await withIdentity(fixture.alice, () => service.history(fixture.reviewId, fixture.findingId))).events).toHaveLength(1);
  });

  it("最后展示项完成时只给该操作者看完，折叠项不阻塞且不能直接处置", async () => {
    const ids = Array.from({ length: 5 }, () => randomUUID());
    await withIdentity(fixture.alice, async () => {
      for (const [index, id] of ids.entries()) await fixture.pool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,$3)", [id, fixture.reviewId, JSON.stringify(finding(id, 80 - index))]);
      for (const id of [fixture.findingId, ...ids.slice(0, 3)]) await service.change(fixture.reviewId, id, { version: 0, status: "Resolved" });
      expect((await fixture.service.participation(fixture.reviewId)).participants).toEqual([]);
    });
    await withIdentity(fixture.bob, async () => {
      await service.change(fixture.reviewId, ids[3]!, { version: 0, status: "Dismissed", reasonCategory: "rule_not_applicable" });
      const result = await fixture.service.participation(fixture.reviewId);
      expect(result.participants).toHaveLength(1);
      expect(result.participants[0]).toMatchObject({ userId: fixture.bob.userId });
      expect(result.participants[0]?.completedAt).toBeTruthy();
      await expect(service.change(fixture.reviewId, ids[4]!, { version: 0, status: "Resolved" })).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  it("无团队和其他团队读不到审计，也无法写入当前团队 finding", async () => {
    await withIdentity(fixture.alice, () => service.change(fixture.reviewId, fixture.findingId, { version: 0, status: "Resolved" }));
    expect((await fixture.pool.query("SELECT * FROM finding_disposition_events")).rows).toEqual([]);
    await withIdentity(fixture.outsider, async () => {
      expect((await fixture.pool.query("SELECT * FROM finding_disposition_events")).rows).toEqual([]);
      await expect(service.change(fixture.reviewId, fixture.findingId, { version: 1, status: "Pending" })).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.history(fixture.reviewId, fixture.findingId)).rejects.toMatchObject({ statusCode: 404 });
      await expect(fixture.pool.query(`INSERT INTO finding_disposition_events(id,review_id,finding_id,actor_id,actor_name,previous_status,status,version)
        VALUES($1,$2,$3,$4,'其他团队','Pending','Resolved',2)`, [randomUUID(), fixture.reviewId, fixture.findingId, fixture.outsider.userId])).rejects.toThrow();
    });
    expect((await fixture.app.inject({ method: "PATCH", url: route(), headers: { "x-fixture-user": "outsider" }, payload: { version: 1, status: "Pending" } })).statusCode).toBe(404);
  });

  it("看完写入失败时处置和审计全部回滚", async () => {
    await fixture.pool.query(`CREATE FUNCTION reject_participant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture'; END $$;
      CREATE TRIGGER reject_participant BEFORE INSERT ON review_participants FOR EACH ROW EXECUTE FUNCTION reject_participant()`);
    await withIdentity(fixture.alice, async () => {
      await expect(service.change(fixture.reviewId, fixture.findingId, { version: 0, status: "Resolved" })).rejects.toThrow();
      expect((await service.history(fixture.reviewId, fixture.findingId)).events).toEqual([]);
      expect((await loadFindingDispositions(fixture.pool, fixture.reviewId)).get(fixture.findingId)).toMatchObject({ status: "Pending", version: 0 });
    });
  });

  it("未完成轮次和失效 finding 不接受人工处置", async () => {
    await withTeam(fixture.alice.teamId, () => fixture.pool.query("UPDATE reviews SET status='running' WHERE id=$1", [fixture.reviewId]));
    expect((await fixture.app.inject({ method: "PATCH", url: route(), payload: { version: 0, status: "Resolved" } })).statusCode).toBe(409);
    await withTeam(fixture.alice.teamId, async () => {
      await fixture.pool.query("UPDATE reviews SET status='completed' WHERE id=$1", [fixture.reviewId]);
      await fixture.pool.query("UPDATE review_findings SET status='Outdated' WHERE id=$1", [fixture.findingId]);
    });
    expect((await fixture.app.inject({ method: "PATCH", url: route(), payload: { version: 0, status: "Resolved" } })).statusCode).toBe(409);
  });
});
