import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { RuleCatalogScenario } from "../support/rule-catalog-scenario.js";
import type { CandidateEntry, CatalogEntry, RuleSyncState } from "../../packages/server/src/rules/catalog.js";
import { ruleBody } from "../../packages/server/src/rules/catalog/test-support.js";
import type { ManagedRule } from "../../packages/server/src/rules/managed-types.js";
import type { CatalogLint } from "../../packages/server/src/rules/catalog-source.js";

interface State {
  scenario: RuleCatalogScenario; managedRules: ManagedRule[]; rules: CatalogEntry[]; lints: CatalogLint[]; candidates: CandidateEntry[];
  before?: { rules: CatalogEntry[]; sync: RuleSyncState[] }; otherRepositoryId?: string; responseStatus?: number;
}
const values = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => values.get(world)!;
Before({ tags: "@story:rule-catalog", timeout: 60_000 }, async function (this: ApiWorld) {
  const scenario = new RuleCatalogScenario(); values.set(this, { scenario, managedRules: [], rules: [], lints: [], candidates: [] }); await scenario.start();
});
After({ tags: "@story:rule-catalog", timeout: 60_000 }, async function (this: ApiWorld) { await state(this)?.scenario.stop(); });

async function synchronize(scenario: RuleCatalogScenario, repositoryId: string) {
  const result = await scenario.request(`/api/rules/repositories/${repositoryId}/sync`, {}); assert.equal(result.status, 200);
}
async function readRules(world: ApiWorld) {
  const value = state(world);
  const response = await value.scenario.request<{ rules: CatalogEntry[]; managedRules: ManagedRule[]; lints: CatalogLint[]; sync: RuleSyncState[] }>(`/api/rules?repositoryId=${value.scenario.repositoryId}`);
  assert.equal(response.status, 200); value.rules = response.body.rules; value.managedRules = response.body.managedRules; value.lints = response.body.lints; return response.body;
}
async function readCandidates(world: ApiWorld) {
  const response = await state(world).scenario.request<{ candidates: CandidateEntry[] }>("/api/rule-candidates");
  assert.equal(response.status, 200); state(world).candidates = response.body.candidates; return response.body.candidates;
}
async function mine(world: ApiWorld, repositoryId?: string) {
  const scenario = state(world).scenario;
  const result = await scenario.request(`/api/rules/repositories/${repositoryId ?? scenario.repositoryId}/mine`, {});
  assert.equal(result.status, 200); await readCandidates(world);
}

