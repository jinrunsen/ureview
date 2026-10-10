import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ReviewDetail, ReviewRule } from "../../packages/server/src/reviews/types.js";
import type { CatalogEntry, RuleSyncState } from "../../packages/server/src/rules/catalog.js";
import type { GeneratedRuleDraft, ManagedRule, ManagedRuleInput } from "../../packages/server/src/rules/managed-types.js";
import { makeMockFileGroups } from "../../packages/server/src/runtime/test-support.js";
import { lockPath, releaseCode, releasePath } from "../support/review-gitlab-fixture.js";
import { hierarchyDraft, RuleHierarchyScenario } from "../support/rule-hierarchy-scenario.js";
import type { ApiWorld } from "../support/world.js";

const cPath = "kernel/order_expiry.c";
const sqlPath = "database/expire_orders.sql";
const principleName = "简单设计原则";
const generalName = "并发操作保护通用规范";
const languageName = "Go 取消信号规范";
const teamName = "支付订单锁团队规范";
const sqlName = "SQL 事务规范";
const waiverReason = "结算迁移期间由仓库现有事务锁保证库存一致性。";
const gitId = (name: string) => `repository:.agents/rules/${name}.md`;
const managedId = (rule: ManagedRule) => `managed:${rule.id}`;
const markdown = (name: string, layer: string, languages: string[], overrides: string[] = []) =>
  `---\nname: ${name}\nlayer: ${layer}\nlanguages: ${JSON.stringify(languages)}\npaths: ["internal/**/*.go"]\noverrides: ${JSON.stringify(overrides)}\n---\n${name}的规范正文。\n`;

function finding(path = releasePath) {
  const startLine = path === releasePath ? 3 : 1;
  return { title: "库存释放需要检查取消信号", description: "请求取消后仍可能继续释放库存。", severity: "high" as const,
    location: { path, startLine, endLine: startLine + 1 },
    evidence: [{ path, startLine, endLine: startLine + 1, description: "库存释放入口" }], fixPrompt: "在库存释放前检查取消信号。" };
}

function editable(rule: ManagedRule): ManagedRuleInput & { version: number } {
  return { name: rule.name, body: rule.body, goodExample: rule.goodExample, badExample: rule.badExample,
    category: rule.category, severity: rule.severity, layer: rule.layer, languages: rule.languages, judgement: rule.judgement,
    overrides: rule.overrides, scope: rule.scope, repositories: rule.repositories, status: rule.status, version: rule.version };
}

interface State {
  scenario: RuleHierarchyScenario;
  review?: ReviewDetail;
  oldReview?: ReviewDetail;
  otherReview?: ReviewDetail;
  otherRepository?: Awaited<ReturnType<RuleHierarchyScenario["addRepository"]>>;
  requestStart: number;
  requestEnd?: number | undefined;
  catalog?: { rules: CatalogEntry[]; sync: RuleSyncState[] };
  generated?: GeneratedRuleDraft;
  rejectionStatuses?: number[];
  originals?: ManagedRule[];
}
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State { const value = states.get(world); assert.ok(value); return value; }
Before({ tags: "@layer:api and @story:rule-hierarchy" }, function (this: ApiWorld) {
  states.set(this, { scenario: new RuleHierarchyScenario(), requestStart: 0 });
});
After({ tags: "@layer:api and @story:rule-hierarchy", timeout: 60_000 }, async function (this: ApiWorld) {
  await states.get(this)?.scenario.stop(); states.delete(this);
});

