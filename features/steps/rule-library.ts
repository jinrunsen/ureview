import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { ManagedRuleScenario } from "../../packages/server/src/rules/managed/test-support.js";
import { loadRuleLibrary, RuleLibraryService } from "../../packages/server/src/rules/library.js";
import type { AppliedLibrarySet, LibrarySet } from "../../packages/server/src/rules/library-types.js";
import type { ManagedRule, ManagedRuleInput } from "../../packages/server/src/rules/managed-types.js";
import type { RuleDetail } from "../../packages/server/src/rules/detail.js";
import type { RuleProposal } from "../../packages/server/src/rules/proposal-types.js";

interface State {
  app: ManagedRuleScenario; library: LibrarySet[]; sets: AppliedLibrarySet[];
  rules: ManagedRule[]; previousRules?: ManagedRule[]; rejectedProposal?: RuleProposal; created: number; status: number;
}
const states = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => { const value = states.get(world); assert.ok(value); return value; };
const setId = "go-guidelines";
const entryIds = ["go-guidelines-check-errors", "go-guidelines-release-resources"];
function input(rule: ManagedRule): ManagedRuleInput {
  const { name, body, goodExample, badExample, category, severity, layer, languages, judgement, overrides, scope, repositories, status } = rule;
  return { name, body, goodExample, badExample, category, severity, layer, languages, judgement, overrides, scope, repositories, status };
}
Before({ tags: "@layer:api and @story:rule-library", timeout: 60_000 }, async function (this: ApiWorld) {
  const value: State = { app: new ManagedRuleScenario(), library: structuredClone(await loadRuleLibrary()), sets: [], rules: [], created: 0, status: 0 };
  states.set(this, value);
  await value.app.start({ library: (pool) => new RuleLibraryService(pool, async () => value.library) });
});
After({ tags: "@layer:api and @story:rule-library", timeout: 60_000 }, async function (this: ApiWorld) { await states.get(this)?.app.stop(); });
async function apply(value: State, ids = entryIds, member = false) {
  const result = await value.app.request<{ rules: ManagedRule[]; created: number }>(`/api/rule-library/${setId}/apply`, { entryIds: ids },
    member ? { cookie: value.app.memberCookie } : {});
  value.status = result.status;
  if (result.status === 200 || result.status === 201) { value.rules = result.body.rules; value.created = result.body.created; }
  return result;
}
async function list(value: State, query = "", member = false) {
  const result = await value.app.readLibrary(query, member ? { cookie: value.app.memberCookie } : {});
  assert.equal(result.status, 200, JSON.stringify(result.body)); value.sets = result.body.sets; return result.body.sets;
}
Given("团队管理员打开规范库", async function (this: ApiWorld) { assert.ok((await list(state(this))).length >= 8); });
When("管理员筛选语言层的 Go 规范", async function (this: ApiWorld) { await list(state(this), "?layer=language&language=go"); });
Then("规范集包含条目、来源、收录理由与许可", function (this: ApiWorld) {
  const sets = state(this).sets; assert.equal(sets.length, 1);
  const item = sets[0]!; assert.equal(item.id, setId); assert.equal(item.layer, "language"); assert.deepEqual(item.languages, ["go"]);
  assert.ok(item.sources.every((source) => source.author && source.title && source.url));
  assert.ok(item.inclusionReasons.length); assert.ok(item.license.tier); assert.ok(item.license.attribution);
  assert.ok(item.entries.length >= 8); assert.ok(item.entries.every((entry) => entry.body && entry.source.reference));
});
When("管理员应用 Go 规范集的两条规范", async function (this: ApiWorld) { const value = state(this); await apply(value); assert.ok([200, 201].includes(value.status)); assert.equal(value.created, 2); });
Then("团队得到两条语言层的 Go 生效规范并保留规范库关联", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.rules.length, 2);
  for (const rule of value.rules) {
    assert.equal(rule.status, "active"); assert.equal(rule.layer, "language"); assert.deepEqual(rule.languages, ["go"]);
    assert.ok(rule.librarySource); assert.equal(rule.librarySource.setId, setId);
    assert.ok(entryIds.includes(rule.librarySource.entryId)); assert.equal(rule.librarySource.version, "2026.10.4");
  }
  const proposals = await value.app.request<{ proposals: RuleProposal[] }>("/api/rule-proposals");
  assert.equal(proposals.status, 200); assert.deepEqual(proposals.body.proposals, []);
});
When("管理员再次应用这两条规范", async function (this: ApiWorld) {
  const value = state(this); value.previousRules = value.rules; await apply(value);
});
Then("规范数量不变且规范库条目标记已应用", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.created, 0);
  assert.deepEqual(value.rules, value.previousRules);
  const rules = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules"); assert.equal(rules.body.rules.length, 2);
  const set = (await list(value)).find((item) => item.id === setId)!;
  assert.equal(set.entries.filter((entry) => entry.appliedRuleId).length, 2);
  assert.ok(set.entries.filter((entry) => entry.appliedRuleId).every((entry) => entry.appliedVersion === "2026.10.4"));
});
Given("团队成员李娜打开规范库", async function (this: ApiWorld) { assert.ok((await list(state(this), "", true)).length >= 8); });
When("李娜尝试应用 Go 规范", async function (this: ApiWorld) { await apply(state(this), [entryIds[0]!], true); });
Then("应用未生效且团队没有新增规范", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.status, 403);
  const result = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules"); assert.deepEqual(result.body.rules, []);
});
Given("团队已应用并修改一条 Go 规范", async function (this: ApiWorld) {
  const value = state(this);
  value.library.find((set) => set.id === setId)!.libraryVersion = "2026.10.0";
  await apply(value, [entryIds[0]!]); const rule = value.rules[0]!;
  const result = await value.app.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}`, { ...input(rule), body: "外部调用失败时必须记录订单号。", version: rule.version }, { method: "PUT" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); value.rules = [result.body.rule];
});
When("规范库发布该条目的新版本", function (this: ApiWorld) {
  const library = state(this).library.find((set) => set.id === setId)!; library.libraryVersion = "2026.10.4";
  const entry = library.entries.find((entry) => entry.id === entryIds[0])!;
  entry.body = "调用失败时先处理错误，再使用结果，并关闭已打开的资源。";
  entry.goodExample = "file, err := os.Open(path)\nif err != nil { return err }\ndefer file.Close()";
  entry.badExample = "file, _ := os.Open(path)\ndefer file.Close()";
});
When("管理员再次应用已修改的 Go 规范", async function (this: ApiWorld) {
  const value = state(this); value.previousRules = value.rules; await apply(value, [entryIds[0]!]);
  assert.equal(value.status, 200); assert.equal(value.created, 0);
});
Then("团队规范正文与版本保持不变", async function (this: ApiWorld) {
  const value = state(this);
  assert.deepEqual(value.rules, value.previousRules);
  const result = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(result.status, 200); assert.deepEqual(result.body.rules, value.previousRules);
});
When("管理员查看规范库中的全部条目", async function (this: ApiWorld) { await list(state(this)); });
Then("每条规范都有原文名称、摘要、正文、检查什么、为什么、怎么改与正反例", function (this: ApiWorld) {
  const sets = state(this).sets;
  assert.equal(sets.length, 8);
  for (const set of sets) {
    assert.equal(set.libraryVersion, "2026.10.4");
    for (const entry of set.entries) {
      for (const field of ["originalName", "summary", "body", "check", "why", "fix", "goodExample", "badExample", "exampleLanguage"] as const) {
        assert.ok(typeof entry[field] === "string" && entry[field].trim(), `${entry.id}.${field}`);
      }
    }
  }
});
Then("规范详情包含完整检查建议与各自的正反例", async function (this: ApiWorld) {
  const value = state(this), set = (await list(value)).find((set) => set.id === setId)!;
  for (const rule of value.rules) {
    const entry = set.entries.find((entry) => entry.id === rule.librarySource!.entryId)!;
    const detail = await value.app.request<RuleDetail>(`/api/rules/managed:${rule.id}/detail`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.rule.body, `原文名称：${entry.originalName}\n\n摘要：${entry.summary}\n\n${entry.body}\n\n## 检查什么\n\n${entry.check}\n\n## 为什么\n\n${entry.why}\n\n## 怎么改\n\n${entry.fix}`);
    assert.equal(detail.body.rule.goodExample, entry.goodExample); assert.equal(detail.body.rule.badExample, entry.badExample);
    assert.equal(detail.body.rule.managedRule!.librarySource!.exampleLanguage, entry.exampleLanguage);
  }
});

