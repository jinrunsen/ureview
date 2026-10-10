import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { RuleCatalogScenario } from "../support/rule-catalog-scenario.js";
import { ManagedRuleScenario, managedDraft } from "../../packages/server/src/rules/managed/test-support.js";
import type { ManagedRule } from "../../packages/server/src/rules/managed-types.js";
import type { RuleSession } from "../../packages/server/src/rules/sessions-types.js";
import type { RuleProposal } from "../../packages/server/src/rules/proposal-types.js";
import type { CandidateEntry } from "../../packages/server/src/rules/catalog.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer } from "../../packages/server/src/runtime/test-support.js";

interface State {
  app: ManagedRuleScenario; directory: string; host?: Awaited<ReturnType<typeof bootReviewHost>>;
  model?: Awaited<ReturnType<typeof startMockModelServer>>; proposals: RuleProposal[]; status: number;
  response?: { proposal: RuleProposal; error?: { message: string } }; rejectedId?: string;
}
const states = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => { const value = states.get(world); assert.ok(value); return value; };
const approvalTags = "@layer:api and @case:proposal-approval";
Before({ tags: approvalTags, timeout: 60_000 }, async function (this: ApiWorld) {
  const value: State = { app: new ManagedRuleScenario(), directory: await mkdtemp(join(tmpdir(), "ureview-proposals-bdd-")), proposals: [], status: 0 };
  states.set(this, value); value.model = await startMockModelServer({ ruleDraft: managedDraft });
  value.host = await bootReviewHost({ homeDir: join(value.directory, "dsh"), models: value.model.models,
    onReady: async (_runtime, generator) => { await value.app.start({ conversationGenerator: generator }); return async () => { await value.app.stop(); }; } });
});
After({ tags: approvalTags, timeout: 60_000 }, async function (this: ApiWorld) {
  const value = states.get(this); if (!value) return;
  const errors: unknown[] = [];
  for (const close of [() => value.host ? value.host.dispose() : value.app.stop(), () => value.model?.dispose(), () => rm(value.directory, { recursive: true, force: true })]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "提案场景清理失败");
});
async function proposals(value: State, member = false) {
  const result = await value.app.request<{ proposals: RuleProposal[] }>("/api/rule-proposals", undefined, member ? { cookie: value.app.memberCookie } : {});
  assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.proposals;
}
Given("团队有规则生成草稿和规范库草稿", async function (this: ApiWorld) {
  const value = state(this);
  const created = await value.app.request<{ session: RuleSession }>("/api/rule-sessions", {}); assert.equal(created.status, 201);
  const generated = await value.app.request<{ session: RuleSession }>(`/api/rule-sessions/${created.body.session.id}/turns`, { version: created.body.session.version, message: "金额必须使用整数分，请生成规范。" });
  assert.equal(generated.status, 200); assert.equal(generated.body.session.turns.at(-1)?.status, "completed");
  const session = generated.body.session;
  const saved = await value.app.request(`/api/rule-sessions/${session.id}/save-rule`, { version: session.version, workingCopy: { ...session.workingCopy, status: "draft" } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  await value.app.seedLegacyLibraryDraft("go-guidelines", "go-guidelines-check-errors");
  value.proposals = await proposals(value);
  assert.deepEqual(value.proposals.map((item) => item.source).sort(), ["generation", "library"]);
  assert.ok(value.proposals.every((item) => item.status === "pending"));
});
When("管理员采纳这两条规范提案", async function (this: ApiWorld) {
  const value = state(this);
  for (const proposal of value.proposals) {
    const result = await value.app.request(`/api/rule-proposals/${proposal.id}/review`, { status: "accepted" }); assert.equal(result.status, 200, JSON.stringify(result.body));
  }
});
Then("两条规范均已启用且提案记录审核人和时间", async function (this: ApiWorld) {
  const value = state(this), result = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(result.status, 200); assert.equal(result.body.rules.length, 2); assert.ok(result.body.rules.every((rule) => rule.status === "active"));
  assert.ok((await proposals(value)).every((item) => item.status === "accepted" && item.reviewedBy?.name === "张伟" && item.reviewedAt));
});
When("管理员不填写理由拒绝另一条提案", async function (this: ApiWorld) {
  const value = state(this); await value.app.seedLegacyLibraryDraft("go-guidelines", "go-guidelines-release-resources");
  value.rejectedId = (await proposals(value)).find((item) => item.status === "pending")!.id;
  const result = await value.app.request<NonNullable<State["response"]>>(`/api/rule-proposals/${value.rejectedId}/review`, { status: "rejected" });
  value.status = result.status; value.response = result.body;
});
Then("提案仍待审核并提示填写拒绝理由", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.status, 400); assert.match(value.response?.error?.message ?? "", /理由/);
  assert.equal((await proposals(value)).find((item) => item.id === value.rejectedId)!.status, "pending");
});
When("管理员填写拒绝理由后拒绝该提案", async function (this: ApiWorld) {
  const value = state(this); const result = await value.app.request<NonNullable<State["response"]>>(`/api/rule-proposals/${value.rejectedId}/review`, { status: "rejected", reason: "现有资源规范已经覆盖这一约定。" });
  assert.equal(result.status, 200, JSON.stringify(result.body)); value.response = result.body;
});
Then("提案记录拒绝理由、审核人和时间", async function (this: ApiWorld) {
  const value = state(this), proposal = (await proposals(value)).find((item) => item.id === value.rejectedId)!;
  assert.equal(proposal.status, "rejected"); assert.equal(proposal.rejectionReason, "现有资源规范已经覆盖这一约定。");
  assert.equal(proposal.reviewedBy?.name, "张伟"); assert.ok(proposal.reviewedAt);
});
Given("团队有一条待审核的规范库提案", async function (this: ApiWorld) {
  const value = state(this); await value.app.seedLegacyLibraryDraft("go-guidelines", "go-guidelines-check-errors");
  value.proposals = await proposals(value); assert.equal(value.proposals.length, 1);
});
When("李娜查看提案并尝试采纳", async function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(await proposals(value, true), value.proposals);
  const result = await value.app.request(`/api/rule-proposals/${value.proposals[0]!.id}/review`, { status: "accepted" }, { cookie: value.app.memberCookie }); value.status = result.status;
});
Then("提案仍待审核且规范仍为草稿", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.status, 403); assert.equal((await proposals(value))[0]!.status, "pending");
  const result = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules"); assert.equal(result.body.rules[0]!.status, "draft");
});