async function prepare(value: State, path = releasePath) {
  await value.scenario.start(path);
  value.scenario.options.candidates!.push(finding(path));
}
function rule(value: State, name: string): ManagedRule {
  const result = value.scenario.rules.get(name); assert.ok(result); return result;
}
function snapshot(value: State, name: string): ReviewRule {
  const result = value.review!.rules.find((entry) => entry.id === managedId(rule(value, name)));
  assert.ok(result, `评审快照缺少 ${name}`); return result;
}
function contexts(value: State, model: string): string[] {
  return value.scenario.model!.requests.slice(value.requestStart, value.requestEnd)
    .filter((request) => request.body.model === model && request.body.tools?.some((tool) =>
      tool.name === "report_finding" || tool.name === "grade_finding"))
    .flatMap((request) => request.body.messages.flatMap((message) => typeof message.content === "string"
      ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "")))
    .filter((message) => message.includes("本次预先注入的团队规范：") || message.includes("<rule-context"));
}
function assertInjected(value: State, present: string[], absent: string[] = []) {
  for (const model of ["fixture-generator", "fixture-grader"]) {
    const text = contexts(value, model).join("\n");
    assert.ok(text, `${model} 没有规范上下文`);
    for (const body of present) assert.ok(text.includes(body), `${model} 未收到 ${body}`);
    for (const body of absent) assert.ok(!text.includes(body), `${model} 不应收到 ${body}`);
  }
}
async function run(value: State) {
  value.requestStart = value.scenario.model!.requests.length;
  value.requestEnd = undefined;
  value.review = await value.scenario.review();
}

Given("张伟已启用 SQL 事务规范和适用全部语言的通用规范", async function (this: ApiWorld) {
  const value = state(this); await prepare(value, cPath);
  await value.scenario.create(sqlName, { layer: "language", languages: ["sql"] });
  await value.scenario.create(generalName, { layer: "general", languages: [] });
  await value.scenario.gitlab!.commitFiles({ [releasePath]: releaseCode.replace("restoreStock(orderID)", "lockInventory(orderID)"),
    [cPath]: "int release_expired_order(int order_id) {\n  return restore_stock(order_id);\n}\n" });
});
When("李娜发起只修改 C 文件的评审", { timeout: 60_000 }, async function (this: ApiWorld) { await run(state(this)); });
Then("两个评审模型只收到通用规范且本轮依据没有 SQL 规范", function (this: ApiWorld) {
  const value = state(this);
  assert.deepEqual(value.review!.rules.map((entry) => entry.id), [managedId(rule(value, generalName))]);
  assertInjected(value, [rule(value, generalName).body], [rule(value, sqlName).body]);
});
When("李娜为同一仓库发起包含 SQL 文件的评审", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this);
  await value.scenario.gitlab!.commitFiles({ [sqlPath]: "BEGIN;\nUPDATE orders SET expired = TRUE;\nCOMMIT;\n" });
  await run(value);
});
Then("两个评审模型收到 SQL 事务规范且本轮依据记录 SQL 语言", function (this: ApiWorld) {
  const value = state(this); assertInjected(value, [rule(value, sqlName).body]);
  assert.equal(snapshot(value, sqlName).layer, "language");
  assert.deepEqual(snapshot(value, sqlName).languages, ["sql"]);
  assert.deepEqual(snapshot(value, sqlName).matchedPaths, [sqlPath]);
});

Given("张伟已启用仅适用于数据库目录中 Go 文件的规范", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  await value.scenario.create(languageName, { layer: "language", languages: ["go"], scope: "repositories",
    repositories: [{ repositoryId: value.scenario.repositoryId, paths: ["database/**"] }] });
});
When("李娜评审数据库目录的 SQL 文件和库存目录的 Go 文件", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this); await value.scenario.gitlab!.commitFiles({ [sqlPath]: "SELECT order_id FROM orders;\n" }); await run(value);
});
Then("这条规范没有进入本轮依据或任一评审模型", function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(value.review!.rules, []);
  for (const model of ["fixture-generator", "fixture-grader"]) {
    assert.ok(value.scenario.model!.requests.some((request) => request.body.model === model));
    assert.ok(!contexts(value, model).join("\n").includes(rule(value, languageName).body));
  }
});

