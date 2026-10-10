import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { AgentSessionPage } from "../../packages/server/src/agent-sessions/types.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";
import { makeMockFileGroups } from "../../packages/server/src/runtime/test-support.js";
import { AgentSessionsScenario } from "../support/agent-sessions-scenario.js";
import type { ApiWorld } from "../support/world.js";

interface State {
  app: AgentSessionsScenario;
  reviewId?: string;
  review?: ReviewDetail;
}

const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State {
  const value = states.get(world);
  assert.ok(value);
  return value;
}

const paymentFinding = {
  title: "扣款入口未校验正金额", description: "负金额可以进入扣款计算。", severity: "high",
  location: { path: "src/payment.ts", startLine: 1, endLine: 3 },
  evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口缺少金额校验" }],
  fixPrompt: "拒绝非正金额并补充负金额的回归用例。",
};
const deductionFinding = {
  ...paymentFinding, title: "扣款结果额外减去一分", description: "扣款结果包含未声明的一分减项。",
  fixPrompt: "去除未声明的一分减项，并检查金额计算结果。",
};

Before({ tags: "@story:keep-review-results and @layer:api", timeout: 60_000 }, async function (this: ApiWorld) {
  const app = new AgentSessionsScenario();
  states.set(this, { app });
  await app.start();
});
After({ tags: "@story:keep-review-results and @layer:api", timeout: 60_000 }, async function (this: ApiWorld) {
  await states.get(this)?.app.stop();
  states.delete(this);
});

