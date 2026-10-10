import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { fixtureFinding, ReviewScenario } from "../support/review-scenario.js";
import type { RuleDetail } from "../../packages/server/src/rules/detail.js";
import type { RuleProposal } from "../../packages/server/src/rules/proposal-types.js";
import type { ReviewFinding } from "../../packages/server/src/reviews/types.js";

interface State { managedId: string; details: RuleDetail[]; proposals: RuleProposal[] }
const values = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => { const value = values.get(world); assert.ok(value); return value; };
const gitId = "repository:.agents/rules/inventory.md";
const tags = "@layer:api and (@story:rule-detail or @case:rule-feedback)";
Before({ tags, timeout: 60_000 }, async function (this: ApiWorld) {
  values.set(this, { managedId: "", details: [], proposals: [] }); this.review = new ReviewScenario(); await this.review.start({ disposition: true });
});
After({ tags, timeout: 60_000 }, async function (this: ApiWorld) {
  try { if (this.review?.gitlab) assert.deepEqual(this.review.gitlab.state.writes, []); } finally { await this.review?.stop(); }
});
async function prepare(world: ApiWorld, includeGit: boolean) {
  const rule = await world.review.saveGlobalRule("库存释放约定", "库存恢复前必须获取订单锁并记录订单号。"); state(world).managedId = `managed:${rule.id}`;
  const ids = [state(world).managedId, ...(includeGit ? [gitId] : [])];
  const gitFiles = { ".agents/rules/inventory.md": "---\nname: 库存操作保留流水\npaths: ['**/*.go']\nlayer: team\nlanguages: [go]\n---\n库存变更必须保留可追溯的操作流水。\n" };
  if (includeGit) {
    await world.review.gitlab.commitFiles(gitFiles, "global");
    await world.review.gitlab.commitFiles(gitFiles);
  }
  world.review.modelOptions.candidates!.splice(0, Infinity, ...ids.flatMap((ruleId) => ["库存恢复缺少订单锁", "库存恢复缺少操作流水"].map((title) => ({ ...structuredClone(fixtureFinding), ruleId, title: `${ruleId.startsWith("managed:") ? "工作台" : "Git"}：${title}` }))));
  await world.review.openPullRequest("李娜", "修复订单超时库存释放");
  const review = await world.review.waitForReview((entry) => entry.status === "completed"); assert.equal(review.findings.length, includeGit ? 4 : 2);
  if (includeGit) {
    const sync = await world.review.request(`/api/rules/repositories/${world.review.repositoryId}/sync`, {});
    assert.equal(sync.status, 200, JSON.stringify(sync.body));
  }
}
async function dispose(world: ApiWorld, finding: ReviewFinding, status: "Resolved" | "Dismissed" | "Pending", reasonCategory = "rule_incorrect") {
  const result = await world.review.request(`/api/reviews/${world.review.reviewId}/findings/${finding.id}/disposition`, {
    version: finding.disposition!.version, status, ...(status === "Dismissed" ? { reasonCategory, explanation: "库存恢复由事务保护，需要补充适用条件。" } : {}),
  }, {}, "PATCH"); assert.equal(result.status, 200, JSON.stringify(result.body));
}
Given("库存评审分别命中工作台规范与 Git 规范各两次", async function (this: ApiWorld) { await prepare(this, true); });
When("张伟分别采纳和驳回两种来源规范的 finding", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  for (const ruleId of [state(this).managedId, gitId]) {
    const hits = review.findings.filter((finding) => finding.ruleId === ruleId); assert.equal(hits.length, 2);
    await dispose(this, hits[0]!, "Resolved"); await dispose(this, hits[1]!, "Dismissed");
  }
});
Then("两种规范详情均展示两条执行记录及各一次采纳和驳回", async function (this: ApiWorld) {
  const value = state(this);
  for (const ruleId of [value.managedId, gitId]) {
    const response = await this.review.request<RuleDetail>(`/api/rules/${encodeURIComponent(ruleId)}/detail?repositoryId=${this.review.repositoryId}`);
    assert.equal(response.status, 200, JSON.stringify(response.body)); value.details.push(response.body);
    assert.deepEqual(response.body.summary, { hits: 2, adopted: 1, dismissed: 1, ignored: 0, dismissalReasons: { rule_incorrect: 1 } });
    assert.equal(response.body.records.length, 2); assert.equal(response.body.rule.id, ruleId); assert.ok(response.body.rule.body);
    assert.equal(response.body.rule.layer, "team"); assert.ok(response.body.rule.version);
  }
  const catalog = await this.review.request<{ rules: Array<{ id: string; counts: object }>; managedRules: Array<{ id: string; counts: object }> }>(`/api/rules?repositoryId=${this.review.repositoryId}`);
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.body.rules.find((rule) => rule.id === gitId)?.counts, { hits: 2, adopted: 1, dismissed: 1, ignored: 0 });
  assert.deepEqual(catalog.body.managedRules.find((rule) => `managed:${rule.id}` === value.managedId)?.counts, { hits: 2, adopted: 1, dismissed: 1, ignored: 0 });
});
Then("执行记录包含 PR、轮次、严重度、处置人和驳回理由", function (this: ApiWorld) {
  for (const detail of state(this).details) for (const record of detail.records) {
    assert.equal(record.reviewId, this.review.reviewId); assert.equal(record.repositoryId, this.review.repositoryId);
    assert.equal(record.title, "修复订单超时库存释放"); assert.equal(record.round, 1); assert.equal(record.severity, "high");
    assert.equal(record.disposition.actor?.name, "张伟"); assert.ok(record.disposition.updatedAt); assert.ok(record.findingId);
    if (record.status === "Dismissed") { assert.equal(record.disposition.reasonCategory, "rule_incorrect"); assert.match(record.disposition.explanation!, /事务保护/); }
  }
});
Given("库存评审有两条命中同一规范的 finding", async function (this: ApiWorld) { await prepare(this, false); });
When("张伟以规范有误驳回这两条 finding", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  await dispose(this, review.findings[0]!, "Dismissed");
  const first = await this.review.request<{ proposals: RuleProposal[] }>("/api/rule-proposals?source=feedback&status=pending");
  assert.equal(first.status, 200); assert.equal(first.body.proposals.length, 1); assert.equal(first.body.proposals[0]!.feedbackCount, 1);
  state(this).proposals = first.body.proposals;
  await dispose(this, review.findings[1]!, "Dismissed");
});
Then("仅有一条待审核驳回反馈提案并记录两次反馈及来源", async function (this: ApiWorld) {
  const response = await this.review.request<{ proposals: RuleProposal[] }>("/api/rule-proposals?source=feedback&status=pending");
  assert.equal(response.status, 200); assert.equal(response.body.proposals.length, 1);
  const proposal = response.body.proposals[0]!; assert.equal(proposal.id, state(this).proposals[0]!.id);
  assert.equal(proposal.ruleId, state(this).managedId); assert.equal(proposal.reasonCategory, "rule_incorrect");
  assert.equal(proposal.feedbackCount, 2); assert.equal(proposal.feedback.length, 2);
  const review = await this.review.readReview();
  assert.deepEqual(proposal.feedback.map((item) => item.findingId).sort(), review.findings.map((item) => item.id).sort());
  assert.ok(proposal.feedback.every((item) => item.reviewId === review.id && item.explanation?.includes("事务保护")));
});

