import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { ManagedRuleScenario } from "../../packages/server/src/rules/managed/test-support.js";
import type { GeneratedRuleDraft, ManagedRule, ManagedRuleInput } from "../../packages/server/src/rules/managed-types.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer, type MockModelOptions } from "../../packages/server/src/runtime/test-support.js";
import { GitLabPlatform } from "../../packages/server/src/platform/gitlab.js";
import { withTeam } from "../../packages/server/src/db/tenant.js";
import { fixturePassword } from "../support/identity-scenario.js";
import { startReviewGitLab, releasePath } from "../support/review-gitlab-fixture.js";
import { fixtureFinding } from "../support/review-scenario.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";
import type { RuleDetail } from "../../packages/server/src/rules/detail.js";

const draft: GeneratedRuleDraft = { judgement: false, layer: "team", languages: [], name: "流处理循环限制调试日志", body: "数据流处理的逐条循环中不得直接输出调试日志，应使用采样或聚合统计。",
  goodExample: "if (sampled) logger.debug(summary);", badExample: "for (const item of stream) logger.debug(item);", category: "observability", severity: "warning" };
const input = (rule: GeneratedRuleDraft): ManagedRuleInput => ({ judgement: rule.judgement, layer: rule.layer, languages: rule.languages, overrides: [], name: rule.name, body: rule.body, goodExample: rule.goodExample,
  badExample: rule.badExample, category: rule.category, severity: rule.severity, scope: "global", repositories: [], status: "draft" });
