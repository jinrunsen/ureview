import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { InstanceHealth, OnboardingChecklist } from "../../packages/server/src/instance-health/types.js";
import { OnboardingHealthScenario } from "../support/onboarding-health-scenario.js";
import type { ApiWorld } from "../support/world.js";

interface State {
  app: OnboardingHealthScenario;
  onboarding?: OnboardingChecklist;
  health?: InstanceHealth;
  memberCookie?: string;
  teamAdminCookie?: string;
  statuses?: number[];
}
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State { const current = states.get(world); assert.ok(current); return current; }

Before({ tags: "@layer:api and @story:onboarding-and-health", timeout: 60_000 }, async function (this: ApiWorld) {
  const app = new OnboardingHealthScenario();
  states.set(this, { app });
  await app.start();
});
After({ tags: "@layer:api and @story:onboarding-and-health", timeout: 60_000 }, async function (this: ApiWorld) {
  await states.get(this)?.app.stop();
  states.delete(this);
});

async function loadOnboarding(world: ApiWorld, cookie?: string): Promise<OnboardingChecklist> {
  const current = state(world);
  const response = await current.app.identity.request<{ onboarding: OnboardingChecklist }>("/api/onboarding", undefined,
    cookie === undefined ? {} : { cookie });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  current.onboarding = response.body.onboarding;
  return current.onboarding;
}
function assertSteps(onboarding: OnboardingChecklist, expected: boolean[]): void {
  assert.deepEqual(onboarding.steps.map((step) => step.id), ["models", "repository", "webhook", "rules", "review"]);
  assert.deepEqual(onboarding.steps.map((step) => step.completed), expected);
  assert.equal(onboarding.completed, expected.every(Boolean));
}

Given("张伟是尚未配置模型和接入仓库的团队管理员", async function (this: ApiWorld) {
  const response = await state(this).app.identity.request<{ settings: { generator: { configured: boolean }; grader: { configured: boolean } } }>("/api/service-settings");
  assert.equal(response.status, 200);
  assert.equal(response.body.settings.generator.configured, false);
  assert.equal(response.body.settings.grader.configured, false);
});
When("张伟查看首次使用引导", async function (this: ApiWorld) { await loadOnboarding(this); });
Then("引导的五个步骤均未完成", function (this: ApiWorld) {
  const onboarding = state(this).onboarding!;
  assertSteps(onboarding, [false, false, false, false, false]);
  assert.equal(onboarding.repositoryId, null);
  assert.equal(onboarding.canManageModels, true);
});
When("张伟只保存生成模型的完整配置", async function (this: ApiWorld) { await state(this).app.saveModel("generator"); });
Then("引导的模型步骤仍未完成", async function (this: ApiWorld) {
  assertSteps(await loadOnboarding(this), [false, false, false, false, false]);
});
When("张伟补齐评分模型并接入库存服务仓库", async function (this: ApiWorld) {
  const { app } = state(this); await app.saveModel("grader"); await app.connectRepository();
});
Then("引导仅完成模型和仓库两个步骤", async function (this: ApiWorld) {
  const onboarding = await loadOnboarding(this);
  assertSteps(onboarding, [true, true, false, false, false]);
  assert.equal(onboarding.repositoryId, state(this).app.repositoryId);
});
When("库存服务收到未通过鉴权的事件", async function (this: ApiWorld) { await state(this).app.event(false); });
Then("引导的 webhook 步骤仍未完成", async function (this: ApiWorld) {
  assertSteps(await loadOnboarding(this), [true, true, false, false, false]);
});
When("库存服务收到通过鉴权的事件", async function (this: ApiWorld) { await state(this).app.event(true); });
Given("团队已有 lint 配置、一条规范草稿和一轮失败的评审", async function (this: ApiWorld) {
  const { app } = state(this);
  await app.seedLint();
  await app.seedRule("draft");
  await app.seedReview({ status: "failed", failureCode: "llm_unavailable" });
});
Then("引导完成模型仓库和 webhook，规范与评审仍未完成", async function (this: ApiWorld) {
  assertSteps(await loadOnboarding(this), [true, true, true, false, false]);
});
When("团队启用库存规范并取得一轮完成的评审", async function (this: ApiWorld) {
  const { app } = state(this); await app.activateRule(); await app.seedReview({ status: "completed" });
});
Then("引导五步全部完成并且不再需要展示", async function (this: ApiWorld) {
  assertSteps(await loadOnboarding(this), [true, true, true, true, true]);
});
Given("实例通过环境变量配置了生成模型和评分模型", function (this: ApiWorld) { state(this).app.configureEnvironment(); });
Then("引导仅完成模型步骤", async function (this: ApiWorld) {
  assertSteps(await loadOnboarding(this), [true, false, false, false, false]);
});
Given("默认团队已完成引导的全部五步", async function (this: ApiWorld) {
  await state(this).app.completeOnboarding();
  assertSteps(await loadOnboarding(this), [true, true, true, true, true]);
});
When("张伟切换到尚未接入仓库的支付研发团队并查看引导", async function (this: ApiWorld) {
  await state(this).app.switchToNewTeam(); await loadOnboarding(this);
});
Given("李娜是默认团队的普通成员", async function (this: ApiWorld) {
  const current = state(this);
  current.memberCookie = await current.app.addMember("李娜", "li.na", "member");
});
When("李娜尝试查看首次使用引导", async function (this: ApiWorld) {
  const current = state(this);
  current.statuses = [(await current.app.identity.request("/api/onboarding", undefined, { cookie: current.memberCookie! })).status];
});
Then("工作台提示引导需要团队管理员权限", function (this: ApiWorld) { assert.deepEqual(state(this).statuses, [403]); });

