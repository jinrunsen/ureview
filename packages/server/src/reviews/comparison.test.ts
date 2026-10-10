import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureRepository, IdentityScenario } from "../auth/test-support.js";
import { withTeam } from "../db/tenant.js";
import { makeMockFileGroups } from "../runtime/test-support.js";
import { createCodeAnchor, createCodeFingerprint } from "./anchors.js";
import { compareReviewRounds } from "./comparison.js";
import { ReviewStore } from "./store.js";
import type { ReviewDetail, ReviewFinding } from "./types.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  const result: ReviewFinding = {
    id: randomUUID(), title: "库存扣减缺少下限检查", description: "库存可以扣减到负数", severity: "medium",
    location: { path: "src/inventory.ts", startLine: 2, endLine: 2 }, evidence: [], fixPrompt: "扣减前检查库存余量",
    ruleId: null, generatedAt: "2026-10-06T00:00:00.000Z", code: "stock -= amount;", score: 90,
    generatorModel: { provider: "generator", model: "generator", vendor: "generator" },
    graderModel: { provider: "grader", model: "grader", vendor: "grader" }, readFiles: [], status: "Pending", ...overrides,
  };
  return { ...result, fingerprint: result.fingerprint ?? createCodeFingerprint(result.code), anchor: createCodeAnchor(result, result.code) };
}

describe("多轮 finding 匹配", () => {
  it("首轮的每条 finding 都标记新出现", () => {
    const result = compareReviewRounds([finding()], null);
    expect(result.findings[0]?.comparison).toEqual({ kind: "new", previousFinding: null });
    expect(result.comparison).toEqual({ previousReview: null, absentFindings: [] });
  });

  it("同文件同指纹不受行号或标题变化影响，保留本轮代码锚", () => {
    const previous = finding();
    const current = finding({ title: "未校验库存", location: { ...previous.location, startLine: 12, endLine: 12 } });
    const result = compareReviewRounds([current], { id: "previous", round: 1, findings: [previous] });
    expect(result.findings[0]).toMatchObject({ anchor: { path: "src/inventory.ts", startLine: 12, endLine: 12, side: "new" }, comparison: { kind: "recurring", previousFinding: { findingId: previous.id } } });
    expect(result.comparison.absentFindings).toEqual([]);
  });

  it("片段变化时同文件同规范同标题仍可匹配，上一轮处置只作参考", () => {
    const previous = finding({ ruleId: "inventory-boundary", status: "Dismissed", disposition: {
      status: "Dismissed", version: 1, actor: { id: "reviewer", name: "张伟" }, updatedAt: "2026-10-06T01:00:00.000Z",
      reasonCategory: "rule_not_applicable", explanation: "预占库存允许负数",
    } });
    const current = finding({ ruleId: previous.ruleId, code: "stock = stock - amount;" });
    const result = compareReviewRounds([current], { id: "previous", round: 2, findings: [previous] });
    expect(result.findings[0]).toMatchObject({ status: "Pending", comparison: { kind: "recurring", previousFinding: {
      reviewId: "previous", round: 2, status: "Dismissed", disposition: previous.disposition,
    } } });
    expect(result.findings[0]?.disposition).toBeUndefined();
  });

  it("不同文件、不同规范及无规范的同名不同片段保持为新出现", () => {
    const previous = finding({ ruleId: "inventory-boundary" });
    const current = [
      finding({ location: { ...previous.location, path: "src/reservation.ts" } }),
      finding({ ruleId: "other-rule", code: "stock -= reserved;" }),
      finding({ code: "stock -= ordered;" }),
    ];
    const result = compareReviewRounds(current, { id: "previous", round: 1, findings: [previous, finding({ code: "stock -= cancelled;" })] });
    expect(result.findings.map((item) => item.comparison?.kind)).toEqual(["new", "new", "new"]);
    expect(result.comparison.absentFindings).toHaveLength(2);
  });

  it("匹配遍历折叠 finding，未再出现列表保持上一轮展示范围", () => {
    const previous = Array.from({ length: 7 }, (_, index) => finding({ code: `stock -= ${index};`, score: 99 - index }));
    const current = [finding({ code: previous[6]!.code }), ...Array.from({ length: 5 }, (_, index) => finding({ code: `newStock += ${index};` }))];
    const result = compareReviewRounds(current, { id: "previous", round: 1, findings: previous });
    expect(result.findings[0]?.comparison?.kind).toBe("recurring");
    expect(result.comparison.absentFindings).toHaveLength(5);
    expect(result.comparison.absentFindings.map((item) => item.id)).not.toContain(previous[5]!.id);
    const currentFolded = compareReviewRounds([...current, finding({ code: previous[0]!.code, score: 1 })], { id: "previous", round: 1, findings: previous });
    expect(currentFolded.comparison.absentFindings.map((item) => item.id)).not.toContain(previous[0]!.id);
  });

  it("同片段有多条历史 finding 时优先引用相同规范及标题的处置", () => {
    const first = finding({ id: "a", title: "另一问题", ruleId: "other-rule" });
    const preferred = finding({ id: "b", ruleId: "inventory-boundary" });
    const result = compareReviewRounds([finding({ ruleId: "inventory-boundary" })], { id: "previous", round: 1, findings: [first, preferred] });
    expect(result.findings[0]?.comparison?.previousFinding?.findingId).toBe(preferred.id);
    expect(result.comparison.absentFindings).toEqual([]);
  });
});

