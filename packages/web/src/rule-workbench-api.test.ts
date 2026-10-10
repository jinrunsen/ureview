import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { RuleLibrary } from "./rule-library";
import { applyRuleLibrary, getRuleLibrary, getRuleLibraryEntries } from "./rule-library-api";
import { getRuleDetail, reviewRuleDetailUrl, ruleDetailUrl } from "./rule-detail-api";
import type { ReviewRule } from "./review-api";
import { getRuleProposals, reviewRuleProposal } from "./rule-proposals-api";
import { getRules } from "./rules-api";
import type { ManagedRule } from "./managed-rules-api";

const managed: ManagedRule = { id: "money-cents", version: 3, name: "金额使用整数分", body: "金额以整数分存储和计算", goodExample: "", badExample: "",
  category: "correctness", severity: "warning", judgement: false, layer: "team", languages: [], overrides: [], waivers: [], scope: "global", repositories: [], status: "active",
  createdAt: "2026-10-06T08:00:00Z", updatedAt: "2026-10-06T08:00:00Z", createdBy: "admin-one", updatedBy: "admin-one",
  librarySource: { setId: "money", entryId: "money-cents", version: "2026.10", body: "金额使用整数分" } };
const proposal = { id: "proposal-one", source: "feedback", status: "pending", name: managed.name, body: managed.body, managedRuleId: managed.id, ruleId: `managed:${managed.id}`, repositoryId: "repo-one", reasonCategory: "rule_incorrect", feedbackCount: 2,
  feedback: [{ findingId: "finding-one", reviewId: "review-one", title: "费率使用了浮点数", explanation: "费率不是货币金额", createdAt: "2026-10-06T08:10:00Z" }], candidate: null, createdAt: "2026-10-06T08:10:00Z", reviewedAt: null, reviewedBy: null, rejectionReason: null };
