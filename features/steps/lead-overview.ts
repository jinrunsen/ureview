import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { TeamOverview } from "../../packages/server/src/team-overview/service.js";
import type { ReviewFinding } from "../../packages/server/src/reviews/types.js";
import { fixtureFinding, ReviewScenario } from "../support/review-scenario.js";
import type { ApiWorld } from "../support/world.js";

interface State { findings: ReviewFinding[]; ruleId: string; result?: TeamOverview }
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld) { const value = states.get(world); assert.ok(value); return value; }
async function load(world: ApiWorld) {
  const response = await world.review.request<TeamOverview>("/api/team-overview");
  assert.equal(response.status, 200); state(world).result = response.body;
}
async function dispose(world: ApiWorld, index: number, status: string, version = 0, reasonCategory?: string) {
  const item = state(world).findings[index]; assert.ok(item);
  const response = await world.review.request(`/api/reviews/${world.review.reviewId}/findings/${item.id}/disposition`,
    { status, version, ...(reasonCategory ? { reasonCategory } : {}) }, {}, "PATCH");
  assert.equal(response.status, 200);
}

Before({ tags: "@story:lead-overview", timeout: 60_000 }, async function (this: ApiWorld) {
  states.set(this, { findings: [], ruleId: "" });
  this.review = new ReviewScenario(); await this.review.start({ disposition: true });
});
After({ tags: "@story:lead-overview", timeout: 60_000 }, async function (this: ApiWorld) {
  try { if (this.review?.gitlab) assert.deepEqual(this.review.gitlab.state.writes, []); }
  finally { await this.review?.stop(); }
});

Given("库存团队的一轮评审展示三条高危和两条中危 finding", async function (this: ApiWorld) {
  const rule = await this.review.saveGlobalRule("库存释放约定", "恢复库存前必须取得订单锁，防止重复恢复。");
  state(this).ruleId = `managed:${rule.id}`;
  const titles = ["库存释放缺少锁", "库存释放遗漏幂等检查", "日志缺少订单号", "超时时间难以配置", "重复恢复库存"];
  this.review.modelOptions.candidates!.splice(0, Infinity, ...titles.map((title, index) => ({ ...structuredClone(fixtureFinding), title,
    severity: index === 2 || index === 3 ? "medium" as const : "high" as const, ...(index < 2 ? { ruleId: state(this).ruleId } : {}) })));
  await this.review.openPullRequest("李娜", "完善订单超时库存释放");
  const result = await this.review.waitForReview((review) => review.status === "completed");
  assert.equal(result.findings.length, 5);
  state(this).findings = titles.map((title) => { const found = result.findings.find((item) => item.title === title); assert.ok(found); return found; });
});
Given("张伟采纳其中两条并以误报和规范不适用分别驳回一条", async function (this: ApiWorld) {
  await dispose(this, 0, "Resolved"); await dispose(this, 4, "Resolved");
  await dispose(this, 1, "Dismissed", 0, "rule_not_applicable"); await dispose(this, 2, "Dismissed", 0, "false_positive");
});
When("张伟查看团队概览", async function (this: ApiWorld) { await load(this); });
Then("最近四周有一轮评审、三条展示的高危和两条展示的中危", function (this: ApiWorld) {
  const result = state(this).result; assert.ok(result);
  assert.equal(result.reviewRounds, 1); assert.equal(result.findings.high, 3); assert.equal(result.findings.medium, 2);
  assert.equal(Date.parse(result.period.to) - Date.parse(result.period.from), 28 * 24 * 60 * 60 * 1000);
});
Then("采纳率为百分之五十，误报和规范不适用各有一条", function (this: ApiWorld) {
  const result = state(this).result; assert.ok(result); assert.equal(result.adoptionRate, 0.5);
  assert.equal(result.findings.resolved, 2); assert.equal(result.findings.dismissed, 2);
  assert.deepEqual(result.dismissalReasons.filter((item) => item.count > 0), [{ category: "false_positive", count: 1 }, { category: "rule_not_applicable", count: 1 }]);
});
Then("被驳回最多的规范包含库存释放约定且驳回一次", function (this: ApiWorld) {
  assert.deepEqual(state(this).result?.mostDismissedRules, [{ id: state(this).ruleId, name: "库存释放约定", repositoryId: null, repositoryName: null, count: 1 }]);
});
When("张伟撤回被误报驳回的 finding 并再次查看团队概览", async function (this: ApiWorld) {
  await dispose(this, 2, "Pending", 1); await load(this);
});
Then("采纳率按两条采纳与一条驳回计算，误报的驳回数为零", function (this: ApiWorld) {
  const result = state(this).result; assert.ok(result);
  assert.equal(result.findings.resolved, 2); assert.equal(result.findings.dismissed, 1); assert.equal(result.adoptionRate, 2 / 3);
  assert.equal(result.dismissalReasons.find((item) => item.category === "false_positive")?.count, 0);
});