Given("张伟已启用原则、通用、语言和团队四个层级的规范", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  for (const [name, layer] of [[principleName, "principle"], [generalName, "general"],
    [languageName, "language"], [teamName, "team"]] as const) {
    await value.scenario.create(name, { layer, languages: layer === "language" ? ["go"] : [] });
  }
});
Given("本轮模型先引用原则报告结论再引用团队规范报告结论", function (this: ApiWorld) {
  const value = state(this);
  value.scenario.options.generatorScript = [
    { name: "read", input: { file_path: releasePath, offset: 3, limit: 2 }, result: { isError: false } },
    { name: "report_finding", input: { ...finding(), ruleId: managedId(rule(value, principleName)) },
      result: { isError: true, includes: "原则层" } },
    { name: "report_finding", input: { ...finding(), ruleId: managedId(rule(value, teamName)) }, result: { isError: false } },
    { name: "report_file_groups", input: { fileGroups: makeMockFileGroups([releasePath]) }, result: { isError: false } },
    { name: "finish_report", input: {}, result: { isError: false } },
  ];
});
When("李娜评审库存释放变更", { timeout: 60_000 }, async function (this: ApiWorld) { await run(state(this)); });
Then("原则引用被拒绝且仅保留命中团队规范的结论", function (this: ApiWorld) {
  const value = state(this);
  assert.deepEqual(value.review!.findings.map((item) => item.ruleId), [managedId(rule(value, teamName))]);
  const rejected = value.review!.reportSubmissions.filter((submission) => submission.outcome === "rejected");
  assert.equal(rejected.length, 1); assert.equal(rejected[0]!.code, "invalid_rule_reference");
  assert.match(rejected[0]!.reason ?? "", /原则层/); assert.equal(snapshot(value, teamName).layer, "team");
});
Then("两个评审模型按原则、通用、语言和团队顺序收到规范", function (this: ApiWorld) {
  const value = state(this), bodies = [principleName, generalName, languageName, teamName].map((name) => rule(value, name).body);
  assertInjected(value, bodies);
  for (const model of ["fixture-generator", "fixture-grader"]) {
    const text = contexts(value, model).find((entry) => bodies.every((body) => entry.includes(body)));
    assert.ok(text); const positions = bodies.map((body) => text.indexOf(body));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
    assert.match(text, /原则/); assert.match(text, /更具体/);
  }
});

Given("张伟保存了一条未声明层级和适用语言的工作台规范", async function (this: ApiWorld) {
  const value = state(this); await prepare(value); await value.scenario.create(teamName);
});
Then("规范详情和本轮依据均显示团队层及全部语言", async function (this: ApiWorld) {
  const value = state(this);
  const response = await value.scenario.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(response.status, 200);
  assert.equal(response.body.rules[0]!.layer, "team"); assert.deepEqual(response.body.rules[0]!.languages, []);
  assert.equal(snapshot(value, teamName).layer, "team"); assert.deepEqual(snapshot(value, teamName).languages, []);
});

Given("支付仓库的 Git 规范包含 Go 语言规范、SQL 规范和非法层级声明", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  await value.scenario.prepareCatalog({
    ".agents/rules/go-cancellation.md": markdown(languageName, "language", ["go"]),
    ".agents/rules/sql-transaction.md": markdown(sqlName, "language", ["sql"]),
    ".agents/rules/legacy-lock.md": markdown(teamName, "company", []),
    ".agents/rules/unknown-language.md": markdown("未知语言规范", "language", ["unsupported-language"]),
  });
});
When("张伟同步规范目录并由李娜评审库存释放变更", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), catalog = value.scenario.catalog!;
  const response = await catalog.request(`/api/rules/repositories/${catalog.repositoryId}/sync`, {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const listed = await catalog.request<{ rules: CatalogEntry[]; sync: RuleSyncState[] }>(`/api/rules?repositoryId=${catalog.repositoryId}`);
  assert.equal(listed.status, 200); value.catalog = listed.body; await run(value);
});
Then("目录保留合法层级和语言且非法声明产生告警", function (this: ApiWorld) {
  const value = state(this), rules = value.catalog!.rules;
  const go = rules.find((entry) => entry.id === gitId("go-cancellation"))!;
  assert.equal(go.layer, "language"); assert.deepEqual(go.languages, ["go"]);
  assert.equal(rules.find((entry) => entry.id === gitId("legacy-lock"))?.layer, "team");
  const warnings = value.catalog!.sync.flatMap((entry) => entry.warnings).join("\n");
  assert.match(warnings, /legacy-lock/); assert.match(warnings, /unknown-language/);
});
Then("两个评审模型收到 Go 规范且没有收到 SQL 规范", function (this: ApiWorld) {
  const value = state(this);
  assertInjected(value, [`${languageName}的规范正文。`], [`${sqlName}的规范正文。`, "未知语言规范的规范正文。"]);
  assert.equal(value.review!.rules.find((entry) => entry.id === gitId("go-cancellation"))?.layer, "language");
  assert.ok(!value.review!.rules.some((entry) => entry.id === gitId("sql-transaction")));
});

