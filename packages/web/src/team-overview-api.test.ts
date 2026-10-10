import { afterEach, describe, expect, it, vi } from "vitest";
import { getTeamOverview, type TeamOverview } from "./team-overview-api";

const overview: TeamOverview = {
  period: { from: "2026-09-08T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
  totals: { repositories: 1, pullRequests: 5, completed: 3, queued: 1, running: 1 },
  reviewRounds: 8, findings: { high: 3, medium: 7, resolved: 2, dismissed: 2 }, adoptionRate: 0.5,
  dismissalReasons: [{ category: "false_positive", count: 1 }, { category: "rule_not_applicable", count: 1 }, { category: "rule_incorrect", count: 0 }, { category: "not_worth_fixing", count: 0 }, { category: "other", count: 0 }],
  mostDismissedRules: [{ id: "managed:inventory-lock", name: "库存释放约定", repositoryId: null, repositoryName: null, count: 1 }],
};
afterEach(() => vi.restoreAllMocks());
describe("团队概览读取", () => {
  it("读取统计并保留空采纳率", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(overview)));
    const controller = new AbortController();
    expect(await getTeamOverview(controller.signal)).toEqual(overview);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/team-overview");
    expect(fetch.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...overview, adoptionRate: null })));
    expect((await getTeamOverview()).adoptionRate).toBeNull();
  });
  it("拒绝无效计数、比例和理由分类", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    for (const patch of [{ reviewRounds: -1 }, { adoptionRate: 2 }, { dismissalReasons: Array.from({ length: 5 }, () => overview.dismissalReasons[0]) }, { period: { from: "invalid", to: overview.period.to } }]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ...overview, ...patch })));
      await expect(getTeamOverview()).rejects.toThrow("数据不完整");
    }
  });
});