const librarySet = { id: "money", name: "金额约定", layer: "general", languages: [], libraryVersion: "2026.11", sources: [{ id: "source-one", title: "金额领域约定", author: "示例团队", url: "https://example.com/money", license: "MIT" }], inclusionReasons: [{ kind: "adoption", explanation: "团队使用" }], license: { tier: "open", attribution: "示例团队", notice: "自写要点" }, entries: [{ id: managed.id, title: managed.name, originalName: "Integer Money（整数货币）", summary: "金额用浮点表示 → 改用整数分", body: managed.body, check: "检查金额变量类型", why: "避免浮点舍入误差", fix: "改用整数分", goodExample: "const cents = 100;", badExample: "const amount = 0.1 + 0.2;", exampleLanguage: "javascript", category: "correctness", severity: "warning", judgement: false, source: { sourceId: "source-one", reference: "金额" }, appliedRuleId: managed.id, appliedVersion: "2026.10", hasUpdate: true }] };
const { entries: libraryEntries, ...libraryMetadata } = librarySet;
const librarySummary = { ...libraryMetadata, entryCount: libraryEntries.length, appliedCount: 1 };
const detail = { rule: { id: `managed:${managed.id}`, name: managed.name, body: managed.body, goodExample: "", badExample: "", judgement: false, layer: "team", languages: [], overrides: [], overriddenBy: [], scope: "global", repositories: [], waivers: [], source: { kind: "library", setId: "money", entryId: managed.id, setName: "金额约定", sourceFilename: "金额领域约定", libraryVersion: "2026.10" }, version: 3, status: "active", managedRule: managed }, summary: { hits: 2, adopted: 1, dismissed: 1, ignored: 0, dismissalReasons: { rule_incorrect: 1 } }, records: [{ reviewId: "review-one", repositoryId: "repo-one", repositoryName: "commerce/payments", iid: 17, title: "增加费率计算", round: 2, completedAt: "2026-10-06T08:00:00Z", pullRequestUrl: "https://example.com/pr/17", findingId: "finding-one", findingTitle: "费率使用了浮点数", severity: "medium", status: "Dismissed", ruleVersion: 2, disposition: { version: 1, actor: { id: "member-one", name: "陈敏" }, updatedAt: "2026-10-06T08:10:00Z", reasonCategory: "rule_incorrect", explanation: "费率不是货币金额" } }] };
function response(value: unknown) { return new Response(JSON.stringify(value)); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("规范库的浏览与应用", () => {
  it.each(["originalName", "summary", "check", "why", "fix", "goodExample", "badExample", "exampleLanguage", "judgement"])("拒绝缺少 %s 的条目", async (field) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ entries: [{ ...libraryEntries[0], [field]: undefined }] }));
    await expect(getRuleLibraryEntries("money")).rejects.toThrow("数据不完整");
  });
  it("筛选库时保留出处、许可与应用记录", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ sets: [librarySummary] }));
    expect((await getRuleLibrary("general", "go")).sets[0]).toEqual(librarySummary);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rule-library?layer=general&language=go");
  });
  it("按条或整套应用，保留规范库关联", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ rules: [managed], created: 1 }));
    expect((await applyRuleLibrary("money", [managed.id])).rules[0]).toMatchObject({ status: "active", librarySource: { entryId: managed.id } });
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST"); expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ entryIds: [managed.id] });
    await applyRuleLibrary("money"); expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({});
  });
  it("重复应用接受零新增并保留已有规则", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ rules: [managed], created: 0 }));
    const result = await applyRuleLibrary("money", [managed.id]);
    expect(result).toEqual({ rules: [managed], created: 0 });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rule-library/money/apply");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ entryIds: [managed.id] });
  });
  it("已应用条目仍可重复整套或按条应用，显示跳过结果与规范入口", async () => {
    const { document, window } = parseHTML("<!doctype html><html><body><main></main></body></html>");
    vi.stubGlobal("window", window); vi.stubGlobal("document", document); vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => response(init?.method === "POST" ? { rules: [managed], created: 0 } : String(url).endsWith("/entries") ? { entries: libraryEntries } : { sets: [librarySummary] }));
    const container = document.querySelector("main")!; const root = createRoot(container); const onChanged = vi.fn();
    try {
      await act(async () => { root.render(createElement(RuleLibrary, { canManage: true, onChanged })); });
      expect(container.querySelector(".library-entry")).toBeNull();
      const entries = container.querySelector<HTMLDetailsElement>(".library-entries")!;
      await act(async () => { entries.open = true; entries.dispatchEvent(new window.Event("toggle")); });
      expect(container.querySelector('input[aria-label="选择 金额使用整数分"]')?.hasAttribute("disabled")).toBe(false);
      expect(container.querySelector(".library-entry pre")).toBeNull();
      expect(container.textContent).not.toContain("规范库有更新");
      expect(container.querySelector('a[href*="proposals"]')).toBeNull();
      for (let attempt = 0; attempt < 2; attempt++) {
        const button = container.querySelector<HTMLButtonElement>(".library-card-actions button")!;
        expect(button.disabled).toBe(false);
        await act(async () => { button.click(); });
        expect(container.querySelector('[role="status"]')?.textContent).toContain("已创建并启用 0 条规则，已存在的 1 条已跳过。");
      }
      const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="选择 金额使用整数分"]')!;
      await act(async () => { checkbox.checked = true; checkbox.dispatchEvent(new window.Event("click", { bubbles: true })); });
      const selectedButton = container.querySelector<HTMLButtonElement>(".library-selection button")!;
      expect(selectedButton.disabled).toBe(false);
      await act(async () => { selectedButton.click(); });
      const applications = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
      expect(applications.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{}, {}, { entryIds: [managed.id] }]);
      expect(onChanged).toHaveBeenCalledTimes(3);
      expect(container.querySelector('[role="status"] a')?.getAttribute("href")).toBe("/?rules=1");
    } finally { await act(async () => { root.unmount(); }); }
  });
  it("拒绝缺失应用状态的库条目", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ entries: [{ ...libraryEntries[0], appliedRuleId: undefined }] }));
    await expect(getRuleLibraryEntries("money")).rejects.toThrow("数据不完整");
  });
});

describe("统一提案的审核契约", () => {
  it("读取已撤回的空反馈提案并保留系统状态", async () => {
    const withdrawn = { ...proposal, status: "withdrawn", feedbackCount: 0, feedback: [] };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ proposals: [withdrawn] }));
    expect((await getRuleProposals({ status: "withdrawn" })).proposals).toEqual([withdrawn]);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rule-proposals?status=withdrawn");
  });
  it("按仓库、状态与来源读取反馈及审核信息", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ proposals: [proposal] }));
    expect((await getRuleProposals({ repositoryId: "repo-one", status: "pending", source: "feedback" })).proposals[0]?.feedbackCount).toBe(2);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rule-proposals?repositoryId=repo-one&status=pending&source=feedback");
  });
  it("反馈采纳把修改稿与版本一起提交，拒绝附带理由", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => response({ proposal: { ...proposal, status: "accepted" }, rule: managed }));
    const rule = { name: managed.name, body: "金额以整数分计算，费率另行指定精度", goodExample: "", badExample: "", category: managed.category, severity: managed.severity, judgement: managed.judgement, layer: managed.layer, languages: managed.languages, overrides: managed.overrides, scope: managed.scope, repositories: managed.repositories, status: managed.status, version: managed.version };
    await reviewRuleProposal(proposal.id, { status: "accepted", rule });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rule-proposals/proposal-one/review"); expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ status: "accepted", rule });
    await reviewRuleProposal(proposal.id, { status: "rejected", reason: "规范已经说明例外" });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ status: "rejected", reason: "规范已经说明例外" });
  });
  it.each([{ status: "enabled" }, { feedbackCount: -1 }, { feedback: [{ findingId: "finding-one" }] }])("拒绝不完整的提案记录：%j", async (change) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ proposals: [{ ...proposal, ...change }] }));
    await expect(getRuleProposals()).rejects.toThrow("数据不完整");
  });
});

