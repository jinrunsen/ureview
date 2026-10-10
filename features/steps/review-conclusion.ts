import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ReviewConclusion } from "../../packages/server/src/reviews/types.js";
import { fixtureFinding, ReviewScenario } from "../support/review-scenario.js";
import type { ApiWorld } from "../support/world.js";

Before({ tags: "@story:review-conclusion", timeout: 60_000 }, async function (this: ApiWorld) {
  this.review = new ReviewScenario();
  await this.review.start({ disposition: true });
});

After({ tags: "@story:review-conclusion", timeout: 60_000 }, async function (this: ApiWorld) {
  try {
    if (this.review?.gitlab) assert.deepEqual(this.review.gitlab.state.writes, [], "读取结论和处置不得写入代码平台");
  } finally { await this.review?.stop(); }
});

async function finish(world: ApiWorld) {
  await world.review.openPullRequest("李娜", "修复订单超时未释放库存");
  return world.review.waitForReview((review) => review.status === "completed");
}

Given("库存评审展示一条高危和一条中危 finding", async function (this: ApiWorld) {
  this.review.modelOptions.candidates!.splice(0, Infinity,
    structuredClone(fixtureFinding),
    { ...structuredClone(fixtureFinding), title: "释放日志缺少订单号", severity: "medium" },
  );
  const review = await finish(this);
  assert.deepEqual(review.findings.map((finding) => finding.severity), ["high", "medium"]);
});

Given("评审人采纳了库存高危 finding 并驳回中危 finding", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  for (const finding of review.findings) {
    assert.ok(finding.disposition);
    const result = await this.review.request(`/api/reviews/${review.id}/findings/${finding.id}/disposition`, {
      version: finding.disposition.version,
      ...(finding.severity === "high" ? { status: "Resolved" } : { status: "Dismissed", reasonCategory: "not_worth_fixing" }),
    }, {}, "PATCH");
    assert.equal(result.status, 200);
  }
});

Given("库存评审展示五条中危 finding 并折叠一条高危 finding", async function (this: ApiWorld) {
  const titles = ["释放日志缺少订单号", "超时阈值缺少配置", "通知失败缺少重试", "库存恢复缺少处理结果", "超时事件缺少追踪信息"];
  this.review.modelOptions.candidates!.splice(0, Infinity,
    ...titles.map((title) => ({ ...structuredClone(fixtureFinding), title, severity: "medium" as const })),
    structuredClone(fixtureFinding),
  );
  this.review.modelOptions.scores = [95, 94, 93, 92, 91, 80];
  const review = await finish(this);
  assert.equal(review.foldedCount, 1);
  assert.equal(review.findings.length, 5);
  assert.ok(review.findings.every((finding) => finding.severity === "medium"));
});

Given("库存评审仅发现低危 finding", async function (this: ApiWorld) {
  this.review.modelOptions.candidates!.splice(0, Infinity, { ...structuredClone(fixtureFinding), title: "库存释放日志可以缩短", severity: "low" });
  const review = await finish(this);
  assert.equal(review.findings.length, 0);
});

When("评审人查看库存评审结论", async function (this: ApiWorld) {
  await this.review.readReview();
});

Then("库存评审结论为 {string}", function (this: ApiWorld, label: string) {
  const statuses: Record<string, ReviewConclusion["status"]> = {
    "建议修改": "requires_changes", "需要人工判断": "manual_judgment", "未发现高中危问题": "no_major_findings",
  };
  assert.ok(Object.hasOwn(statuses, label));
  assert.equal(this.review.observedReview?.conclusion.status, statuses[label]);
});

Then("库存评审结论包含高危 {int} 条、中危 {int} 条、已处置 {int} 条", function (this: ApiWorld, high: number, medium: number, disposedCount: number) {
  assert.deepEqual(this.review.observedReview?.conclusion.findingCounts, { high, medium });
  assert.equal(this.review.observedReview?.conclusion.disposedCount, disposedCount);
});