Given("张伟准备生成一条 Go 并发规范", async function (this: ApiWorld) { await prepare(state(this)); });
When("张伟生成语言层草稿并改为团队层保存", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), response = await value.scenario.app.request<{ draft: GeneratedRuleDraft }>("/api/managed-rules/generate", { intent: "Go 并发任务响应取消信号。" });
  assert.equal(response.status, 200, JSON.stringify(response.body)); value.generated = response.body.draft;
  assert.deepEqual(value.generated, hierarchyDraft);
  await value.scenario.create(languageName, { ...value.generated, layer: "team" });
});
Then("保存的规范保留调整后的层级和 Go 适用语言", async function (this: ApiWorld) {
  const value = state(this), response = await value.scenario.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(response.status, 200); assert.equal(response.body.rules[0]?.layer, "team");
  assert.deepEqual(response.body.rules[0]?.languages, ["go"]); assert.equal(response.body.rules[0]?.body, hierarchyDraft.body);
});

Given("张伟已启用适用于库存释放文件的 Go 规范及覆盖它的团队规范", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  const base = await value.scenario.create(languageName, { layer: "language", languages: ["go"] });
  await value.scenario.create(teamName, { layer: "team", overrides: [managedId(base)], scope: "repositories",
    repositories: [{ repositoryId: value.scenario.repositoryId, paths: [releasePath] }] });
});
Then("两个评审模型只收到覆盖方正文", function (this: ApiWorld) {
  const value = state(this); assertInjected(value, [rule(value, teamName).body], [rule(value, languageName).body]);
});
Then("本轮依据记录语言规范被团队规范覆盖的文件", function (this: ApiWorld) {
  const value = state(this), base = snapshot(value, languageName), covering = snapshot(value, teamName);
  assert.equal(base.status, "overridden"); assert.deepEqual(base.matchedPaths, [releasePath]);
  assert.deepEqual(base.effectivePaths, []); assert.deepEqual(base.overriddenBy, [{ ruleId: covering.id, paths: [releasePath] }]);
  assert.equal(covering.status, "active"); assert.deepEqual(covering.overrides, [base.id]);
  assert.deepEqual(covering.effectivePaths, [releasePath]);
});

Given("张伟已保存原则、通用和语言层规范及一条合法覆盖关系", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  await value.scenario.create(principleName, { layer: "principle" });
  const general = await value.scenario.create(generalName, { layer: "general" });
  await value.scenario.create(languageName, { layer: "language", languages: ["go"], overrides: [managedId(general)] });
  value.originals = [...value.scenario.rules.values()];
});
When("张伟分别尝试覆盖原则、引用缺失规范和形成循环覆盖", async function (this: ApiWorld) {
  const value = state(this), app = value.scenario.app, language = rule(value, languageName), general = rule(value, generalName);
  value.rejectionStatuses = [];
  for (const attempt of [
    { id: language.id, input: { ...editable(language), overrides: [managedId(rule(value, principleName))] }, error: /覆盖只能/ },
    { id: language.id, input: { ...editable(language), overrides: [`managed:${randomUUID()}`] }, error: /覆盖目标不存在/ },
    { id: general.id, input: { ...editable(general), layer: "team", overrides: [managedId(language)] }, error: /已有覆盖关系失效|覆盖关系不能成环/ },
  ]) {
    const response = await app.request<{ error: { code: string; message: string } }>(`/api/managed-rules/${attempt.id}`, attempt.input, { method: "PUT" });
    assert.equal(response.body.error?.code, "invalid_input");
    assert.match(response.body.error.message, attempt.error);
    value.rejectionStatuses.push(response.status);
  }
});
Then("三次保存均被拒绝且原有规范内容与覆盖关系保持不变", async function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(value.rejectionStatuses, [400, 400, 400]);
  const response = await value.scenario.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rules.sort((left, right) => left.id.localeCompare(right.id)),
    value.originals!.sort((left, right) => left.id.localeCompare(right.id)));
});

