import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import type { ReviewDetail, ReviewFinding } from "../../packages/server/src/reviews/types.js";
import type { ApiWorld } from "../support/world.js";
import { releasePath } from "../support/review-gitlab-fixture.js";
import { fixtureFinding } from "../support/review-scenario.js";

interface ComparisonState { previous: ReviewDetail; ruleId: string; current?: ReviewDetail }
const states = new WeakMap<ApiWorld, ComparisonState>();
const state = (world: ApiWorld) => { const value = states.get(world); assert.ok(value); return value; };
const initialCode = "package inventory\n\nfunc ReleaseInventory(orderID string) {\n  restoreStock(orderID)\n  releaseAfterSeconds(30)\n  logRelease(orderID)\n  notifyRelease(orderID)\n}\n";
function candidate(title: string, startLine: number, endLine = startLine, ruleId?: string) {
  return { ...structuredClone(fixtureFinding), title, severity: "medium" as const,
    location: { path: releasePath, startLine, endLine },
    evidence: [{ path: releasePath, startLine, endLine, description: "库存释放代码" }], ...(ruleId ? { ruleId } : {}) };
}
Given("库存 PR 上一轮有三条中危 finding 且其中一条已被驳回", async function (this: ApiWorld) {
  await this.review.gitlab.commitFiles({ [releasePath]: initialCode });
  const created = await this.review.saveGlobalRule("超时配置约定", "超时配置应根据订单处理策略设置。");
  const updated = await this.review.request(`/api/managed-rules/${created.id}`, {
    name: created.name, body: created.body, goodExample: created.goodExample, badExample: created.badExample,
    category: created.category, severity: "warning", scope: created.scope, repositories: created.repositories,
    status: created.status, version: created.version,
  }, {}, "PUT");
  assert.equal(updated.status, 200);
  const ruleId = `managed:${created.id}`;
  this.review.modelOptions.candidates!.splice(0, Infinity,
    candidate("库存恢复缺少幂等保护", 3, 4), candidate("超时配置缺少订单策略", 5, 5, ruleId), candidate("释放日志缺少处理结果", 6));
  await this.review.openPullRequest("李娜", "修复订单超时未释放库存");
  const previous = await this.review.waitForReview((review) => review.status === "completed");
  assert.equal(previous.findings.length, 3);
  assert.ok(previous.findings.every((finding) => finding.severity === "medium" && finding.fingerprint && finding.anchor?.fingerprint === finding.fingerprint));
  assert.deepEqual(previous.comparison, { previousReview: null, absentFindings: [] });
  assert.ok(previous.findings.every((finding) => finding.comparison?.kind === "new"));
  const recurring = previous.findings.find((finding) => finding.title === "库存恢复缺少幂等保护")!;
  const response = await this.review.request(`/api/reviews/${previous.id}/findings/${recurring.id}/disposition`, {
    version: recurring.disposition!.version, status: "Dismissed", reasonCategory: "false_positive", explanation: "上游任务已经按订单去重。",
  }, {}, "PATCH");
  assert.equal(response.status, 200);
  states.set(this, { previous: await this.review.readReview(), ruleId });
});
When("新一轮保留相同代码问题和同规范同标题问题并新增一条问题", async function (this: ApiWorld) {
  const value = state(this);
  await this.review.gitlab.commitFiles({ [releasePath]: initialCode.replace("releaseAfterSeconds(30)", "releaseAfterSeconds(45)") });
  this.review.modelOptions.candidates!.splice(0, Infinity,
    candidate("库存恢复可能重复执行", 3, 4), candidate("超时配置缺少订单策略", 5, 5, value.ruleId), candidate("释放通知缺少失败处理", 7));
  const response = await this.review.request<{ reviewId: string; created: boolean }>(`/api/reviews/${value.previous.id}/rerun`, { requestId: randomUUID() });
  assert.equal(response.status, 202); assert.equal(response.body.created, true);
  this.review.reviewId = response.body.reviewId;
  value.current = await this.review.waitForReview((review) => review.status === "completed");
});
Then("本轮两条 finding 标记为上一轮也有且新增一条标记为新出现", function (this: ApiWorld) {
  const { previous, current } = state(this); assert.ok(current);
  assert.deepEqual(current.comparison?.previousReview, { id: previous.id, round: previous.round });
  assert.equal(current.findings.length, 3);
  for (const title of ["库存恢复可能重复执行", "超时配置缺少订单策略"]) {
    const finding: ReviewFinding = current.findings.find((item) => item.title === title)!; assert.equal(finding.comparison?.kind, "recurring");
    const previousTitle = title === "库存恢复可能重复执行" ? "库存恢复缺少幂等保护" : title;
    const original = previous.findings.find((item) => item.title === previousTitle)!;
    assert.equal(finding.comparison?.previousFinding?.findingId, original.id);
    if (title === "库存恢复可能重复执行") assert.equal(finding.fingerprint, original.fingerprint);
    else assert.notEqual(finding.fingerprint, original.fingerprint);
  }
  assert.equal(current.findings.find((finding) => finding.title === "释放通知缺少失败处理")?.comparison?.kind, "new");
});
Then("上一轮驳回理由可供参考且本轮 finding 仍为待处理", function (this: ApiWorld) {
  const current = state(this).current!;
  const reference = current.findings.find((finding) => finding.title === "库存恢复可能重复执行")?.comparison?.previousFinding;
  assert.equal(reference?.status, "Dismissed"); assert.equal(reference.disposition?.reasonCategory, "false_positive");
  assert.equal(reference.disposition?.explanation, "上游任务已经按订单去重。"); assert.equal(reference.disposition.actor?.name, "张伟");
  assert.ok(current.findings.every((finding) => finding.status === "Pending" && finding.disposition?.version === 0 && finding.disposition.actor === null));
});
Then("上一轮剩余的一条 finding 列入本轮未再出现", async function (this: ApiWorld) {
  const value = state(this);
  assert.deepEqual(value.current!.comparison?.absentFindings.map((finding) => finding.title), ["释放日志缺少处理结果"]);
  const previous = await this.review.request<{ review: ReviewDetail }>(`/api/reviews/${value.previous.id}`);
  assert.equal(previous.status, 200); assert.deepEqual(previous.body.review, value.previous);
});
