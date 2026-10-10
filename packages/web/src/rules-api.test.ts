import { afterEach, describe, expect, it, vi } from "vitest";
import { getRules } from "./rules-api";
import { getRuleMetadata } from "./rule-metadata";
import { getRuleWaivers, saveManagedRule, setRuleWaiver, type ManagedRuleInput } from "./managed-rules-api";

const managedRule = {
  id: "stock-lock", version: 1, name: "库存释放锁", body: "释放前须持有订单锁", goodExample: "withLock(release)", badExample: "release()",
  category: "reliability", severity: "error", scope: "global", repositories: [], status: "active",
  judgement: false, layer: "team", languages: ["typescript"], overrides: [], waivers: [],
  createdAt: "2026-10-06T08:00:00Z", updatedAt: "2026-10-06T08:00:00Z", createdBy: "member-one", updatedBy: "member-one",
};
function respond(rule: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ rules: [], lints: [], managedRules: [rule], sync: [] })));
}
afterEach(() => vi.restoreAllMocks());

describe("工作台规范目录的处置计数", () => {
  it("读取不含作者身份排除项的挖掘摘要", async () => {
    const summary = { scanned: 347, skippedNoAdoption: 12 };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ rules: [], lints: [], managedRules: [],
      sync: [{ repositoryId: "payment", syncedAt: null, syncError: null, warnings: [],
        minedAt: "2026-10-06T08:00:00Z", miningError: null, miningSummary: summary }] })));
    expect((await getRules()).sync[0]?.miningSummary).toEqual(summary);
  });

  it("保留目录返回的命中、采纳与被无视计数", async () => {
    const counts = { hits: 4, adopted: 2, ignored: 0 };
    const fetch = respond({ ...managedRule, counts });
    expect((await getRules("repository-one")).managedRules[0]?.counts).toEqual(counts);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rules?repositoryId=repository-one");
  });
  it("兼容尚未附带统计的规范记录", async () => {
    respond(managedRule);
    expect((await getRules()).managedRules[0]?.counts).toBeUndefined();
  });
  it.each([{ hits: 2, adopted: -1, ignored: 0 }, { hits: 2, adopted: "1", ignored: 0 }, { hits: 2, adopted: 1 }])("拒绝无效计数：%j", async (counts) => {
    respond({ ...managedRule, counts });
    await expect(getRules()).rejects.toThrow(/数据不完整/);
  });
});

describe("规范层级、语言与效力的接口", () => {
  it("读取服务端的语言选项与层级顺序", async () => {
    const metadata = { layers: ["principle", "general", "language", "team"], languages: [{ id: "c", label: "C" }, { id: "sql", label: "SQL" }] };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(metadata)));
    expect(await getRuleMetadata()).toEqual(metadata);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rule-metadata");
  });
  it("同时读取 Git 与工作台规范的层级和覆盖关系", async () => {
    const gitRule = { id: "repository:.agents/rules/sql.md", name: "SQL 查询", body: "限制查询规模", judgement: true, layer: "language", languages: ["sql"], overrides: [],
      scope: "repository", inherited: false, paths: ["**/*.sql"], lazy: false, enabled: true, source: { kind: "manual" },
      file: { repositoryId: "repo-one", repositoryName: "team/service", path: ".agents/rules/sql.md", commitSha: "abc", url: "https://git.example/sql.md" }, counts: { hits: 0, adopted: 0, ignored: 0 } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ rules: [gitRule], managedRules: [{ ...managedRule, overrides: [gitRule.id] }], lints: [], sync: [] })));
    const catalog = await getRules();
    expect(catalog.rules[0]).toEqual(gitRule);
    expect(catalog.managedRules[0]?.overrides).toEqual([gitRule.id]);
  });
  it.each([{ layer: "unknown" }, { judgement: "true" }, { judgement: null }, { languages: [42] }, { overrides: "managed:rule" }, { waivers: [{ repositoryId: "repo-one", reason: "理由" }] }])("拒绝格式不完整的效力字段：%j", async (change) => {
    respond({ ...managedRule, ...change });
    await expect(getRules()).rejects.toThrow(/数据不完整/);
  });
  it("保存编辑稿时提交层级、语言、判断题属性和覆盖目标", async () => {
    const input: ManagedRuleInput = { name: "团队查询", body: "查询必须限制行数", goodExample: "", badExample: "", category: "performance", severity: "warning",
      judgement: true, layer: "team", languages: ["sql"], overrides: ["repository:.agents/rules/sql.md"], scope: "global", repositories: [], status: "active" };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ rule: { ...managedRule, ...input } })));
    expect((await saveManagedRule(input, undefined, new AbortController().signal)).rule.overrides).toEqual(input.overrides);
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  });
  it("设置与撤销豁免使用指定仓库，并保留操作记录", async () => {
    const waiver = { repositoryId: "repo-one", reason: "历史数据迁移期间保留兼容路径", createdBy: "member-one", createdAt: "2026-10-06T08:00:00Z", revokedBy: null, revokedAt: null };
    const revoked = { ...waiver, revokedBy: "member-two", revokedAt: "2026-10-06T09:00:00Z" };
    const fetch = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ rule: { ...managedRule, waivers: [waiver] } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ rule: managedRule })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ waivers: [revoked] })));
    expect((await setRuleWaiver(managedRule.id, waiver.repositoryId, waiver.reason)).rule.waivers).toEqual([waiver]);
    expect((await setRuleWaiver(managedRule.id, waiver.repositoryId)).rule.waivers).toEqual([]);
    expect((await getRuleWaivers(managedRule.id)).waivers).toEqual([revoked]);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/managed-rules/stock-lock/waivers/repo-one");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ reason: waiver.reason });
    expect(fetch.mock.calls[1]?.[1]?.method).toBe("DELETE");
  });
});