Given("张伟管理支付和结算两个仓库且已启用一条全局库存规范", async function (this: ApiWorld) {
  const value = state(this); await prepare(value); value.otherRepository = await value.scenario.addRepository();
  await value.scenario.create(teamName, { layer: "team" });
});
When("张伟填写理由豁免支付仓库并分别评审两个仓库", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), scenario = value.scenario;
  const endpoint = `/api/managed-rules/${rule(value, teamName).id}/waivers/${scenario.repositoryId}`;
  assert.equal((await scenario.app.request(endpoint, { reason: "  " }, { method: "PUT" })).status, 400);
  const response = await scenario.app.request(endpoint, { reason: waiverReason }, { method: "PUT" });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  await run(value); value.oldReview = value.review!; value.requestEnd = scenario.model!.requests.length;
  value.otherReview = await scenario.review(value.otherRepository!.gitlab, value.otherRepository!.repositoryId);
});
Then("支付仓库依据记录豁免理由且模型没有收到该规范", function (this: ApiWorld) {
  const value = state(this), waived = snapshot(value, teamName);
  assert.equal(waived.status, "waived"); assert.equal(waived.waiver?.reason, waiverReason);
  assert.equal(waived.waiver?.createdBy, value.scenario.app.userId); assert.ok(waived.waiver?.createdAt);
  for (const model of ["fixture-generator", "fixture-grader"]) {
    assert.ok(!contexts(value, model).join("\n").includes(rule(value, teamName).body));
  }
});
Then("结算仓库仍使用该规范", function (this: ApiWorld) {
  const value = state(this), other = value.otherReview!.rules.find((entry) => entry.id === managedId(rule(value, teamName)));
  assert.equal(other?.status, "active"); assert.deepEqual(other?.effectivePaths, [releasePath]);
  const otherContext = { ...value, requestStart: value.requestEnd!, requestEnd: undefined };
  assertInjected(otherContext, [rule(value, teamName).body]);
});
When("张伟撤销支付仓库的豁免并重新评审", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), scenario = value.scenario;
  const response = await fetch(`${scenario.app.baseUrl}/api/managed-rules/${rule(value, teamName).id}/waivers/${scenario.repositoryId}`,
    { method: "DELETE", headers: { cookie: scenario.app.cookie, "x-ureview-request": "1" } });
  assert.equal(response.status, 200, await response.text()); await run(value);
});
Then("支付仓库恢复规范且原评审仍保留豁免依据", async function (this: ApiWorld) {
  const value = state(this); assert.equal(snapshot(value, teamName).status, "active");
  assertInjected(value, [rule(value, teamName).body]);
  const old = await value.scenario.app.request<{ review: ReviewDetail }>(`/api/reviews/${value.oldReview!.id}`);
  assert.equal(old.status, 200); assert.deepEqual(old.body.review, value.oldReview);
});
Then("豁免历史保留设置和撤销的操作人与时间", async function (this: ApiWorld) {
  const value = state(this), response = await value.scenario.app.request<{ waivers: Array<{
    reason: string; repositoryId: string; createdBy: string; createdAt: string; revokedBy: string | null; revokedAt: string | null;
  }> }>(`/api/managed-rules/${rule(value, teamName).id}/waivers`);
  assert.equal(response.status, 200); assert.equal(response.body.waivers.length, 1);
  const waiver = response.body.waivers[0]!;
  assert.equal(waiver.reason, waiverReason); assert.equal(waiver.repositoryId, value.scenario.repositoryId);
  assert.equal(waiver.createdBy, value.scenario.app.userId); assert.equal(waiver.revokedBy, value.scenario.app.userId);
  assert.ok(Number.isFinite(Date.parse(waiver.createdAt))); assert.ok(waiver.revokedAt);
  assert.ok(Date.parse(waiver.revokedAt) >= Date.parse(waiver.createdAt));
});