async function feedbackProposals(world: ApiWorld, status?: RuleProposal["status"]) {
  const response = await world.review.request<{ proposals: RuleProposal[] }>(`/api/rule-proposals?source=feedback${status ? `&status=${status}` : ""}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.proposals;
}

When("张伟将第一条 finding 改回待处理", async function (this: ApiWorld) {
  await dispose(this, (await this.review.readReview()).findings[0]!, "Pending");
});
When("张伟采纳第二条 finding", async function (this: ApiWorld) {
  await dispose(this, (await this.review.readReview()).findings[1]!, "Resolved");
});
Then("原提案仍待审核且仅保留第二条 finding 的反馈", async function (this: ApiWorld) {
  const proposals = await feedbackProposals(this, "pending");
  assert.equal(proposals.length, 1);
  const proposal = proposals[0]!;
  assert.equal(proposal.id, state(this).proposals[0]!.id);
  assert.equal(proposal.feedbackCount, 1);
  assert.deepEqual(proposal.feedback.map((entry) => entry.findingId), [(await this.review.readReview()).findings[1]!.id]);
});
Then("原提案已撤回且没有反馈和待审核项", async function (this: ApiWorld) {
  assert.deepEqual(await feedbackProposals(this, "pending"), []);
  const proposal = (await feedbackProposals(this, "withdrawn")).find((entry) => entry.id === state(this).proposals[0]!.id);
  assert.ok(proposal);
  assert.equal(proposal.status, "withdrawn");
  assert.equal(proposal.feedbackCount, 0);
  assert.deepEqual(proposal.feedback, []);
  assert.equal(proposal.reviewedAt, null);
  assert.equal(proposal.reviewedBy, null);
});
When("张伟再次以规范不适用驳回第一条 finding", async function (this: ApiWorld) {
  await dispose(this, (await this.review.readReview()).findings[0]!, "Dismissed", "rule_not_applicable");
});
Then("新的待审核提案仅记录第一条 finding 的反馈", async function (this: ApiWorld) {
  const proposals = await feedbackProposals(this, "pending");
  assert.equal(proposals.length, 1);
  const proposal = proposals[0]!;
  assert.notEqual(proposal.id, state(this).proposals[0]!.id);
  assert.equal(proposal.reasonCategory, "rule_not_applicable");
  assert.equal(proposal.feedbackCount, 1);
  assert.deepEqual(proposal.feedback.map((entry) => entry.findingId), [(await this.review.readReview()).findings[0]!.id]);
  state(this).proposals = proposals;
});
When("张伟将第一条 finding 的驳回理由改为误报", async function (this: ApiWorld) {
  await dispose(this, (await this.review.readReview()).findings[0]!, "Dismissed", "false_positive");
});
When("管理员审核拒绝这条反馈提案", async function (this: ApiWorld) {
  const proposals = await feedbackProposals(this, "pending");
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0]!.feedbackCount, 2);
  const result = await this.review.request<{ proposal: RuleProposal }>(`/api/rule-proposals/${proposals[0]!.id}/review`, { status: "rejected", reason: "规范已列明事务保护的适用条件。" });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.proposal.status, "rejected");
  assert.equal(result.body.proposal.reviewedBy?.name, "张伟");
  assert.ok(result.body.proposal.reviewedAt);
  state(this).proposals = [result.body.proposal];
});
Then("已拒绝提案保留审核时的两条反馈和审核记录", async function (this: ApiWorld) {
  const proposals = await feedbackProposals(this, "rejected");
  assert.deepEqual(proposals, state(this).proposals);
  assert.equal(proposals[0]!.feedbackCount, 2);
  assert.equal(proposals[0]!.feedback.length, 2);
  assert.deepEqual(await feedbackProposals(this, "pending"), []);
});