Given("两个团队存在最近七天和更早的已完成失败及排队评审", async function (this: ApiWorld) {
  const { app } = state(this);
  await app.saveModel("generator"); await app.saveModel("grader"); await app.connectRepository();
  await app.seedReview({ status: "completed", generatorModel: "deepseek-chat", generatorRejected: 2, duplicateGeneratorSession: true });
  await app.seedReview({ status: "completed", generatorModel: "deepseek-chat", generatorRejected: 1 });
  await app.seedReview({ status: "failed", failureCode: "llm_unavailable", generatorModel: "deepseek-chat", generatorRejected: 1, graderRejected: 2 });
  await app.seedReview({ status: "failed", failureCode: "invalid_output", generatorModel: "qwen-review", generatorRejected: 3, graderRejected: 1 });
  await app.seedReview({ status: "failed", failureCode: "llm_unavailable", generatorModel: "deepseek-chat", ageMinutes: 9 * 24 * 60, generatorRejected: 99, graderRejected: 99 });
  await app.seedReview({ status: "queued", ageMinutes: 120 });
  await app.seedReview({ status: "queued", ageMinutes: 5 });
  await app.seedReview({ status: "running", ageMinutes: 20, generatorModel: "deepseek-chat" });
  await app.switchToNewTeam(); await app.connectRepository();
  await app.seedReview({ status: "completed", generatorModel: "deepseek-chat", graderRejected: 2 });
  await app.seedReview({ status: "failed", failureCode: "llm_unavailable", generatorModel: "qwen-review", generatorRejected: 1, graderRejected: 1 });
});
When("张伟查看实例健康", async function (this: ApiWorld) {
  const current = state(this);
  const response = await current.app.identity.request<{ health: InstanceHealth }>("/api/instance-health");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  current.health = response.body.health;
});
Then("队列有两轮等待和一轮进行中且最早等待约两小时", function (this: ApiWorld) {
  const queue = state(this).health!.queue;
  assert.equal(queue.queued, 2); assert.equal(queue.running, 1);
  assert.ok(queue.oldestQueuedAt && Number.isFinite(Date.parse(queue.oldestQueuedAt)));
  assert.ok(queue.oldestWaitSeconds !== null && queue.oldestWaitSeconds >= 7200 && queue.oldestWaitSeconds < 7260,
    `最早等待时长为 ${queue.oldestWaitSeconds} 秒`);
});
Then("最近七天失败按错误码分为模型不可用两轮与评审产出无效一轮", function (this: ApiWorld) {
  const health = state(this).health!;
  assert.equal(Date.parse(health.period.to) - Date.parse(health.period.from), 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(health.failures.map(({ code, count }) => ({ code, count })).sort((left, right) => left.code.localeCompare(right.code)),
    [{ code: "invalid_output", count: 1 }, { code: "llm_unavailable", count: 2 }]);
});
Then("失败分组可以找到对应团队的具体评审轮次", function (this: ApiWorld) {
  const current = state(this);
  const reviews = current.health!.failures.flatMap((group) => group.reviews.map((review) => ({ ...review, code: group.code })));
  assert.deepEqual(reviews.map((review) => review.id).sort(), [...current.app.expectedFailures.keys()].sort());
  for (const review of reviews) {
    const expected = current.app.expectedFailures.get(review.id)!;
    assert.equal(review.code, expected.code); assert.equal(review.teamId, expected.teamId);
    assert.equal(review.title, expected.title); assert.equal(review.iid, expected.iid);
    assert.equal(review.round, 1); assert.equal(review.repositoryName, "commerce/inventory-service");
    assert.ok(review.teamName); assert.ok(Number.isFinite(Date.parse(review.completedAt)));
  }
});
Then("两个生成模型的完成率分别为百分之七十五和百分之零", function (this: ApiWorld) {
  const metrics = state(this).health!.modelMetrics.filter((metric) => metric.phase === "generator");
  assert.equal(metrics.length, 2);
  const primary = metrics.find((metric) => metric.model === "deepseek-chat")!;
  const secondary = metrics.find((metric) => metric.model === "qwen-review")!;
  assert.deepEqual({ total: primary.total, completed: primary.completed, failed: primary.failed, rate: primary.completionRate },
    { total: 4, completed: 3, failed: 1, rate: 0.75 });
  assert.deepEqual({ total: secondary.total, completed: secondary.completed, failed: secondary.failed, rate: secondary.completionRate },
    { total: 2, completed: 0, failed: 2, rate: 0 });
});
Then("按生成与评分阶段计算的平均被拒提交次数与记录一致", function (this: ApiWorld) {
  const metrics = state(this).health!.modelMetrics;
  assert.equal(metrics.length, 3);
  const expected = [
    { phase: "generator", provider: "ureview-generator", model: "deepseek-chat", average: 1 },
    { phase: "generator", provider: "ureview-generator", model: "qwen-review", average: 2 },
    { phase: "grader", provider: "ureview-grader", model: "claude-sonnet", average: 1 },
  ];
  for (const entry of expected) {
    const actual = metrics.find((metric) => metric.phase === entry.phase && metric.model === entry.model);
    assert.ok(actual); assert.equal(actual.provider, entry.provider); assert.equal(actual.averageRejectedSubmissions, entry.average);
  }
  const grader = metrics.find((metric) => metric.phase === "grader")!;
  assert.equal(grader.total, 6); assert.equal(grader.completed, 3); assert.equal(grader.failed, 3); assert.equal(grader.completionRate, 0.5);
});
Then("健康信息包含模型配置来源和应用运行时及迁移版本", function (this: ApiWorld) {
  const health = state(this).health!;
  assert.deepEqual(health.models.map(({ phase, configured, source, model }) => ({ phase, configured, source, model })), [
    { phase: "generator", configured: true, source: "database", model: "deepseek-chat" },
    { phase: "grader", configured: true, source: "database", model: "claude-sonnet" },
  ]);
  for (const model of health.models) {
    assert.ok(model.lastSuccessAt === null || Number.isFinite(Date.parse(model.lastSuccessAt)));
    assert.ok(model.lastFailure === null || (Number.isFinite(Date.parse(model.lastFailure.at)) && model.lastFailure.code));
  }
  assert.ok(health.versions.ureview); assert.ok(health.versions.dsh);
  assert.equal(health.versions.migration, "0036_enterprise_sso.sql");
  assert.ok(!JSON.stringify(health).includes("sk-fixture"));
});
Given("李娜是没有服务权限的团队管理员而陈晨是普通成员", async function (this: ApiWorld) {
  const current = state(this);
  current.teamAdminCookie = await current.app.addMember("李娜", "li.na", "admin");
  current.memberCookie = await current.app.addMember("陈晨", "chen.chen", "member");
});
When("李娜和陈晨分别尝试查看实例健康", async function (this: ApiWorld) {
  const current = state(this);
  current.statuses = [];
  for (const cookie of [current.teamAdminCookie!, current.memberCookie!]) {
    current.statuses.push((await current.app.identity.request("/api/instance-health", undefined, { cookie })).status);
  }
});
Then("两人都被提示需要服务管理员权限", function (this: ApiWorld) { assert.deepEqual(state(this).statuses, [403, 403]); });
Then("未登录访问实例健康时需要先登录", async function (this: ApiWorld) {
  assert.equal((await state(this).app.identity.request("/api/instance-health", undefined, { cookie: "" })).status, 401);
});
When("李娜查看首次使用引导", async function (this: ApiWorld) { await loadOnboarding(this, state(this).teamAdminCookie!); });
Then("模型步骤提示请联系服务管理员", function (this: ApiWorld) {
  const onboarding = state(this).onboarding!;
  assert.equal(onboarding.canManageModels, false);
  assert.equal(onboarding.steps.find((step) => step.id === "models")?.completed, false);
});