When("管理员应用 Feature Envy 判断题条目", async function (this: ApiWorld) {
  const value = state(this);
  const set = (await list(value)).find((item) => item.id === "refactoring-smells")!;
  assert.ok(set.entries.every((entry) => entry.judgement));
  const response = await value.app.request<{ rules: ManagedRule[] }>("/api/rule-library/refactoring-smells/apply", {
    entryIds: ["refactoring-smells-feature-envy"],
  });
  assert.equal(response.status, 200, JSON.stringify(response.body)); value.rules = response.body.rules;
});
Then("工作台规范与规范详情保留判断题属性和规范库关联", async function (this: ApiWorld) {
  const value = state(this), rule = value.rules[0]!;
  assert.equal(rule.judgement, true); assert.equal(rule.status, "active");
  assert.equal(rule.librarySource?.entryId, "refactoring-smells-feature-envy");
  const detail = await value.app.request<RuleDetail>(`/api/rules/managed:${rule.id}/detail`);
  assert.equal(detail.status, 200); assert.equal(detail.body.rule.judgement, true);
});
Given("团队已应用一条普通 Go 规范", async function (this: ApiWorld) {
  const value = state(this); await apply(value, [entryIds[0]!]);
  assert.equal(value.status, 200); assert.equal(value.rules[0]!.judgement, false);
});
When("规范库新版仅把该条目标为判断题", function (this: ApiWorld) {
  const set = state(this).library.find((item) => item.id === setId)!;
  set.libraryVersion = "2026.10.5";
  set.entries.find((entry) => entry.id === entryIds[0])!.judgement = true;
});
When("管理员再次应用这条普通 Go 规范", async function (this: ApiWorld) {
  const value = state(this); value.previousRules = value.rules; await apply(value, [entryIds[0]!]);
  assert.equal(value.status, 200); assert.equal(value.created, 0);
});
Then("团队规范仍为普通规范且版本保持不变", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.rules[0]!.judgement, false);
  assert.deepEqual(value.rules, value.previousRules);
  const result = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(result.status, 200); assert.deepEqual(result.body.rules, value.previousRules);
});
Given("团队有一条已拒绝的规范库草稿", async function (this: ApiWorld) {
  const value = state(this);
  value.rules = [await value.app.seedLegacyLibraryDraft(setId, entryIds[0]!)];
  const proposals = await value.app.request<{ proposals: RuleProposal[] }>("/api/rule-proposals");
  assert.equal(proposals.status, 200);
  const rejected = await value.app.request<{ proposal: RuleProposal }>(`/api/rule-proposals/${proposals.body.proposals[0]!.id}/review`, {
    status: "rejected", reason: "需要先确认团队的错误处理约定。",
  });
  assert.equal(rejected.status, 200); value.rejectedProposal = rejected.body.proposal;
});
When("管理员查看该规范库条目", async function (this: ApiWorld) { await list(state(this)); });
Then("该条目标记为未应用", function (this: ApiWorld) {
  const value = state(this), entry = value.sets.find((set) => set.id === setId)!.entries.find((entry) => entry.id === entryIds[0])!;
  assert.equal(entry.appliedRuleId, null); assert.equal(entry.appliedVersion, null);
});
When("管理员重新应用被拒绝的规范库条目", async function (this: ApiWorld) {
  const value = state(this); value.previousRules = value.rules; await apply(value, [entryIds[0]!]);
  assert.equal(value.status, 200); assert.equal(value.created, 1);
});
Then("团队得到生效规范并保留原提案的拒绝记录", async function (this: ApiWorld) {
  const value = state(this), rule = value.rules[0]!;
  assert.equal(rule.status, "active"); assert.notEqual(rule.id, value.previousRules![0]!.id);
  const rules = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(rules.status, 200); assert.deepEqual(rules.body.rules, [rule]);
  const proposals = await value.app.request<{ proposals: RuleProposal[] }>("/api/rule-proposals");
  assert.equal(proposals.status, 200); assert.deepEqual(proposals.body.proposals, [{ ...value.rejectedProposal, managedRuleId: null }]);
});