const editable = (rule: ManagedRule): ManagedRuleInput => ({ ...input(rule), scope: rule.scope, repositories: rule.repositories, status: rule.status });
interface State {
  app: ManagedRuleScenario; directory: string; modelOptions: MockModelOptions;
  host?: Awaited<ReturnType<typeof bootReviewHost>>; model?: Awaited<ReturnType<typeof startMockModelServer>>;
  gitlab?: Awaited<ReturnType<typeof startReviewGitLab>>; repositoryId?: string;
  generated?: GeneratedRuleDraft; rule?: ManagedRule; previous?: ManagedRule; global?: ManagedRule;
  response?: { status: number; body: unknown }; memberRead?: ManagedRule[]; statuses?: number[];
  otherCookie?: string; editorCookie?: string; originalReview?: ReviewDetail; latestReview?: ReviewDetail;
}
const states = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => { const value = states.get(world); assert.ok(value); return value; };
Before({ tags: "@layer:api and @story:managed-rules", timeout: 60_000 }, async function (this: ApiWorld) {
  const directory = await mkdtemp(join(tmpdir(), "ureview-managed-bdd-"));
  const value: State = { app: new ManagedRuleScenario(), directory, modelOptions: { ruleDraft: draft, path: releasePath,
    startLine: 3, endLine: 4, grepPattern: "ReleaseInventory", candidates: [] } };
  states.set(this, value);
  value.gitlab = await startReviewGitLab(join(directory, "gitlab"));
  value.model = await startMockModelServer(value.modelOptions);
  value.host = await bootReviewHost({ homeDir: join(directory, "dsh"), models: value.model.models,
    onReady: async (runtime, generator) => {
      await value.app.start({ runtime, generator: generator.generate.bind(generator), worktreeDir: join(directory, "worktrees"),
        platforms: (repository) => new GitLabPlatform(repository) });
      return () => value.app.stop();
    } });
});
After({ tags: "@layer:api and @story:managed-rules", timeout: 60_000 }, async function (this: ApiWorld) {
  const value = states.get(this); if (!value) return;
  const errors: unknown[] = [];
  for (const close of [() => value.host ? value.host.dispose() : value.app.stop(), () => value.model?.dispose(),
    () => value.gitlab?.dispose(), () => rm(value.directory, { recursive: true, force: true })]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  states.delete(this); if (errors.length) throw new AggregateError(errors, "规则场景清理失败");
});
async function create(value: State, content: ManagedRuleInput = input(draft)): Promise<ManagedRule> {
  const response = await value.app.request<{ rule: ManagedRule }>("/api/managed-rules", content);
  assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.rule;
}
async function read(value: State, cookie?: string): Promise<ManagedRule[]> {
  const response = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules", undefined, cookie ? { cookie } : {});
  assert.equal(response.status, 200); return response.body.rules;
}
async function connect(value: State) {
  if (value.repositoryId) return;
  const response = await value.app.request<{ repository: { id: string } }>("/api/repositories", value.gitlab!.input);
  assert.equal(response.status, 201); value.repositoryId = response.body.repository.id;
}
Given("张伟已登录并管理支付服务仓库", async function (this: ApiWorld) { await connect(state(this)); });
When("张伟描述禁止在数据流处理循环中输出调试日志并生成规范", async function (this: ApiWorld) {
  const value = state(this); const response = await value.app.request<{ draft: GeneratedRuleDraft }>("/api/managed-rules/generate", { intent: "限制 debug 日志在数据流处理循环中输出，使用采样或聚合统计。" });
  assert.equal(response.status, 200, JSON.stringify(response.body)); value.generated = response.body.draft;
});
Then("张伟获得包含正文、正反例、分类和严重级别的草稿", function (this: ApiWorld) { assert.deepEqual(state(this).generated, draft); });
Then("团队规范列表尚未出现这条未保存的草稿", async function (this: ApiWorld) { assert.deepEqual(await read(state(this)), []); });
When("张伟将草稿设为性能分类和警告级别并保存", async function (this: ApiWorld) {
  const value = state(this); assert.ok(value.generated); value.rule = await create(value, { ...input(value.generated), category: "performance", severity: "warning" });
});
Then("重新查看时仍能读到完整草稿及其属性", async function (this: ApiWorld) {
  const value = state(this); const rules = await read(value); assert.equal(rules.length, 1); assert.deepEqual(rules[0], value.rule);
  assert.equal(rules[0]?.status, "draft"); assert.equal(rules[0]?.category, "performance"); assert.equal(rules[0]?.severity, "warning");
});
When("张伟确认启用这条规范", async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!; const result = await value.app.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}`,
    { ...editable(rule), status: "active", version: rule.version }, { method: "PUT" });
  assert.equal(result.status, 200); value.rule = result.body.rule;
});
Then("团队规范列表显示该规范已启用", async function (this: ApiWorld) { assert.equal((await read(state(this)))[0]?.status, "active"); });
Given("规范生成模型暂时不可用", function (this: ApiWorld) { state(this).modelOptions.ruleGenerationMode = "error"; });
When("张伟尝试生成一条数据流日志规范", async function (this: ApiWorld) {
  const value = state(this); value.response = await value.app.request("/api/managed-rules/generate", { intent: draft.body });
});
Then("张伟看到明确的生成失败提示", function (this: ApiWorld) {
  const response = state(this).response!; assert.equal(response.status, 502); assert.match(JSON.stringify(response.body), /生成失败/); assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE_MODEL_ERROR_SENTINEL/);
});
Then("团队规范列表没有新增条目", async function (this: ApiWorld) { assert.deepEqual(await read(state(this)), []); });
Given("张伟已保存一条全局日志规范且李娜是普通成员", async function (this: ApiWorld) { const value = state(this); value.rule = await create(value); });
When("李娜阅读该规范并尝试生成、修改和删除规范", async function (this: ApiWorld) {
  const value = state(this), cookie = value.app.memberCookie, rule = value.rule!;
  value.memberRead = await read(value, cookie);
  value.statuses = [(await value.app.request("/api/managed-rules/generate", { intent: draft.body }, { cookie })).status,
    (await value.app.request(`/api/managed-rules/${rule.id}`, { ...editable(rule), status: "active", version: rule.version }, { method: "PUT", cookie })).status,
    (await value.app.request(`/api/managed-rules/${rule.id}`, { version: rule.version }, { method: "DELETE", cookie })).status];
});
Then("李娜能读到规范正文", function (this: ApiWorld) { assert.equal(state(this).memberRead?.[0]?.body, draft.body); });
Then("工作台提示规范维护需要管理员权限", async function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(value.statuses, [403, 403, 403]);
  assert.deepEqual(await read(value), [value.rule]);
});
Given("张伟已在默认团队保存一条全局日志规范", async function (this: ApiWorld) {
  const value = state(this); value.rule = await create(value, { ...input(draft), status: "active" });
});
When("张伟切换到库存研发团队", async function (this: ApiWorld) {
  const value = state(this); const team = await value.app.request<{ id: string }>("/api/admin/teams", { name: "库存研发" }); assert.equal(team.status, 201);
  const login = await value.app.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" });
  assert.equal(login.status, 200); value.otherCookie = login.cookie;
  assert.equal((await value.app.request("/api/auth/team", { teamId: team.body.id }, { cookie: login.cookie })).status, 200);
});
Then("库存研发团队看不到默认团队的规范", async function (this: ApiWorld) { const value = state(this); assert.deepEqual(await read(value, value.otherCookie), []); });
Then("张伟不能将默认团队的仓库绑定到库存研发的规范", async function (this: ApiWorld) {
  const value = state(this); const response = await value.app.request("/api/managed-rules", { ...input(draft), scope: "repositories", repositories: [{ repositoryId: value.app.repositoryId, paths: [] }] }, { cookie: value.otherCookie! });
  assert.equal(response.status, 404); assert.deepEqual(await read(value, value.otherCookie), []);
});
Then("张伟不能从库存研发团队删除默认团队的规范", async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!;
  const response = await value.app.request(`/api/managed-rules/${rule.id}`, { version: rule.version }, { method: "DELETE", cookie: value.otherCookie! });
  assert.equal(response.status, 404); assert.deepEqual(await read(value), [rule]);
});
Given("张伟和王敏打开了同一版本的日志规范", async function (this: ApiWorld) {
  const value = state(this); value.rule = await create(value); value.previous = structuredClone(value.rule);
  assert.equal((await value.app.request("/api/admin/members", { name: "王敏", username: "wang.min", email: "wang.min@example.test", password: fixturePassword, role: "admin" })).status, 201);
  const login = await value.app.request("/api/auth/login", { username: "wang.min", password: fixturePassword }, { cookie: "" });
  assert.equal(login.status, 200); value.editorCookie = login.cookie;
  assert.deepEqual((await read(value, login.cookie))[0], value.previous);
});
When("张伟先将严重级别改为错误并保存", async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!; const result = await value.app.request<{ rule: ManagedRule }>(`/api/managed-rules/${rule.id}`, { ...editable(rule), severity: "error", version: rule.version }, { method: "PUT" });
  assert.equal(result.status, 200); value.rule = result.body.rule;
});
When("王敏随后使用打开时的版本保存旧内容", async function (this: ApiWorld) {
  const value = state(this), rule = value.previous!; value.response = await value.app.request(`/api/managed-rules/${rule.id}`, { ...editable(rule), version: rule.version }, { method: "PUT", cookie: value.editorCookie! });
});
Then("王敏收到规范已被更新的提示", function (this: ApiWorld) { assert.equal(state(this).response?.status, 409); assert.match(JSON.stringify(state(this).response?.body), /规范已(?:被.*)?更新/); });
Then("重新查看时规范保持张伟保存的内容和严重级别", async function (this: ApiWorld) {
  const value = state(this); assert.deepEqual((await read(value))[0], value.rule); assert.equal(value.rule?.severity, "error"); assert.equal(value.rule?.version, 2);
});
Given("支付仓库有一条仅适用于库存释放路径的已启用错误规范", async function (this: ApiWorld) {
  const value = state(this); await connect(value);
  value.rule = await create(value, { ...input(draft), name: "库存释放必须持有订单锁", body: "库存释放前必须获取订单级锁，防止重复恢复库存。", category: "reliability", severity: "error",
    scope: "repositories", repositories: [{ repositoryId: value.repositoryId!, paths: [releasePath] }], status: "active" });
});
Given("同团队另有全局警告规范和未启用的日志草稿", async function (this: ApiWorld) {
  const value = state(this); value.global = await create(value, { ...input(draft), status: "active" }); await create(value);
  await create(value, { ...input(draft), status: "active", scope: "repositories", repositories: [{ repositoryId: value.repositoryId!, paths: ["docs/**"] }] });
  await create(value, { ...input(draft), status: "active", scope: "repositories", repositories: [{ repositoryId: value.app.repositoryId, paths: [] }] });
  value.modelOptions.candidates!.splice(0, 0, { ...fixtureFinding, severity: "low", ruleId: `managed:${value.rule!.id}` },
    { ...fixtureFinding, title: "释放日志应采样", severity: "high", ruleId: `managed:${value.global.id}` });
});
async function runReview(value: State) {
  const result = await value.app.request<{ id: string }>("/api/reviews", { url: `${value.gitlab!.baseUrl}/${value.gitlab!.repositoryPath}/-/merge_requests/7`, requestId: randomUUID() }, { cookie: value.app.memberCookie });
  assert.equal(result.status, 202, JSON.stringify(result.body));
  assert.equal(await withTeam(value.app.teamId, () => value.app.reviews.runOnce()), true);
  const response = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${result.body.id}`);
  assert.equal(response.status, 200); assert.equal(response.body.review.status, "completed", response.body.review.failureReason ?? "评审未完成"); return response.body.review;
}
When("李娜发起包含库存释放变更的评审", { timeout: 60_000 }, async function (this: ApiWorld) { const value = state(this); value.originalReview = await runReview(value); });
Then("本轮依据包含适用的已启用规范及其版本", function (this: ApiWorld) {
  const value = state(this), rules = value.originalReview!.rules; assert.equal(rules.length, 2);
  assert.deepEqual(new Set(rules.map((rule) => rule.id)), new Set([`managed:${value.rule!.id}`, `managed:${value.global!.id}`]));
  assert.ok(rules.every((rule) => rule.file.kind === "database" && rule.file.version === 1));
  assert.deepEqual(rules.find((rule) => rule.id === `managed:${value.rule!.id}`)?.matchedPaths, [releasePath]);
});
Then("规范违规结论采用管理员指定的分类和严重级别", function (this: ApiWorld) {
  const value = state(this), findings = value.originalReview!.findings; assert.equal(findings.length, 2);
  const required = findings.find((finding) => finding.ruleId === `managed:${value.rule!.id}`)!;
  assert.equal(required.severity, "high"); assert.equal(required.ruleCategory, "reliability"); assert.equal(required.ruleSeverity, "error");
  const warning = findings.find((finding) => finding.ruleId === `managed:${value.global!.id}`)!;
  assert.equal(warning.severity, "medium"); assert.equal(warning.ruleCategory, "observability"); assert.equal(warning.ruleSeverity, "warning");
});
When("张伟修改并停用库存释放规范后重新评审", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!; const response = await value.app.request(`/api/managed-rules/${rule.id}`,
    { ...editable(rule), body: "使用事务内的行锁保护库存释放。", status: "draft", severity: "recommendation", version: rule.version }, { method: "PUT" });
  assert.equal(response.status, 200); value.modelOptions.candidates!.splice(0, 1); value.latestReview = await runReview(value);
});
Then("新评审不再使用停用规范", function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(value.latestReview!.rules.map((rule) => rule.id), [`managed:${value.global!.id}`]);
});
Then("原评审仍保留修改前的规范正文与属性", async function (this: ApiWorld) {
  const value = state(this); const response = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${value.originalReview!.id}`);
  assert.equal(response.status, 200); assert.deepEqual(response.body.review, value.originalReview);
  assert.ok(value.gitlab!.requests.filter((entry) => entry.path.startsWith("/api/")).every((entry) => entry.method === "GET"), "规则生成和应用不向代码平台写入");
});

When("张伟删除库存释放规范后重新评审", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!;
  const response = await value.app.request(`/api/managed-rules/${rule.id}`, { version: rule.version }, { method: "DELETE" });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assert.deepEqual(response.body, { deleted: true });
  value.modelOptions.candidates!.splice(0, 1); value.latestReview = await runReview(value);
});
Then("团队规范列表和新评审均不再包含已删除规范", async function (this: ApiWorld) {
  const value = state(this);
  assert.ok((await read(value)).every((rule) => rule.id !== value.rule!.id));
  assert.deepEqual(value.latestReview!.rules.map((rule) => rule.id), [`managed:${value.global!.id}`]);
});
Then("原评审仍保留删除前的规范正文与属性", async function (this: ApiWorld) {
  const value = state(this);
  const response = await value.app.request<{ review: ReviewDetail }>(`/api/reviews/${value.originalReview!.id}`);
  assert.equal(response.status, 200); assert.deepEqual(response.body.review, value.originalReview);
});
Then("历史规范详情仍可查看评审快照和执行记录", async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!;
  const response = await value.app.request<RuleDetail>(`/api/rules/managed:${rule.id}/detail?repositoryId=${value.repositoryId}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.rule.status, "snapshot"); assert.equal(response.body.rule.managedRule, undefined);
  assert.equal(response.body.rule.body, rule.body); assert.equal(response.body.rule.version, rule.version);
  assert.ok(response.body.records.some((record) => record.reviewId === value.originalReview!.id && record.ruleVersion === rule.version));
});
Given("张伟已应用 Go 规范库的错误处理条目", async function (this: ApiWorld) {
  const value = state(this);
  const response = await value.app.request<{ rules: ManagedRule[]; created: number }>("/api/rule-library/go-guidelines/apply", { entryIds: ["go-guidelines-check-errors"] });
  assert.equal(response.status, 200); assert.equal(response.body.created, 1); value.rule = response.body.rules[0]!;
});
When("张伟删除这条规范库规则", async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!;
  const response = await value.app.request(`/api/managed-rules/${rule.id}`, { version: rule.version }, { method: "DELETE" });
  assert.equal(response.status, 200, JSON.stringify(response.body)); assert.deepEqual(await read(value), []);
});
Then("规范库条目恢复为未应用", async function (this: ApiWorld) {
  const value = state(this);
  const response = await value.app.readLibrary();
  assert.equal(response.status, 200);
  const entry = response.body.sets.find((set) => set.id === "go-guidelines")!.entries.find((entry) => entry.id === "go-guidelines-check-errors")!;
  assert.equal(entry.appliedRuleId, null); assert.equal(entry.appliedVersion, null);
});
When("张伟重新应用该规范库条目", async function (this: ApiWorld) {
  const value = state(this); value.previous = value.rule!;
  const response = await value.app.request<{ rules: ManagedRule[]; created: number }>("/api/rule-library/go-guidelines/apply", { entryIds: ["go-guidelines-check-errors"] });
  assert.equal(response.status, 200); assert.equal(response.body.created, 1); value.rule = response.body.rules[0]!;
});
Then("团队得到一条新的已启用规范", async function (this: ApiWorld) {
  const value = state(this), rule = value.rule!;
  assert.notEqual(rule.id, value.previous!.id); assert.equal(rule.status, "active"); assert.equal(rule.version, 1);
  assert.equal(rule.librarySource?.entryId, "go-guidelines-check-errors"); assert.deepEqual(await read(value), [rule]);
});
When("王敏使用打开时的版本删除规范", async function (this: ApiWorld) {
  const value = state(this), rule = value.previous!;
  value.response = await value.app.request(`/api/managed-rules/${rule.id}`, { version: rule.version }, { method: "DELETE", cookie: value.editorCookie! });
});