describe("规范详情与统一执行统计", () => {
  it("非 UUID 的 managed 规范仅在仓库文件快照可定位时提供详情链接", () => {
    const rule: ReviewRule = { id: "managed:payment-policy", name: "金额规范", body: "金额使用整数分。", source: { kind: "manual" }, matchedPaths: ["src/payment.ts"],
      file: { kind: "repository", repositoryId: "repo-one", repositoryName: "commerce/payments", path: ".agents/rules/payment.md", commitSha: "old-commit", url: "https://example.com/payment.md" } };
    const url = new URL(reviewRuleDetailUrl(rule)!, "http://localhost");
    expect(url.searchParams.get("rule")).toBe(rule.id);
    expect(url.searchParams.get("ruleRepository")).toBe("repo-one");
    expect(reviewRuleDetailUrl({ ...rule, file: { kind: "database", ruleId: "payment-policy", version: 1, scope: "global" } })).toBeNull();
    const id = "7b3cc36e-32d2-44bf-b7ee-7a689e9ddfda";
    expect(reviewRuleDetailUrl({ ...rule, id: `managed:${id}`, file: { kind: "database", ruleId: id, version: 1, scope: "global" } })).toBe(ruleDetailUrl(`managed:${id}`));
  });
  it("保留命中轮次、处置人与驳回分布，编码包含路径的规范 ID", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(response(detail));
    expect(await getRuleDetail("repository:.agents/rules/money.md", "repo-one")).toEqual(detail);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/rules/repository%3A.agents%2Frules%2Fmoney.md/detail?repositoryId=repo-one");
    const url = new URL(ruleDetailUrl("repository:.agents/rules/money.md", "repo-one"), "http://localhost");
    expect(url.searchParams.get("rule")).toBe("repository:.agents/rules/money.md"); expect(url.searchParams.get("ruleRepository")).toBe("repo-one");
  });
  it("目录中已不存在的 Git 规范显示为评审快照", async () => {
    const snapshot = { ...detail, rule: { ...detail.rule, managedRule: undefined, status: "snapshot", source: { kind: "git", file: { repositoryId: "repo-one", repositoryName: "commerce/payments", path: ".agents/rules/money.md", commitSha: "old-commit", url: "https://example.com/money.md" } } } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(snapshot));
    expect((await getRuleDetail("repository:.agents/rules/money.md", "repo-one")).rule.status).toBe("snapshot");
  });
  it.each([{ kind: "managed" }, { kind: "library", setId: "money", entryId: managed.id, setName: "金额约定", sourceFilename: "金额领域约定", libraryVersion: "2026.10" }])("已删除工作台规范保留评审快照与来源：%j", async (source) => {
    const snapshot = { ...detail, rule: { ...detail.rule, managedRule: undefined, status: "snapshot", source } };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(snapshot));
    const result = await getRuleDetail(`managed:${managed.id}`);
    expect(result.rule.status).toBe("snapshot"); expect(result.rule.source).toEqual(source);
    expect(result.rule.managedRule).toBeUndefined(); expect(result.records).toEqual(detail.records);
  });
  it("目录保留工作台规范驳回数与规范库来源", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ rules: [], managedRules: [{ ...managed, counts: { hits: 2, adopted: 1, dismissed: 1, ignored: 0 } }], lints: [], sync: [] }));
    const catalog = await getRules(); expect(catalog.managedRules[0]?.counts?.dismissed).toBe(1); expect(catalog.managedRules[0]?.librarySource).toEqual(managed.librarySource);
  });
  it.each([{ ...detail, summary: { ...detail.summary, dismissed: -1 } }, { ...detail, records: [{ ...detail.records[0], disposition: null }] }, { ...detail, rule: { ...detail.rule, source: { kind: "library" } } }])("拒绝缺失执行信息或来源的数据", async (value) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response(value)); await expect(getRuleDetail(`managed:${managed.id}`)).rejects.toThrow("数据不完整");
  });
});