interface HistoryState { app: RuleCatalogScenario; proposal?: RuleProposal; candidate?: CandidateEntry }
const historyStates = new WeakMap<ApiWorld, HistoryState>();
const historyState = (world: ApiWorld) => { const value = historyStates.get(world); assert.ok(value); return value; };
Before({ tags: "@layer:api and @case:proposal-history", timeout: 60_000 }, async function (this: ApiWorld) { const value = { app: new RuleCatalogScenario() }; historyStates.set(this, value); await value.app.start(); });
After({ tags: "@layer:api and @case:proposal-history", timeout: 60_000 }, async function (this: ApiWorld) { await historyStates.get(this)?.app.stop(); });
Given("支付仓库有历史挖掘的待审核提案", async function (this: ApiWorld) {
  const value = historyState(this), result = await value.app.request(`/api/rules/repositories/${value.app.repositoryId}/mine`, {}); assert.equal(result.status, 200);
  const proposals = await value.app.request<{ proposals: RuleProposal[] }>("/api/rule-proposals?source=mining"); assert.equal(proposals.status, 200); assert.equal(proposals.body.proposals.length, 1);
  value.proposal = proposals.body.proposals[0]!; value.candidate = value.proposal.candidate!; assert.equal(value.proposal.status, "pending"); assert.ok(value.candidate.evidence.length >= 2);
});
When("管理员采纳后将候选正文保存到其他规范文件并同步", async function (this: ApiWorld) {
  const value = historyState(this);
  const accepted = await value.app.request(`/api/rule-proposals/${value.proposal!.id}/review`, { status: "accepted" }); assert.equal(accepted.status, 200);
  const path = ".agents/rules/checkout/positive-amount.md"; assert.notEqual(path, value.candidate!.suggestedPath);
  value.app.gitlab.state.files = { [path]: `---\nname: 金额校验\npaths: [src/**]\n---\n${value.candidate!.body}\n` };
  const synced = await value.app.request(`/api/rules/repositories/${value.app.repositoryId}/sync`, {}); assert.equal(synced.status, 200);
});
Then("历史候选显示已生效且保留采纳审核记录", async function (this: ApiWorld) {
  const value = historyState(this), result = await value.app.request<{ proposals: RuleProposal[] }>("/api/rule-proposals?source=mining");
  assert.equal(result.status, 200); const proposal = result.body.proposals.find((item) => item.id === value.proposal!.id)!;
  assert.equal(proposal.status, "accepted"); assert.equal(proposal.candidate!.active, true); assert.equal(proposal.reviewedBy?.name, "张伟"); assert.ok(proposal.reviewedAt);
  const candidates = await value.app.request<{ candidates: CandidateEntry[] }>("/api/rule-candidates"); assert.equal(candidates.body.candidates[0]!.active, true);
});