Given("支付仓库继承全局金额规范并有仓库路径规则和惰性文档", async function (this: ApiWorld) {
  const scenario = state(this).scenario;
  const response = await scenario.request<{ repositories: Array<{ id: string }> }>("/api/repositories");
  assert.equal(response.status, 200);
  assert.ok(response.body.repositories.some((repository) => repository.id === scenario.repositoryId));
  assert.ok(scenario.gitlab.state.files[".agents/rules/lazy.md"]);
});
Given("支付仓库同时维护金额规则和根目录与结算子包的 lint 检查", function (this: ApiWorld) {
  const files = state(this).scenario.gitlab.state.files;
  const checker = "export const meta = { name: 'no-debug', description: '生产代码限制调试日志', paths: ['src/**/*.ts'], args: ['--check'] };\nthrow new Error('目录同步不应运行此脚本');\n";
  files[".agents/lints/no-debug.mjs"] = checker;
  files["packages/settlement/.agents/lints/no-debug.mjs"] = checker;
  files[".agents/rules/no-debug.mjs"] = checker;
  files[".agents/lints/nested/no-debug.mjs"] = checker;
});
Then("规则目录仍然包含金额规则和惰性文档", function (this: ApiWorld) {
  const { rules } = state(this);
  assert.equal(rules.length, 2);
  assert.ok(rules.some((rule) => rule.body === ruleBody));
  assert.ok(rules.some((rule) => rule.lazy));
  assert.ok(rules.every((rule) => !rule.id.startsWith("lint:")));
});
Then("lint 目录展示检查名称、路径条件、执行脚本及来源提交", function (this: ApiWorld) {
  const { lints } = state(this);
  assert.equal(lints.length, 2);
  for (const lint of lints) {
    assert.equal(lint.kind, "lint"); assert.equal(lint.name, "no-debug");
    assert.equal(lint.description, "生产代码限制调试日志");
    assert.deepEqual(lint.paths, ["src/**/*.ts"]); assert.deepEqual(lint.args, ["--check"]);
    assert.equal(lint.script, lint.file.path); assert.equal(lint.file.commitSha, "a".repeat(40));
    assert.ok(lint.file.url.includes(`/-/blob/${lint.file.commitSha}/`));
    assert.ok(!Object.hasOwn(lint, "counts"));
  }
});
Then("子包检查的路径条件以结算子包为基准", function (this: ApiWorld) {
  const { lints } = state(this);
  assert.equal(lints[0]?.checkerRoot, "packages/settlement");
  assert.equal(lints[1]?.checkerRoot, "");
});
Then("放在规则目录或 lint 子目录内的脚本不进入 lint 目录", function (this: ApiWorld) {
  assert.deepEqual(state(this).lints.map((lint) => lint.file.path), [
    "packages/settlement/.agents/lints/no-debug.mjs", ".agents/lints/no-debug.mjs",
  ]);
});
Given("金额校验规范有未处置、采纳、被无视和驳回各一条结论", async function (this: ApiWorld) { await state(this).scenario.seedFindingStates(); });
When("团队负责人同步并查看支付仓库规范", async function (this: ApiWorld) {
  const { scenario } = state(this); await synchronize(scenario, scenario.repositoryId); await readRules(this);
});
Then("规范表包含全局金额规范、仓库金额规范和惰性文档", function (this: ApiWorld) {
  const { rules } = state(this); assert.equal(rules.length, 2);
  assert.ok(state(this).managedRules.some((rule) => rule.scope === "global" && rule.body === "金额使用整数分"));
  assert.ok(rules.some((rule) => rule.body === ruleBody)); assert.ok(rules.some((rule) => rule.lazy && rule.body.includes("惰性约定")));
});
Then("仓库金额规范的命中、采纳和被无视分别为 {int}、{int} 和 {int}", function (this: ApiWorld, hits: number, adopted: number, ignored: number) {
  assert.deepEqual(state(this).rules.find((rule) => rule.id === "repository:.agents/rules/payment.md")?.counts, { hits, adopted, dismissed: 1, ignored });
});
Then("全局规范显示已启用并保留数据库版本", function (this: ApiWorld) {
  const rule = state(this).managedRules.find((rule) => rule.scope === "global");
  assert.equal(rule?.status, "active"); assert.equal(rule?.version, 1);
});
Given("支付仓库有二十条在两个历史 PR 的后续提交中落实的重复建议", function (this: ApiWorld) {
  state(this).scenario.gitlab.state.publicEmail = "";
  state(this).scenario.gitlab.state.commitEmail = "teammate@example.test";
  state(this).scenario.gitlab.state.ruleTexts = Array.from({ length: 20 }, (_, index) => `金额处理约定第 ${index + 1} 项：扣款入口需要校验金额为正整数。`);
});
When("管理员首次挖掘支付仓库候选", async function (this: ApiWorld) { await mine(this); });
Then("负责人看到 {int} 条候选且每条都有两个 PR 的原评论和代码采纳证据", function (this: ApiWorld, count: number) {
  const { candidates } = state(this); assert.equal(candidates.length, count);
  for (const candidate of candidates) {
    assert.deepEqual(candidate.evidence.map((evidence) => evidence.iid), [1, 2]);
    for (const evidence of candidate.evidence) {
      assert.match(evidence.commentUrl, /#note_\d+$/); assert.match(evidence.commitUrl, /\/-\/commit\/[a-f0-9]{40}$/);
      assert.equal(evidence.before, "const amount = input;"); assert.equal(evidence.after.trim(), "const amount = Math.max(input, 1);");
      assert.notEqual(evidence.beforeSha, evidence.afterSha);
    }
    assert.match(candidate.suggestedPath, /^\.agents\/rules\/candidate-/); assert.ok(candidate.markdown.includes(candidate.body));
  }
});
When("管理员在同一天再次挖掘候选", async function (this: ApiWorld) { await mine(this); });
Then("候选仍为 {int} 条", function (this: ApiWorld, count: number) { assert.equal(state(this).candidates.length, count); });
When("两周后管理员再次挖掘候选", async function (this: ApiWorld) { await state(this).scenario.ageMining(); await mine(this); });
Then("候选总数为 {int} 条", function (this: ApiWorld, count: number) { assert.equal(state(this).candidates.length, count); });
Given("支付仓库的重复建议只在一个 PR 的后续提交中落实", function (this: ApiWorld) { state(this).scenario.gitlab.state.pullRequestCount = 1; });
Then("负责人看不到规范候选", function (this: ApiWorld) { assert.deepEqual(state(this).candidates, []); });
When("另一个仓库的重复讨论都已解决但代码保持原样", async function (this: ApiWorld) {
  const value = state(this); value.otherRepositoryId = (await value.scenario.connect("commerce/settlement")).id;
  value.scenario.gitlab.state.pullRequestCount = 2; value.scenario.gitlab.state.currentAfter = "const amount = input;\n";
  value.scenario.gitlab.state.resolved = true;
});
When("管理员挖掘另一个仓库候选", async function (this: ApiWorld) { await mine(this, state(this).otherRepositoryId); });
Then("负责人仍然看不到规范候选", function (this: ApiWorld) { assert.deepEqual(state(this).candidates, []); });
Given("支付仓库已有带两个 PR 采纳证据的候选", async function (this: ApiWorld) { await mine(this); assert.equal(state(this).candidates.length, 1); });
When("负责人把候选内容提交到建议的仓库规范文件", function (this: ApiWorld) {
  const value = state(this), candidate = value.candidates[0]!; value.scenario.gitlab.state.files[candidate.suggestedPath] = candidate.markdown;
});
When("管理员重新同步支付仓库规范", async function (this: ApiWorld) { const scenario = state(this).scenario; await synchronize(scenario, scenario.repositoryId); });
Then("该候选显示已在 Git 中生效且规范表包含完整正文", async function (this: ApiWorld) {
  const candidates = await readCandidates(this); assert.equal(candidates[0]?.active, true);
  const catalog = await readRules(this); assert.ok(catalog.rules.some((rule) => rule.file.path === candidates[0]!.suggestedPath && rule.body === candidates[0]!.body));
});
Given("支付仓库已成功同步完整规范目录", async function (this: ApiWorld) {
  const value = state(this); await synchronize(value.scenario, value.scenario.repositoryId);
  value.before = await readRules(this);
});
When("仓库规范暂时无法读取时管理员重新同步", async function (this: ApiWorld) {
  const value = state(this); value.scenario.gitlab.state.failedFiles.add(".agents/rules/payment.md");
  value.responseStatus = (await value.scenario.request(`/api/rules/repositories/${value.scenario.repositoryId}/sync`, {})).status;
});
Then("负责人看到同步失败提示", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.responseStatus, 502);
  const result = await value.scenario.request<{ sync: RuleSyncState[] }>("/api/rules");
  assert.ok(result.body.sync.find((entry) => entry.repositoryId === value.scenario.repositoryId)?.syncError?.includes("失败"));
});
Then("仍可读取上一次完整规范正文与同步时间", async function (this: ApiWorld) {
  const value = state(this), current = await readRules(this); assert.deepEqual(current.rules, value.before!.rules);
  const source = value.scenario.repositoryId;
  const previous = value.before!.sync.find((entry) => entry.repositoryId === source);
  const latest = current.sync.find((entry) => entry.repositoryId === source);
  assert.ok(previous?.syncedAt);
  assert.equal(latest?.syncedAt, previous.syncedAt);
});
