import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import type { GitRuleFile, ReviewDetail, ReviewRule } from "../../packages/server/src/reviews/types.js";
import type { ApiWorld } from "../support/world.js";
import { fixtureFinding } from "../support/review-scenario.js";
import { releasePath } from "../support/review-gitlab-fixture.js";

const productionPath = "internal/payment/settle.go";
const testPath = "internal/payment/settle_test.go";
const repositoryRuleId = (id: string) => `repository:.agents/rules/${id}.md`;
const markdown = (id: string, body: string, paths = ["internal/**/*.go"]) => `---\nname: ${id}\npaths: ${JSON.stringify(paths)}\n---\n${body}\n`;
const previous = new WeakMap<ApiWorld, ReviewDetail>();

function selected(review: ReviewDetail, id: string): ReviewRule & { file: GitRuleFile } {
  const rule = review.rules.find((item) => item.id === id || item.id === repositoryRuleId(id));
  assert.ok(rule, `评审中没有规范 ${id}`);
  assert.ok(rule.file.kind !== "database", "Git 规范必须记录实际文件来源");
  return { ...rule, file: rule.file };
}

async function finish(world: ApiWorld): Promise<ReviewDetail> {
  return world.review.waitForReview((review) => review.status === "completed");
}

Given("仓库 {string} 生效规范中包含 {string}", async function (this: ApiWorld, name: string, text: string) {
  await this.review.connect(name);
  const [id, ...body] = text.split(" ");
  assert.ok(id);
  await this.review.gitlab.commitFiles({ [`.agents/rules/${id}.md`]: markdown(id, body.join(" ")) });
});

Given("PR {string} 的评审产出了一条命中 {string} 的 finding", async function (this: ApiWorld, title: string, ruleId: string) {
  await this.review.gitlab.commitFiles({ [productionPath]: "package payment\nvar amount = 12.5\n" });
  this.review.modelOptions.candidates!.splice(0, 1, {
    title: "结算金额使用浮点数", description: "金额字段没有使用整数分", severity: "high", ruleId: repositoryRuleId(ruleId),
    location: { path: productionPath, startLine: 2, endLine: 2 },
    evidence: [{ path: productionPath, startLine: 2, endLine: 2, description: "金额定义" }],
    fixPrompt: "将金额改为整数分",
  });
  await this.review.openPullRequest("李娜", title);
  await finish(this);
});

Then("该 finding 命中规范 {string}", function (this: ApiWorld, id: string) {
  assert.equal(this.review.observedFinding?.ruleId, repositoryRuleId(id));
});

Then("该 finding 带有指向规范 {string} 的引用", function (this: ApiWorld, id: string) {
  const rule = selected(this.review.observedReview!, id);
  assert.equal(new URL(rule.file.url).pathname, `/commerce/payment-gateway/-/blob/${rule.file.commitSha}/.agents/rules/${id}.md`);
});

Then("命中规范的正文为 {string}", function (this: ApiWorld, body: string) {
  assert.equal(selected(this.review.observedReview!, this.review.observedFinding!.ruleId!).body, body);
});

Then("命中规范的来源指向本次评审的仓库提交", function (this: ApiWorld) {
  const rule = selected(this.review.observedReview!, this.review.observedFinding!.ruleId!);
  assert.equal(rule.file.kind, "repository");
  assert.equal(rule.file.commitSha, this.review.observedReview!.headSha);
});

Given("PR {string} 中 {string} 与 {string} 都违反了 {string}", async function (this: ApiWorld, title: string, first: string, second: string, ruleId: string) {
  assert.equal(first, productionPath); assert.equal(second, testPath);
  await this.review.gitlab.commitFiles({ [first]: "package payment\nvar amount = 12.5\n", [second]: "package payment\nvar expected = 12.5\n" });
  this.review.modelOptions.candidates!.splice(0, 1, ...[first, second].map((path, index) => ({
    title: index === 0 ? "结算金额使用浮点数" : "测试金额使用浮点数", description: "金额字段没有使用整数分", ruleId: repositoryRuleId(ruleId),
    severity: index === 0 ? "high" as const : "medium" as const,
    location: { path, startLine: 2, endLine: 2 }, evidence: [{ path, startLine: 2, endLine: 2, description: "金额定义" }],
    fixPrompt: "将金额改为整数分",
  })));
  await this.review.openPullRequest("李娜", title);
  await finish(this);
});

When("评审人 {string} 查看这两条 finding", async function (this: ApiWorld, _actor: string) {
  assert.equal((await this.review.readReview()).findings.length, 2);
});
Then("{string} 上的 finding 严重度为 {string}", function (this: ApiWorld, path: string, severity: string) {
  const finding = this.review.observedReview!.findings.find((item) => item.location.path === path);
  assert.equal(finding?.severity, severity === "高危" ? "high" : "medium");
  assert.equal(finding?.ruleId, repositoryRuleId("R-007"));
});