Given("支付仓库的 Git 团队规范覆盖 Go 规范并包含缺失目标及原则覆盖声明", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  await value.scenario.prepareCatalog({
    ".agents/rules/go-cancellation.md": markdown(languageName, "language", ["go"]),
    ".agents/rules/simple-design.md": markdown(principleName, "principle", []),
    ".agents/rules/team-lock.md": markdown(teamName, "team", ["go"],
      [gitId("go-cancellation"), gitId("missing-stock-policy"), gitId("simple-design")]),
  });
});
Then("目录保留合法覆盖关系并告警忽略缺失目标及原则覆盖", function (this: ApiWorld) {
  const value = state(this), covering = value.catalog!.rules.find((entry) => entry.id === gitId("team-lock"));
  assert.deepEqual(covering?.overrides, [gitId("go-cancellation")]);
  const warnings = value.catalog!.sync.flatMap((entry) => entry.warnings).join("\n");
  assert.match(warnings, /missing-stock-policy/); assert.match(warnings, /simple-design/);
});
Then("本轮仅注入 Git 覆盖方并在依据中记录被覆盖规范", function (this: ApiWorld) {
  const value = state(this);
  assertInjected(value, [`${teamName}的规范正文。`, `${principleName}的规范正文。`], [`${languageName}的规范正文。`]);
  const base = value.review!.rules.find((entry) => entry.id === gitId("go-cancellation"));
  const covering = value.review!.rules.find((entry) => entry.id === gitId("team-lock"));
  assert.ok(base); assert.ok(covering);
  const expectedPaths = [lockPath, releasePath].sort();
  const readPaths = (phase: "generator" | "grader") => [...new Set(value.review!.readFiles
    .filter((entry) => entry.phase === phase).map((entry) => entry.path))].sort();
  assert.deepEqual(readPaths("generator"), expectedPaths);
  assert.deepEqual(readPaths("grader"), [releasePath]);
  assert.equal(base.status, "overridden");
  assert.deepEqual([...base.matchedPaths].sort(), expectedPaths);
  assert.deepEqual(base.effectivePaths, []);
  assert.deepEqual(base.overriddenBy?.map((entry) => ({ ...entry, paths: [...entry.paths].sort() })),
    [{ ruleId: covering.id, paths: expectedPaths }]);
  assert.equal(covering.status, "active");
  assert.deepEqual([...covering.matchedPaths].sort(), expectedPaths);
  assert.deepEqual(covering.effectivePaths?.slice().sort(), expectedPaths);
  assert.deepEqual(covering.overriddenBy, []);
});

