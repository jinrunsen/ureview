import { afterEach, describe, expect, it } from "vitest";
import { withTeam } from "../db/tenant.js";
import { ManagedRuleScenario } from "./managed/test-support.js";
import { loadRuleLibrary, managedRuleInput, RuleLibraryService } from "./library.js";
import type { LibrarySummary, AppliedLibrarySet, LibrarySet, LibraryUpdate } from "./library-types.js";
import type { ManagedRule } from "./managed-types.js";
import type { RuleProposal } from "./proposal-types.js";
import type { RuleDetail } from "./detail.js";

let scenario: ManagedRuleScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });
async function start(sets?: LibrarySet[]) {
  scenario = new ManagedRuleScenario();
  await scenario.start(sets ? { library: (pool) => new RuleLibraryService(pool, async () => sets) } : {});
  return scenario;
}
type Applied = { rules: ManagedRule[]; created: number };

describe("规范库浏览与应用", () => {
  it("列表只有概要和应用数，成员按集读取条目且不存在的集返回 404", async () => {
    const fixture = await start();
    const read = () => fixture.request<{ sets: LibrarySummary[] }>("/api/rule-library", undefined, { cookie: fixture.memberCookie });
    const before = await read();
    expect(before.status).toBe(200);
    expect(before.body.sets.every((set) => !Object.hasOwn(set, "entries") && set.entryCount > 0 && set.appliedCount === 0)).toBe(true);
    const set = before.body.sets.find((set) => set.id === "power-of-ten")!;
    const response = await fixture.request<{ entries: AppliedLibrarySet["entries"] }>(`/api/rule-library/${set.id}/entries`, undefined, { cookie: fixture.memberCookie });
    expect(response.status).toBe(200); expect(response.body.entries).toHaveLength(set.entryCount);
    const id = response.body.entries[0]!.id;
    await fixture.request(`/api/rule-library/${set.id}/apply`, { entryIds: [id] });
    expect((await read()).body.sets.find((item) => item.id === set.id)?.appliedCount).toBe(1);
    const after = await fixture.request<{ entries: AppliedLibrarySet["entries"] }>(`/api/rule-library/${set.id}/entries`, undefined, { cookie: fixture.memberCookie });
    expect(after.body.entries.find((entry) => entry.id === id)?.appliedRuleId).toBeTruthy();
    expect((await fixture.request("/api/rule-library/missing/entries")).status).toBe(404);
    expect((await fixture.request(`/api/rule-library/${set.id}/entries`, undefined, { cookie: "" })).status).toBe(401);
  });
  it("应用规范集和条目声明的判断题属性，直接启用规范并且不创建提案", async () => {
    const fixture = await start();
    const sets = (await fixture.readLibrary()).body.sets;
    expect(sets.find((set) => set.id === "refactoring-smells")!.entries.every((entry) => entry.judgement)).toBe(true);
    expect(sets.find((set) => set.id === "google-code-review")!.entries.find((entry) => entry.id.endsWith("needed-abstraction"))?.judgement).toBe(true);
    expect(sets.find((set) => set.id === "c-traps-and-pitfalls")!.entries.every((entry) => entry.judgement === false)).toBe(true);
    const applied = await fixture.request<Applied>("/api/rule-library/refactoring-smells/apply", { entryIds: ["refactoring-smells-feature-envy"] });
    const rule = applied.body.rules[0]!;
    expect(applied.status).toBe(200);
    expect(applied.body.created).toBe(1);
    expect(rule).toMatchObject({ judgement: true, status: "active", version: 1, librarySource: { judgement: true } });
    expect((await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals).toEqual([]);
  });

  it("仅判断题属性变化也提示库更新，展示三方属性并在明确采用后替换", async () => {
    const sets = await loadRuleLibrary(), set = sets.find((set) => set.id === "google-code-review")!;
    const entry = set.entries.find((entry) => entry.id.endsWith("module-boundary"))!;
    entry.judgement = false;
    const fixture = await start(sets);
    const applied = await fixture.request<Applied>(`/api/rule-library/${set.id}/apply`, { entryIds: [entry.id] });
    const rule = applied.body.rules[0]!;
    entry.judgement = true;
    const update = (await fixture.request<{ update: LibraryUpdate }>(`/api/managed-rules/${rule.id}/library-update`)).body.update;
    expect(update).toMatchObject({ hasUpdate: true, previousJudgement: false, currentJudgement: false, incomingJudgement: true,
      previousBody: rule.body, currentBody: rule.body, incomingBody: rule.body });
    const listed = (await fixture.readLibrary()).body.sets;
    expect(listed.find((item) => item.id === set.id)!.entries.find((item) => item.id === entry.id)?.hasUpdate).toBe(true);
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules[0]?.judgement).toBe(false);
    const adopted = await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}/library-update`, { version: rule.version });
    expect(adopted.body.rule).toMatchObject({ judgement: true, librarySource: { judgement: true } });
    expect((await fixture.request<{ update: LibraryUpdate }>(`/api/managed-rules/${rule.id}/library-update`)).body.update.hasUpdate).toBe(false);
  });

  it("按层级和语言浏览本地规范集，保留来源与许可并向成员提供只读入口", async () => {
    const fixture = await start();
    const response = await fixture.readLibrary("?layer=language&language=c", { cookie: fixture.memberCookie });
    expect(response.status).toBe(200);
    expect(response.body.sets.length).toBeGreaterThan(0);
    for (const set of response.body.sets) {
      expect(set.layer).toBe("language"); expect(set.languages).toContain("c");
      expect(set.sources[0]?.url).toMatch(/^https?:\/\//); expect(set.inclusionReasons.length).toBeGreaterThan(0);
      expect(set.license.attribution).toBeTruthy(); expect(set.entries[0]).toMatchObject({ appliedRuleId: null, hasUpdate: false });
      for (const entry of set.entries) {
        for (const field of ["originalName", "summary", "body", "check", "why", "fix", "goodExample", "badExample", "exampleLanguage"] as const) {
          expect(entry[field].trim()).not.toBe("");
        }
      }
    }
    expect((await fixture.request("/api/rule-library/power-of-ten/apply", {}, { cookie: fixture.memberCookie })).status).toBe(403);
    expect((await fixture.request("/api/rule-library?language=unknown")).status).toBe(400);
  });
  it("并发应用同一批条目仅创建一次生效规范，跨团队独立应用", async () => {
    const fixture = await start();
    const entryIds = ["power-of-ten-bounded-calls", "power-of-ten-bounded-loops"];
    const responses = await Promise.all([1, 2].map(() => fixture.request<Applied>("/api/rule-library/power-of-ten/apply", { entryIds })));
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responses.map((response) => response.body.created).sort()).toEqual([0, 2]);
    const rules = responses[0]!.body.rules;
    expect(responses[1]!.body.rules.map((rule) => rule.id)).toEqual(rules.map((rule) => rule.id));
    for (const rule of rules) expect(rule).toMatchObject({ status: "active", layer: "language", languages: ["c"], scope: "global", librarySource: { setId: "power-of-ten", version: "2026.10.4" } });
    expect((await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals).toEqual([]);
    const applied = (await fixture.readLibrary()).body.sets.flatMap((set) => set.entries).filter((entry) => entry.appliedRuleId);
    expect(applied).toHaveLength(2);
    const other = await fixture.otherTeam();
    expect((await fixture.request<Applied>("/api/rule-library/power-of-ten/apply", { entryIds }, { cookie: other.cookie })).body.created).toBe(2);
    expect((await fixture.pool.query("SELECT * FROM rule_proposals")).rowCount).toBe(0);
  });
  it.each(["active", "draft"] as const)("重复应用保留 %s 规范的团队修改、版本、库关联及提案", async (status) => {
    const sets = await loadRuleLibrary(), set = sets.find((set) => set.id === "go-guidelines")!, entry = set.entries[0]!;
    set.libraryVersion = "2026.10.0";
    const fixture = await start(sets);
    const original = status === "draft" ? await fixture.seedLegacyLibraryDraft(set.id, entry.id)
      : (await fixture.request<Applied>(`/api/rule-library/${set.id}/apply`, { entryIds: [entry.id] })).body.rules[0]!;
    const edited = await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${original.id}`, {
      ...managedRuleInput(original), name: "外部请求错误处理", body: "外部调用失败时记录订单号并停止处理。", judgement: true,
      goodExample: "if err != nil { return fmt.Errorf(\"order %s: %w\", id, err) }", badExample: "result, _ := request()",
      severity: "error", scope: "repositories", repositories: [{ repositoryId: fixture.repositoryId, paths: ["internal/orders/**"] }],
      version: original.version,
    }, { method: "PUT" });
    expect(edited.status).toBe(200);
    const proposals = (await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals;
    set.libraryVersion = "2026.10.5"; entry.body = "检查请求错误并释放资源。"; entry.judgement = false;
    const repeated = await fixture.request<Applied>(`/api/rule-library/${set.id}/apply`, { entryIds: [entry.id] });
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual({ created: 0, rules: [edited.body.rule] });
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toEqual([edited.body.rule]);
    expect((await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals).toEqual(proposals);
  });
  it("整套应用仅新增缺少的条目，重复应用整套规范保持全部记录", async () => {
    const sets = await loadRuleLibrary(), set = sets.find((set) => set.id === "go-guidelines")!;
    const fixture = await start(sets);
    const existing = (await fixture.request<Applied>(`/api/rule-library/${set.id}/apply`, { entryIds: [set.entries[0]!.id] })).body.rules[0]!;
    const applied = await fixture.request<Applied>(`/api/rule-library/${set.id}/apply`, {});
    expect(applied.status).toBe(200);
    expect(applied.body.created).toBe(set.entries.length - 1);
    expect(applied.body.rules).toHaveLength(set.entries.length);
    expect(applied.body.rules.find((rule) => rule.id === existing.id)).toEqual(existing);
    expect(applied.body.rules.every((rule) => rule.status === "active")).toBe(true);
    const repeated = await fixture.request<Applied>(`/api/rule-library/${set.id}/apply`, {});
    expect(repeated.status).toBe(200);
    expect(repeated.body).toEqual({ created: 0, rules: applied.body.rules });
    expect((await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals).toEqual([]);
  });
  it("被拒绝的规范库草稿显示未应用，重新应用创建生效规范并保留拒绝记录", async () => {
    const fixture = await start();
    const original = await fixture.seedLegacyLibraryDraft("go-guidelines", "go-guidelines-check-errors");
    const proposal = (await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals[0]!;
    const rejected = await fixture.request<{ proposal: RuleProposal }>(`/api/rule-proposals/${proposal.id}/review`, { status: "rejected", reason: "先确认团队的错误处理约定。" });
    expect(rejected.status).toBe(200);
    const sets = (await fixture.readLibrary()).body.sets;
    expect(sets.find((set) => set.id === "go-guidelines")!.entries.find((entry) => entry.id === "go-guidelines-check-errors"))
      .toMatchObject({ appliedRuleId: null, appliedVersion: null, hasUpdate: false });
    const applied = await fixture.request<Applied>("/api/rule-library/go-guidelines/apply", { entryIds: ["go-guidelines-check-errors"] });
    expect(applied.status).toBe(200); expect(applied.body.created).toBe(1);
    expect(applied.body.rules[0]).toMatchObject({ status: "active", version: 1, librarySource: { version: "2026.10.4" } });
    expect(applied.body.rules[0]!.id).not.toBe(original.id);
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toEqual(applied.body.rules);
    const proposals = (await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toEqual({ ...rejected.body.proposal, managedRuleId: null });
    const repeated = await fixture.request<Applied>("/api/rule-library/go-guidelines/apply", { entryIds: ["go-guidelines-check-errors"] });
    expect(repeated.body).toEqual({ rules: applied.body.rules, created: 0 });
  });
  it.each(["draft", "active"] as const)("被拒绝后重新保存为 %s 的规范仍按已有规范跳过", async (status) => {
    const fixture = await start();
    const original = await fixture.seedLegacyLibraryDraft("go-guidelines", "go-guidelines-check-errors");
    const proposal = (await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals[0]!;
    expect((await fixture.request(`/api/rule-proposals/${proposal.id}/review`, { status: "rejected", reason: "补充团队使用范围。" })).status).toBe(200);
    const saved = await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${original.id}`, {
      ...managedRuleInput(original), body: "外部调用失败时记录订单号并返回错误。", status, version: original.version,
    }, { method: "PUT" });
    expect(saved.status).toBe(200);
    const sets = (await fixture.readLibrary()).body.sets;
    expect(sets.find((set) => set.id === "go-guidelines")!.entries.find((entry) => entry.id === "go-guidelines-check-errors")?.appliedRuleId).toBe(original.id);
    const applied = await fixture.request<Applied>("/api/rule-library/go-guidelines/apply", { entryIds: ["go-guidelines-check-errors"] });
    expect(applied.body).toEqual({ created: 0, rules: [saved.body.rule] });
  });
  it("应用条目把原文名称和检查建议组成正文，正反例及示例语言独立保存", async () => {
    const fixture = await start();
    const sets = (await fixture.readLibrary()).body.sets;
    const set = sets.find((set) => set.id === "power-of-ten")!, entry = set.entries[0]!;
    const response = await fixture.request<Applied>(`/api/rule-library/${set.id}/apply`, { entryIds: [entry.id] });
    expect(response.status).toBe(200);
    const rule = response.body.rules[0]!;
    const body = `原文名称：${entry.originalName}\n\n摘要：${entry.summary}\n\n${entry.body}\n\n## 检查什么\n\n${entry.check}\n\n## 为什么\n\n${entry.why}\n\n## 怎么改\n\n${entry.fix}`;
    expect(rule).toMatchObject({ name: entry.title, body, goodExample: entry.goodExample, badExample: entry.badExample,
      librarySource: { entryId: entry.id, version: "2026.10.4", body, exampleLanguage: entry.exampleLanguage } });
    const detail = await fixture.request<RuleDetail>(`/api/rules/managed:${rule.id}/detail`);
    expect(detail.status).toBe(200);
    expect(detail.body.rule).toMatchObject({ body, goodExample: entry.goodExample, badExample: entry.badExample, managedRule: rule });
  });
  it("版本更新展示原库正文、团队正文和新库正文，采用保留团队属性并检查并发版本", async () => {
    const sets = await loadRuleLibrary();
    const set = sets.find((set) => set.id === "power-of-ten")!;
    set.libraryVersion = "2026.10.0";
    const fixture = await start(sets);
    const applied = await fixture.request<Applied>("/api/rule-library/power-of-ten/apply", { entryIds: ["power-of-ten-bounded-calls"] });
    const rule = applied.body.rules[0]!;
    const local = (await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}`, { ...managedRuleInput(rule), body: "团队在提交前检查所有间接递归调用。", goodExample: "check_call_graph();", severity: "error", version: 1 }, { method: "PUT" })).body.rule;
    set.libraryVersion = "2026.10.4"; set.entries[0]!.body = "安全关键 C 的调用链必须证明不存在直接和间接递归。";
    set.entries[0]!.goodExample = "while (has_next()) process_next();"; set.entries[0]!.badExample = "void process(void) { process(); }";
    const update = (await fixture.request<{ update: LibraryUpdate }>(`/api/managed-rules/${rule.id}/library-update`)).body.update;
    expect(update).toMatchObject({
      hasUpdate: true, previousBody: rule.body, currentBody: local.body, incomingBody: expect.stringContaining(set.entries[0]!.body),
      incomingGoodExample: set.entries[0]!.goodExample, incomingBadExample: set.entries[0]!.badExample, incomingExampleLanguage: "c",
    });
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules.find((entry) => entry.id === rule.id)).toEqual(local);
    expect((await fixture.request(`/api/managed-rules/${rule.id}/library-update`, { version: 1 })).status).toBe(409);
    expect((await fixture.request(`/api/managed-rules/${rule.id}/library-update`, { version: 2 }, { cookie: fixture.memberCookie })).status).toBe(403);
    const updated = (await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}/library-update`, { version: 2 })).body.rule;
    expect(updated).toMatchObject({ body: update.incomingBody, goodExample: set.entries[0]!.goodExample, badExample: set.entries[0]!.badExample,
      severity: "error", version: 3, librarySource: { version: "2026.10.4", body: update.incomingBody, exampleLanguage: "c" } });
    expect((await fixture.request<{ update: LibraryUpdate }>(`/api/managed-rules/${rule.id}/library-update`)).body.update.hasUpdate).toBe(false);
    expect((await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}/library-update`, { version: 3 })).body.rule.version).toBe(3);
  });
  it.each([
    ["design-principles", "design-principles-identical-branches", "design-principles-simplicity", "2026.10.1"],
    ["design-principles", "design-principles-derived-state", "design-principles-parsimony", "2026.10.1"],
    ["c-traps-and-pitfalls", "c-traps-and-pitfalls-input-sentinel", "c-traps-and-pitfalls-getchar-int", "2026.10.0"],
    ["dpdk-data-plane", "dpdk-data-plane-ring-concurrency", "dpdk-data-plane-ring-sync-mode", "2026.10.0"],
    ["refactoring-smells", "refactoring-smells-owned-calculation", "refactoring-smells-feature-envy", "2026.10.0"],
    ["power-of-ten", "power-of-ten-checked-parameters", "power-of-ten-checked-results", "2026.10.0"],
    ["google-code-review", "google-code-review-concurrent-updates", "google-code-review-boundary-inputs", "2026.10.0"],
    ["google-code-review", "google-code-review-reachable-recovery", "google-code-review-boundary-inputs", "2026.10.0"],
    ["google-code-review", "google-code-review-meaningful-test-oracle", "google-code-review-regression-assertion", "2026.10.0"],
  ])("%s 的旧条目关联可以预览和采用新版，重复应用不新增规则", async (setId, previousId, entryId, previousVersion) => {
    const fixture = await start();
    const applied = await fixture.request<Applied>(`/api/rule-library/${setId}/apply`, { entryIds: [entryId] });
    const rule = applied.body.rules[0]!;
    await withTeam(fixture.teamId, () => fixture.pool.query("UPDATE managed_rules SET body=$2,library_source=$3 WHERE id=$1", [rule.id, "团队保存的原版正文。",
      JSON.stringify({ setId, entryId: previousId, version: previousVersion, body: "原版规范库正文。" })]));
    const set = (await fixture.readLibrary()).body.sets.find((set) => set.id === setId)!;
    expect(set.entries.find((entry) => entry.id === entryId)).toMatchObject({ appliedRuleId: rule.id, hasUpdate: true });
    const repeated = await fixture.request<Applied>(`/api/rule-library/${setId}/apply`, { entryIds: [entryId] });
    expect(repeated.body.created).toBe(0); expect(repeated.body.rules[0]!.body).toBe("团队保存的原版正文。");
    const update = (await fixture.request<{ update: LibraryUpdate }>(`/api/managed-rules/${rule.id}/library-update`)).body.update;
    expect(update).toMatchObject({ entryId, hasUpdate: true, appliedVersion: previousVersion, latestVersion: "2026.10.4", previousBody: "原版规范库正文。", currentBody: "团队保存的原版正文。" });
    const adopted = await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}/library-update`, { version: rule.version });
    expect(adopted.status).toBe(200);
    expect(adopted.body.rule).toMatchObject({ body: update.incomingBody, goodExample: update.incomingGoodExample,
      badExample: update.incomingBadExample, librarySource: { entryId, version: "2026.10.4", exampleLanguage: update.incomingExampleLanguage } });
  });
  it("两个旧条目合为一条时保留两条团队规范，采用新版不触发关联冲突", async () => {
    const fixture = await start();
    const applied = await fixture.request<Applied>("/api/rule-library/power-of-ten/apply", { entryIds: ["power-of-ten-checked-results"] });
    const canonical = applied.body.rules[0]!;
    const legacy = (await fixture.request<{ rule: ManagedRule }>("/api/managed-rules", { ...managedRuleInput(canonical), name: "检查入参范围", body: "进入函数时检查参数。" })).body.rule;
    await withTeam(fixture.teamId, () => fixture.pool.query("UPDATE managed_rules SET library_source=$2 WHERE id=$1", [legacy.id,
      JSON.stringify({ setId: "power-of-ten", entryId: "power-of-ten-checked-parameters", version: "2026.10.0", body: legacy.body })]));
    const repeated = await fixture.request<Applied>("/api/rule-library/power-of-ten/apply", { entryIds: ["power-of-ten-checked-results"] });
    expect(repeated.body.created).toBe(0); expect(repeated.body.rules[0]!.id).toBe(canonical.id);
    const set = (await fixture.readLibrary()).body.sets.find((set) => set.id === "power-of-ten")!;
    expect(set.entries.find((entry) => entry.id === "power-of-ten-checked-results")!.appliedRuleId).toBe(canonical.id);
    const adopted = await fixture.request<{ rule: ManagedRule }>(`/api/managed-rules/${legacy.id}/library-update`, { version: legacy.version });
    expect(adopted.status).toBe(200);
    expect(adopted.body.rule.librarySource).toMatchObject({ entryId: "power-of-ten-checked-parameters", version: "2026.10.4" });
    expect((await fixture.request<{ update: LibraryUpdate }>(`/api/managed-rules/${legacy.id}/library-update`)).body.update).toMatchObject({ entryId: "power-of-ten-checked-results", hasUpdate: false });
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toHaveLength(2);
  });
  it("非法条目和落库故障不留下半套规范或提案", async () => {
    const fixture = await start();
    expect((await fixture.request("/api/rule-library/power-of-ten/apply", { entryIds: ["power-of-ten-bounded-calls", "missing"] })).status).toBe(400);
    await withTeam(fixture.teamId, () => fixture.pool.query(`CREATE FUNCTION reject_second_library_rule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.library_source->>'entryId'='power-of-ten-bounded-loops' THEN RAISE EXCEPTION 'fixture'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_second_library_rule BEFORE UPDATE ON managed_rules FOR EACH ROW EXECUTE FUNCTION reject_second_library_rule()`));
    expect((await fixture.request("/api/rule-library/power-of-ten/apply", { entryIds: ["power-of-ten-bounded-calls", "power-of-ten-bounded-loops"] })).status).toBe(500);
    expect((await fixture.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules).toEqual([]);
    expect((await fixture.request<{ proposals: RuleProposal[] }>("/api/rule-proposals")).body.proposals).toEqual([]);
  });
});