Given("团队已启用全局规范且仓库有针对 Go、TypeScript 和不同目录的规范", async function (this: ApiWorld) {
  this.review.modelOptions.candidates!.splice(0, 1, { ...structuredClone(fixtureFinding), ruleId: repositoryRuleId("R-007") });
  await this.review.saveGlobalRule("G-001", "全局库存释放约定");
  await this.review.gitlab.commitFiles({ ".ureview/global-rules.json": "{损坏的遗留文件" }, "global");
  await this.review.gitlab.commitFiles({
    "web/settle.tsx": "export const amount = 1200;\n",
    ".agents/rules/R-007.md": markdown("R-007", "仓库库存锁约定", ["internal/inventory/**/*.go"]),
    ".agents/rules/R-008.md": markdown("R-008", "不适用的 Go 网页规范", ["web/**/*.go"]),
    ".agents/rules/R-009.md": markdown("R-009", "不适用的前端服务规范", ["internal/**/*.tsx"]),
  });
});
Then("本轮选用规范恰好为 {string}", async function (this: ApiWorld, ids: string) {
  const review = await finish(this);
  assert.deepEqual(review.rules.map((rule) => rule.id).sort(), ids.split(",").map((id) => id.startsWith("R-") ? repositoryRuleId(id) : `managed:${this.review.globalRules.get(id)!.id}`).sort());
  assert.deepEqual(review.rules.map((rule) => rule.file.kind), ["database", "repository"]);
  assert.ok(this.review.gitlab.requests.every((request) => !decodeURIComponent(request.path).includes("global-rules.json")));
  assert.ok(review.rules.every((rule) => rule.matchedPaths.includes(releasePath)));
});
Then("产出模型和评分模型都收到这两条规范的正文", function (this: ApiWorld) {
  for (const model of ["fixture-generator", "fixture-grader"]) {
    const request = this.review.model.requests.find((item) => item.body.model === model && JSON.stringify(item.body).includes("仓库库存锁约定"));
    assert.ok(request);
    assert.ok(JSON.stringify(request.body).includes("全局库存释放约定"));
    assert.ok(JSON.stringify(request.body).includes("仓库库存锁约定"));
  }
});
Then("未匹配规范没有进入模型的规范上下文", function (this: ApiWorld) {
  for (const request of this.review.model.requests) {
    const messages = request.body.messages.map((message) => typeof message.content === "string" ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    const injected = messages.filter((message) => message.startsWith("本次预先注入的团队规范：") || message.includes("<rule-context"));
    for (const message of injected) { assert.ok(!message.includes("不适用的 Go 网页规范")); assert.ok(!message.includes("不适用的前端服务规范")); }
  }
});

Given("全局规范 {string} 的正文为 {string}", async function (this: ApiWorld, id: string, body: string) {
  await this.review.saveGlobalRule(id, body);
});
Given("PR {string} 已按该规范完成评审", async function (this: ApiWorld, title: string) {
  this.review.modelOptions.candidates!.splice(0, 1, { ...structuredClone(fixtureFinding), ruleId: `managed:${this.review.globalRules.get("G-001")!.id}` });
  await this.review.openPullRequest("李娜", title);
  previous.set(this, structuredClone(await finish(this)));
});
When("全局规范 {string} 的正文改为 {string}", async function (this: ApiWorld, id: string, body: string) {
  await this.review.saveGlobalRule(id, body);
});
When("开发者 {string} 新建另一个 PR {string}", async function (this: ApiWorld, actor: string, title: string) {
  await this.review.gitlab.nextPullRequest();
  this.review.eventId = randomUUID();
  await this.review.openPullRequest(actor, title);
});
Then("新评审选用规范 {string} 的正文为 {string}", async function (this: ApiWorld, id: string, body: string) {
  assert.equal((await finish(this)).rules.find((rule) => rule.name === id)?.body, body);
});
Then("旧评审选用规范 {string} 的正文仍为 {string}", async function (this: ApiWorld, id: string, body: string) {
  const old = previous.get(this)!;
  const response = await this.review.request<{ review: ReviewDetail }>(`/api/reviews/${old.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.review.rules.find((rule) => rule.name === id)?.body, body);
  assert.deepEqual(response.body.review, old);
});
Then("两次评审的规范来源分别保留对应的数据库版本", async function (this: ApiWorld) {
  const before = previous.get(this)!.rules.find((rule) => rule.name === "G-001")!;
  const after = (await this.review.readReview()).rules.find((rule) => rule.name === "G-001")!;
  const ruleId = this.review.globalRules.get("G-001")!.id;
  assert.deepEqual(before.file, { kind: "database", ruleId, version: 1, scope: "global" });
  assert.deepEqual(after.file, { kind: "database", ruleId, version: 2, scope: "global" });
});
Given("团队没有启用任何全局规范", async function (this: ApiWorld) {
  const response = await this.review.request<{ rules: unknown[] }>("/api/managed-rules");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.rules, []);
});
Then("本轮没有注入全局规范", async function (this: ApiWorld) {
  assert.deepEqual((await finish(this)).rules, []);
});
