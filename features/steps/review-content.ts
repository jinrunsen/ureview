import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Given, Then, When, type DataTable } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { fixtureFinding } from "../support/review-scenario.js";
import { releaseCode } from "../support/review-gitlab-fixture.js";

const severity = (label: string) => {
  const values = { "高危": "high", "中危": "medium", "低危": "low" } as const;
  assert.ok(label in values);
  return values[label as keyof typeof values];
};
const titles = ["库存恢复缺少幂等检查", "释放操作未校验订单状态", "重复事件导致多次恢复", "库存恢复失败未重试", "锁释放异常未处理", "超时任务缺少状态校验", "金额字段缺少边界检查", "日志缺少订单标识", "超时结果未记录"];

async function complete(world: ApiWorld, title: string) {
  await world.review.openPullRequest("李娜", title);
  await world.review.waitForReview((review) => review.status === "completed");
}

Given("仓库 {string} 中的 PR {string} 已完成评审", async function (this: ApiWorld, repository: string, title: string) {
  await this.review.connect(repository);
  await complete(this, title);
});

When("评审人 {string} 查看该 finding 的锚定信息", async function (this: ApiWorld, _actor: string) {
  const review = await this.review.readReview();
  this.review.observedFinding = review.findings[0];
  assert.ok(this.review.observedFinding?.anchor);
});
Then("该 finding 锚定的行范围为第 {int} 行至第 {int} 行", function (this: ApiWorld, start: number, end: number) {
  assert.equal(this.review.observedFinding?.anchor?.startLine, start);
  assert.equal(this.review.observedFinding?.anchor?.endLine, end);
});
Then("代码锚的指纹对应本轮实际读取的代码", function (this: ApiWorld) {
  const finding = this.review.observedFinding!;
  const expectedCode = releaseCode.split("\n").slice(2, 4).join("\n");
  assert.equal(finding.anchor?.path, fixtureFinding.location.path);
  assert.equal(finding.code, expectedCode);
  assert.equal(finding.anchor?.fingerprint, createHash("sha256").update(expectedCode).digest("hex"));
  assert.equal(finding.anchor?.side, "new");
});
Then("本轮差异保留代码平台提供的原始片段", function (this: ApiWorld) {
  assert.deepEqual(this.review.observedReview!.files.map((file) => file.patch), this.review.gitlab.state.diffs.map((file) => file.diff));
});

Given("PR {string} 的评审产出了以下 finding", async function (this: ApiWorld, title: string, table: DataTable) {
  this.review.modelOptions.candidates!.splice(0, Infinity, ...table.hashes().map((row) => ({
    ...structuredClone(fixtureFinding), title: row["标题"]!, severity: severity(row["严重度"]!),
  })));
  await complete(this, title);
});
Then("评审结果中 finding 按严重度分为 {string} 与 {string} 两组", function (this: ApiWorld, first: string, second: string) {
  assert.deepEqual([...new Set(this.review.observedReview!.findings.map((finding) => finding.severity))], [severity(first), severity(second)]);
});
Then("评审结果中 {string} 组排在 {string} 组之前", function (this: ApiWorld, first: string, second: string) {
  const values = this.review.observedReview!.findings.map((finding) => finding.severity);
  assert.ok(values.lastIndexOf(severity(first)) < values.indexOf(severity(second)));
});
Then("评审结果的 {string} 组中包含 {string} 与 {string}", function (this: ApiWorld, group: string, first: string, second: string) {
  const values = this.review.observedReview!.findings.filter((finding) => finding.severity === severity(group)).map((finding) => finding.title);
  assert.deepEqual(values.sort(), [first, second].sort());
});
Given("PR {string} 的评审共产出了 {int} 条中高危 finding", async function (this: ApiWorld, title: string, count: number) {
  assert.equal(count, titles.length);
  this.review.modelOptions.candidates!.splice(0, Infinity, ...titles.map((name, index) => ({
    ...structuredClone(fixtureFinding), title: name, severity: index % 2 ? "medium" as const : "high" as const,
  })));
  this.review.modelOptions.scores = [45, 95, 70, 80, 60, 100, 40, 90, 85];
  await complete(this, title);
});
Given("PR {string} 的评审内部产出了 {int} 条高危与 {int} 条低危结论", async function (this: ApiWorld, title: string, high: number, low: number) {
  this.review.modelOptions.candidates!.splice(0, Infinity, ...titles.slice(0, high + low).map((name, index) => ({
    ...structuredClone(fixtureFinding), title: name, severity: index < high ? "high" as const : "low" as const,
  })));
  await complete(this, title);
});
Then("该评审给出 {int} 条 finding", function (this: ApiWorld, count: number) {
  assert.equal(this.review.observedReview!.findings.length, count);
});
Then("该评审不包含任何低危 finding", function (this: ApiWorld) {
  assert.ok(this.review.observedReview!.findings.every((finding) => finding.severity !== "low"));
  assert.deepEqual(this.review.observedReview!.findingCounts, { high: 2, medium: 0 });
});
Then("展示的五条 finding 恰好是评分最高的五条", function (this: ApiWorld) {
  assert.deepEqual(this.review.observedReview!.findings.map((finding) => finding.score).sort((a, b) => b - a), [100, 95, 90, 85, 80]);
  assert.deepEqual(this.review.observedReview!.findingCounts, { high: 5, medium: 4 });
});
Given("PR {string} 的评审产出了高危 finding {string}", async function (this: ApiWorld, title: string, name: string) {
  this.review.modelOptions.candidates!.splice(0, Infinity, { ...structuredClone(fixtureFinding), title: name });
  await complete(this, title);
});
Given("PR {string} 的评审产出了中危 finding {string}", async function (this: ApiWorld, title: string, name: string) {
  this.review.modelOptions.candidates!.splice(0, Infinity, { ...structuredClone(fixtureFinding), title: name, severity: "medium" });
  await complete(this, title);
});
Then("评审结果展示 {string}", function (this: ApiWorld, name: string) {
  assert.ok(this.review.observedReview?.findings.some((finding) => finding.title === name));
});
Then("{string} 锚定在具体的代码行上", function (this: ApiWorld, name: string) {
  const finding = this.review.observedReview!.findings.find((finding) => finding.title === name);
  assert.ok(finding?.anchor);
  assert.deepEqual({ path: finding.anchor.path, startLine: finding.anchor.startLine, endLine: finding.anchor.endLine }, finding.location);
});