Given("张伟已接入库存服务准备检查扣款变更", function (this: ApiWorld) {
  assert.ok(state(this).app.repositoryId);
});
Given("本轮结论先后因未读证据和缺少修复提示被拒绝并得到修正", function (this: ApiWorld) {
  const { fixPrompt: _fixPrompt, ...incompleteFinding } = deductionFinding;
  state(this).app.modelOptions.generatorScript = [
    { name: "report_file_groups", input: { fileGroups: makeMockFileGroups() }, result: { isError: false } },
    { name: "report_finding", input: paymentFinding, result: { isError: true, includes: "尚未读取" } },
    { name: "read", input: { file_path: "src/payment.ts", offset: 1, limit: 3 }, result: { isError: false } },
    { name: "report_finding", input: paymentFinding, result: { isError: false } },
    { name: "report_finding", input: incompleteFinding, result: { isError: true, includes: "fixPrompt" } },
    { name: "report_finding", input: deductionFinding, result: { isError: false } },
    { name: "finish_report", input: {}, result: { isError: false, includes: "已记录 2 条结论" } },
  ];
});
Given("本轮文件分组有效且模型放弃了未读证据的结论", function (this: ApiWorld) {
  state(this).app.modelOptions.generatorScript = [
    { name: "report_file_groups", input: { fileGroups: makeMockFileGroups() }, result: { isError: false } },
    { name: "report_finding", input: paymentFinding, result: { isError: true, includes: "尚未读取" } },
    { name: "finish_report", input: {}, result: { isError: false, includes: "已记录 0 条结论" } },
  ];
});
Given("本轮文件分组引用了变更以外的文件且模型未能修正", function (this: ApiWorld) {
  state(this).app.modelOptions.generatorScript = [
    { name: "report_file_groups", input: { fileGroups: makeMockFileGroups(["src/refund.ts"]) }, result: { isError: true, includes: "必须引用本次变更文件" } },
    { name: "finish_report", input: {}, result: { isError: true, includes: "缺少有效的文件分组" } },
  ];
});
When("张伟发起扣款变更评审并等待结束", async function (this: ApiWorld) {
  const s = state(this);
  s.reviewId = await s.app.review();
  s.review = await s.app.waitForReview(s.reviewId);
  assert.deepEqual(s.app.model!.scriptErrors, [], "模型应实际收到与脚本匹配的工具回执");
});
Then("评审已完成且保留文件分组与两条有效结论", function (this: ApiWorld) {
  const review = state(this).review!;
  assert.equal(review.status, "completed");
  assert.deepEqual(review.fileGroups, makeMockFileGroups());
  assert.deepEqual(review.findings.map((finding) => finding.title).sort(), [paymentFinding.title, deductionFinding.title].sort());
  assert.ok(review.findings.every((finding) => finding.score === 88 && finding.fixPrompt.trim()));
  assert.equal(new Set(review.findings.map((finding) => finding.id)).size, 2);
  assert.equal(review.reportSubmissions.filter((submission) => submission.tool === "report_finding" && submission.outcome === "accepted").length, 2);
});
Then("依据与追溯记录两次被拒绝的提交及原因", function (this: ApiWorld) {
  const rejected = state(this).review!.reportSubmissions.filter((submission) => submission.outcome === "rejected");
  assert.equal(rejected.length, 2);
  assert.ok(rejected.every((submission) => submission.phase === "generator" && submission.tool === "report_finding" && submission.code));
  assert.match(rejected[0]!.reason ?? "", /尚未读取/);
  assert.match(rejected[1]!.reason ?? "", /fixPrompt/);
});
Then("评审已完成且保留文件分组并明确没有结论", function (this: ApiWorld) {
  const s = state(this), review = s.review!;
  assert.equal(review.status, "completed");
  assert.deepEqual(review.fileGroups, makeMockFileGroups());
  assert.deepEqual(review.findings, []);
  assert.deepEqual(review.findingCounts, { high: 0, medium: 0 });
  assert.equal(review.reportSubmissions.filter((submission) => submission.tool === "report_finding" && submission.outcome === "accepted").length, 0);
  assert.ok(s.app.model!.requests.every((request) => request.body.model !== "fixture-grader"));
});
Then("依据与追溯记录一次未读证据的拒绝", function (this: ApiWorld) {
  const rejected = state(this).review!.reportSubmissions.filter((submission) => submission.outcome === "rejected");
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.tool, "report_finding");
  assert.match(rejected[0]!.reason ?? "", /尚未读取/);
});
Then("评审失败且说明没有有效的文件分组", function (this: ApiWorld) {
  const review = state(this).review!;
  assert.equal(review.status, "failed");
  assert.match(review.failureReason ?? "", /未提交有效的文件分组/);
  assert.deepEqual(review.fileGroups, []);
  assert.deepEqual(review.findings, []);
});
Then("依据与追溯保留文件分组被拒绝和无法完成的原因", function (this: ApiWorld) {
  const submissions = state(this).review!.reportSubmissions;
  assert.equal(submissions.length, 2);
  assert.ok(submissions.every((submission) => submission.phase === "generator" && submission.outcome === "rejected"));
  assert.equal(submissions[0]!.tool, "report_file_groups");
  assert.match(submissions[0]!.reason ?? "", /必须引用本次变更文件/);
  assert.equal(submissions[1]!.tool, "finish_report");
  assert.match(submissions[1]!.reason ?? "", /缺少有效的文件分组/);
});
Then("本轮的模型身份和提交记录可以关联评审结果", async function (this: ApiWorld) {
  const s = state(this);
  const response = await s.app.identity.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${s.reviewId}`);
  assert.equal(response.status, 200);
  const generator = response.body.items.find((session) => session.kind === "review_generator");
  assert.ok(generator);
  assert.equal(generator.reviewId, s.reviewId);
  assert.equal(generator.model, "fixture-generator");
  assert.equal(generator.provider, "ureview-generator");
  assert.equal(generator.status, s.review!.status);
  assert.ok(s.review!.reportSubmissions.some((submission) => submission.phase === "generator"));
  const reread = await s.app.identity.request<{ review: ReviewDetail }>(`/api/reviews/${s.reviewId}`);
  assert.equal(reread.status, 200);
  assert.deepEqual(reread.body.review.reportSubmissions, s.review!.reportSubmissions);
});