let scenario: IdentityScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });

describe("多轮对比持久化", () => {
  it("详情读取最近较小的完成轮次、重启后保留中危指纹并为旧中危补锚，处置参考遵循团队隔离", async () => {
    scenario = new IdentityScenario();
    await scenario.start();
    const session = await scenario.setup();
    const current = scenario;
    const connected = await current.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    expect(connected.status).toBe(201);
    const store = new ReviewStore(current.pool);
    const teamId = session.user!.teamId;
    async function round(findings: ReviewFinding[], options: { iid?: number; status?: "failed" | "queued" } = {}) {
      return withTeam(teamId, async () => {
        const queued = await store.enqueue(connected.body.repository.id, randomUUID(), {
          projectId: 42, iid: options.iid ?? 7, headSha: randomUUID(), title: "校验库存扣减", author: "author",
        }, "manual");
        if (!queued) throw new Error("未创建评审");
        if (options.status === "failed") await store.fail(queued.id, "模型未完成");
        else if (options.status !== "queued") await store.complete(queued.id, { findings, readFiles: [], fileGroups: makeMockFileGroups() });
        return queued.id;
      });
    }
    await round([finding({ code: "oldStock -= amount;" })]);
    const recurring = finding({ fingerprint: "invalid-fingerprint" });
    const absent = finding({ title: "缺少审计记录", code: "stock = 0;" });
    const previousId = await round([recurring, absent]);
    const rejected = await current.request(`/api/reviews/${previousId}/findings/${recurring.id}/disposition`, {
      status: "Dismissed", version: 0, reasonCategory: "other", explanation: "库存预占允许负数",
    }, { method: "PATCH" });
    expect(rejected.status).toBe(200);
    await round([], { status: "failed" });
    const pendingId = await round([], { status: "queued" });
    // 中危挂锚之前保存的 finding 没有锚。
    const next: ReviewFinding = { ...finding(), anchor: null };
    const currentId = await round([next]);
    await round([finding({ code: "unrelated -= amount;" })], { iid: 8 });
    const laterId = await round([finding({ code: "futureStock -= amount;" })]);
    const restarted = new ReviewStore(current.pool);
    const detail = await withTeam(teamId, () => restarted.get(currentId));
    expect(detail?.comparison).toMatchObject({ previousReview: { id: previousId, round: 2 }, absentFindings: [{ id: absent.id }] });
    expect(detail?.findings[0]).toMatchObject({ status: "Pending", fingerprint: createCodeFingerprint(next.code),
      anchor: { ...next.location, side: "new", fingerprint: createCodeFingerprint(next.code) }, comparison: {
      kind: "recurring", previousFinding: { reviewId: previousId, round: 2, findingId: recurring.id, status: "Dismissed", disposition: {
        actor: { id: session.user!.userId, name: "张伟" }, reasonCategory: "other", explanation: "库存预占允许负数",
      } },
    } });
    const stored = await withTeam(teamId, () => current.pool.query<{ payload: ReviewFinding }>("SELECT payload FROM review_findings WHERE id=$1", [recurring.id]));
    expect(stored.rows[0]?.payload.fingerprint).toBe(createCodeFingerprint(recurring.code));
    expect((await withTeam(teamId, () => restarted.get(laterId)))?.comparison.previousReview?.id).toBe(currentId);
    expect((await withTeam(teamId, () => restarted.get(pendingId)))?.comparison).toEqual({ previousReview: null, absentFindings: [] });
    const outsiderTeam = (await current.request<{ id: string }>("/api/admin/teams", { name: "另一团队" })).body.id;
    expect(await withTeam(outsiderTeam, () => restarted.get(currentId))).toBeNull();
    expect((await current.request("/api/auth/team", { teamId: outsiderTeam })).status).toBe(200);
    expect((await current.request<{ review: ReviewDetail }>(`/api/reviews/${currentId}`)).status).toBe(404);
  });
});