const judgementName = "可能的 Feature Envy";
function judgementScript(ruleId: string, ordinaryRuleId?: string, paths = [releasePath]) {
  const candidate = { ...finding(), title: judgementName, ruleId,
    description: "库存释放入口可能过多依赖订单对象的数据；已有 Strategy 分工时保留该设计。" };
  return [
    { name: "read", input: { file_path: releasePath, offset: 3, limit: 2 }, result: { isError: false } },
    { name: "report_finding", input: candidate, result: { isError: true, includes: "判断题" } },
    { name: "report_finding", input: { ...candidate, severity: "medium" }, result: { isError: false } },
    ...(ordinaryRuleId ? [{ name: "report_finding", input: { ...finding(), ruleId: ordinaryRuleId }, result: { isError: false } }] : []),
    { name: "report_file_groups", input: { fileGroups: makeMockFileGroups(paths) }, result: { isError: false } },
    { name: "finish_report", input: {}, result: { isError: false } },
  ];
}
function assertJudgementReport(review: ReviewDetail, ruleId: string) {
  const rejected = review.reportSubmissions.filter((submission) => submission.outcome === "rejected");
  assert.equal(rejected.length, 1); assert.match(rejected[0]!.reason ?? "", /判断题/);
  assert.match(rejected[0]!.reason ?? "", /中危/);
  assert.deepEqual(review.findings.filter((item) => item.ruleId === ruleId).map((item) => item.severity), ["medium"]);
  assert.equal(review.rules.find((entry) => entry.id === ruleId)?.judgement, true);
}
Given("张伟启用判断题规范和普通团队规范", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  await value.scenario.create(judgementName, { judgement: true, layer: "general", severity: "error" });
  await value.scenario.create(teamName);
  assert.equal(rule(value, teamName).judgement, false);
});
Given("本轮模型先以高危命中判断题再改为中危并报告普通规范高危结论", function (this: ApiWorld) {
  const value = state(this);
  value.scenario.options.generatorScript = judgementScript(managedId(rule(value, judgementName)), managedId(rule(value, teamName)));
});
Then("判断题高危提交留下纠错记录且最终只保留中危判断题和普通高危结论", function (this: ApiWorld) {
  const value = state(this), review = value.review!;
  assertJudgementReport(review, managedId(rule(value, judgementName)));
  assert.equal(review.findings.length, 2);
  assert.equal(review.findings.find((item) => item.ruleId === managedId(rule(value, teamName)))?.severity, "high");
});
Then("解读和两个评审模型收到判断题的表述与团队优先说明", function (this: ApiWorld) {
  const value = state(this);
  for (const toolName of ["submit_outline", "report_finding", "grade_finding"]) {
    const messages = value.scenario.model!.requests.slice(value.requestStart, value.requestEnd)
      .filter((request) => request.body.tools?.some((tool) => tool.name === toolName))
      .flatMap((request) => request.body.messages.flatMap((message) => typeof message.content === "string"
        ? [message.content] : message.content.filter((part) => part.type === "text").map((part) => part.text ?? "")));
    const text = messages.join("\n");
    assert.match(text, /可能的 X/); assert.match(text, /依据/); assert.match(text, /例外/);
    assert.match(text, /严重度最高为中危/); assert.match(text, /与团队规范冲突时以团队规范为准/);
    const injected = messages.filter((message) => message.includes("本次预先注入的团队规范：") || message.includes("<rule-context"));
    const id = value.scenario.rules.has(judgementName) ? managedId(rule(value, judgementName)) : gitId("feature-envy");
    assert.ok(injected.some((message) => message.includes(id) && message.includes(judgementName) &&
      (message.includes('"judgement":true') || message.includes('judgement="true"'))), `${toolName} 未收到带判断题属性的规范上下文`);
  }
});
When("张伟把判断题规范改为普通规范", async function (this: ApiWorld) {
  const value = state(this), before = rule(value, judgementName); value.oldReview = value.review!;
  const response = await value.scenario.app.request<{ rule: ManagedRule }>(`/api/managed-rules/${before.id}`,
    { ...editable(before), judgement: false }, { method: "PUT" });
  assert.equal(response.status, 200); value.scenario.rules.set(judgementName, response.body.rule);
});
Then("规范详情显示普通规范且原评审保留判断题依据", async function (this: ApiWorld) {
  const value = state(this), id = managedId(rule(value, judgementName));
  const detail = await value.scenario.app.request<{ rule: { judgement: boolean } }>(`/api/rules/${id}/detail`);
  assert.equal(detail.status, 200); assert.equal(detail.body.rule.judgement, false);
  const response = await value.scenario.app.request<{ review: ReviewDetail }>(`/api/reviews/${value.oldReview!.id}`);
  assert.equal(response.status, 200); assert.deepEqual(response.body.review, value.oldReview);
  assert.equal(response.body.review.rules.find((entry) => entry.id === id)?.judgement, true);
});
Given("支付仓库的 Git 规范声明判断题属性", async function (this: ApiWorld) {
  const value = state(this); await prepare(value);
  await value.scenario.prepareCatalog({
    ".agents/rules/feature-envy.md": `---\nname: ${judgementName}\nlayer: general\njudgement: true\npaths: ["internal/**/*.go"]\n---\n${judgementName}：检查函数依赖的数据归属与既有职责分工。\n`,
  });
  value.scenario.options.generatorScript = judgementScript(gitId("feature-envy"), undefined, [releasePath, ".agents/rules/feature-envy.md"]);
});
Then("Git 判断题属性保留在目录和评审依据且高危结论纠正为中危", function (this: ApiWorld) {
  const value = state(this), id = gitId("feature-envy");
  assert.equal(value.catalog!.rules.find((entry) => entry.id === id)?.judgement, true);
  assertJudgementReport(value.review!, id); assert.equal(value.review!.findings.length, 1);
});
