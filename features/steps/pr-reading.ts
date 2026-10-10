import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Given, Then, When } from "@cucumber/cucumber";
import type { AgentSessionEvents, AgentSessionPage } from "../../packages/server/src/agent-sessions/types.js";
import type { ReadingDocumentRecord } from "../../packages/server/src/reviews/reading-document.js";
import type { ReviewDetail } from "../../packages/server/src/reviews/types.js";
import { END_TURN, makeMockDocumentScript, type MockToolStep } from "../../packages/server/src/runtime/test-support.js";
import { lockCode, lockPath, releaseCode, releasePath } from "../support/review-gitlab-fixture.js";
import { fixtureFinding } from "../support/review-scenario.js";
import type { ApiWorld } from "../support/world.js";

const concurrentReviews = new WeakMap<ApiWorld, string[]>();

async function statuses(world: ApiWorld): Promise<ReviewDetail["status"][]> {
  const ids = concurrentReviews.get(world) ?? [];
  const reviews = await Promise.all(ids.map((id) => world.review.request<{ review: ReviewDetail }>(`/api/reviews/${id}`)));
  return reviews.map((response) => response.body.review.status);
}

async function waitFor(world: ApiWorld, predicate: (values: ReviewDetail["status"][]) => boolean, message: string) {
  const deadline = Date.now() + 25_000;
  let last: ReviewDetail["status"][] = [];
  do {
    last = await statuses(world);
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.fail(`${message}：${JSON.stringify(last)}`);
}

Given("实例允许同时进行 {int} 个评审", function (this: ApiWorld, limit: number) {
  this.review.slots.limit = limit;
});

Given("李娜、王芳、陈刚各自提交的 PR 都在等待评审", async function (this: ApiWorld) {
  this.review.holdModel("generator");
  await this.review.connect("payment-gateway");
  // 每个 PR 放在独立的仓库里，代码平台桩一次只提供一个 PR。
  const repositories = [{ gitlab: this.review.gitlab, repositoryId: this.review.repositoryId },
    await this.review.addRepository("inventory-service"), await this.review.addRepository("order-service")];
  const ids: string[] = [];
  for (const [index, author] of ["李娜", "王芳", "陈刚"].entries()) {
    const { gitlab, repositoryId } = repositories[index]!;
    gitlab.state.title = `${author}提交的库存恢复修正`;
    gitlab.state.authorName = author;
    const response = await this.review.request<{ reviewId: string; created: boolean }>(
      `/api/repositories/${repositoryId}/events/gitlab`, gitlab.event(), {
        "x-gitlab-token": this.review.webhookToken, "x-gitlab-event": "Merge Request Hook", "webhook-id": randomUUID(),
      });
    assert.equal(response.status, 202);
    ids.push(response.body.reviewId);
  }
  concurrentReviews.set(this, ids);
});

When("评审开始处理", async function (this: ApiWorld) {
  await waitFor(this, (values) => values.filter((value) => value === "running").length === 2, "两个评审没有同时开始");
});

Then("两个 PR 的评审同时进行且第三个仍为待评审", async function (this: ApiWorld) {
  // 名额用满后多等几轮轮询，确认第三个没有被领取。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual((await statuses(this)).slice().sort(), ["queued", "running", "running"]);
});

Then("其中一个评审结束后第三个 PR 开始评审", async function (this: ApiWorld) {
  this.review.resumeModel();
  await waitFor(this, (values) => values.every((value) => value === "completed"), "三个评审没有全部完成");
});

// ---- 解读的生成、审读与保存 ----

const prTitle = "修复订单超时未释放库存";
const releaseExcerpt = releaseCode.split("\n").slice(2, 4).join("\n");
const ok = { isError: false };
const read = (path: string, startLine: number, endLine: number): MockToolStep => ({
  name: "read", input: { file_path: path, offset: startLine, limit: endLine - startLine + 1 }, result: ok,
});
const write = (id: string, html: string, result: MockToolStep["result"] = ok): MockToolStep => ({ name: "write_section", input: { id, html }, result });
/** 默认脚本去掉结尾的 finish_document，便于在后面接修订步骤。 */
const draft = () => makeMockDocumentScript(releasePath, 3, 4, prTitle);

function latest(world: ApiWorld): ReadingDocumentRecord {
  const document = readings.get(world);
  assert.ok(document, "尚未读取解读");
  return document;
}
const readings = new WeakMap<ApiWorld, ReadingDocumentRecord>();
function completed(world: ApiWorld) {
  const document = latest(world);
  assert.equal(document.status, "completed", document.failureReason ?? "解读未完成");
  assert.ok(document.content);
  return document.content;
}

async function sessions(world: ApiWorld) {
  const response = await world.review.request<AgentSessionPage>(`/api/agent-sessions?reviewId=${world.review.reviewId}`);
  assert.equal(response.status, 200);
  return response.body.items;
}

Given("库存变更具有描述、提交信息与关联需求", async function (this: ApiWorld) {
  await this.review.gitlab.commitFiles({ "AGENTS.md": "# 仓库约定\n库存逻辑放在 internal/inventory。\n" });
});

When("李娜发起库存变更评审并等待解读完成", async function (this: ApiWorld) {
  await this.review.openPullRequest("李娜", this.review.gitlab.state.title);
  readings.set(this, await this.review.waitForReading());
  await this.review.readReview();
  assert.deepEqual(this.review.model.scriptErrors, [], "模型必须实际收到预期的工具回执");
});

When("李娜发起库存变更评审并等待完成", async function (this: ApiWorld) {
  await this.review.openPullRequest("李娜", this.review.gitlab.state.title);
  await this.review.waitForReview((review) => review.status === "completed");
  readings.set(this, await this.review.waitForReading());
});

Then("解读与 finding 由两个会话同时生成且写作会话的输入不含 finding", async function (this: ApiWorld) {
  const items = await sessions(this);
  const writer = items.find((item) => item.kind === "review_reading");
  const generator = items.find((item) => item.kind === "review_generator");
  assert.ok(writer && generator, "写作与 Generator 都要有独立会话");
  assert.ok(writer.createdAt < (generator.completedAt ?? "9") && generator.createdAt < (writer.completedAt ?? "9"), "两个会话的运行时间应当重叠");
  const request = this.review.model.requests.find((item) => item.body.tools?.some((tool) => tool.name === "submit_outline"));
  assert.ok(request);
  assert.ok(!JSON.stringify(request.body.messages).includes(fixtureFinding.title), "写作会话的输入不能包含 finding");
  assert.match(JSON.stringify(request.body.messages), /AGENTS\.md/);
});

Then("解读包含概要、背景、改动范围、方案与行为变化和代码导读", function (this: ApiWorld) {
  const content = completed(this);
  assert.deepEqual(content.outline.map((entry) => entry.id), ["summary", "background", "scope", "design", "walkthrough"]);
  for (const entry of content.outline) assert.ok(content.sections[entry.id]?.trim(), `${entry.id} 没有正文`);
});

Then("方案与行为变化包含改前与改后的对比图", function (this: ApiWorld) {
  assert.match(completed(this).sections.design ?? "", /<svg\b[\s\S]*改前[\s\S]*改后/);
});

Then("解读的代码摘录与需求原文引用由宿主从本轮内容截取", function (this: ApiWorld) {
  const content = completed(this);
  assert.deepEqual(content.excerpts[`${releasePath}#L3-L4`], { path: releasePath, startLine: 3, endLine: 4, excerpt: releaseExcerpt });
  assert.match(content.sections.background ?? "", new RegExp(`<ur-source source="pull_request" quote="${prTitle}">`));
  const sources = this.review.observedReview!.requirementSources;
  assert.deepEqual(sources.map((source) => source.kind).sort(), ["commit", "issue", "pull_request"]);
});

Then("生成解读与审读解读的原始会话可以单独查看", async function (this: ApiWorld) {
  const items = await sessions(this);
  const writer = items.find((item) => item.kind === "review_reading");
  assert.equal(writer?.status, "completed");
  assert.equal(writer?.model, this.review.model.models.generator.model);
  const reviewer = items.filter((item) => item.kind === "review_grader" && item.model === this.review.model.models.grader.model);
  let found = false;
  for (const session of reviewer) {
    const events = await this.review.request<AgentSessionEvents>(`/api/agent-sessions/${session.id}/events`);
    found ||= events.body.events.some((event) => event.type === "tool/call" && event.data.name === "submit_review");
  }
  assert.ok(found, "审读解读要有独立会话并提交意见");
});

Given("写作会话先引用未读代码并改写需求原文，再补读代码并改正引用", function (this: ApiWorld) {
  const script = draft();
  const [, outline, summary, background, scope, design] = script;
  this.review.modelOptions.readingScript = [read(releasePath, 3, 4), outline!,
    write("background", `<ur-source source="pull_request" quote="被改写的需求原文"></ur-source>`, { isError: true, includes: "找不到" }),
    write("walkthrough", `<ur-code ref="${lockPath}#L3-L3"></ur-code>`, { isError: true, includes: "尚未读取" }),
    read(lockPath, 3, 3), summary!, background!, scope!, design!,
    write("walkthrough", `<ur-code ref="${lockPath}#L3-L3" title="订单锁"></ur-code><ur-code ref="${releasePath}#L3-L4"></ur-code><ur-code ref="${releasePath}#L3-L4"></ur-code>`),
    { name: "finish_document", input: {}, result: ok }];
});

Then("张伟读到的解读只包含修正后的内容", function (this: ApiWorld) {
  const content = completed(this);
  assert.ok(!JSON.stringify(content).includes("被改写的需求原文"));
  assert.deepEqual(content.excerpts[`${lockPath}#L3-L3`]?.excerpt, lockCode.split("\n")[2]);
});

Then("解读的提交记录保留未读代码与原文不符两类拒绝原因", function (this: ApiWorld) {
  const codes = latest(this).submissions.filter((item) => item.outcome === "rejected").map((item) => item.code);
  assert.deepEqual(codes, ["quote_not_found", "unread_evidence"]);
});

Given("写作会话提交的一节同时有不允许的组件属性、空的组件正文和无法解析的流程图", function (this: ApiWorld) {
  const script = draft();
  const finish = script.pop()!;
  const design = script.findIndex((step) => step.name === "write_section" && (step.input as { id: string }).id === "design");
  script.splice(design, 0, write("design", `<ur-source source="pull_request" quote="${prTitle}" verdict="match"></ur-source>`
    + `<ur-callout tone="note"></ur-callout><ur-diagram>flowchart TD\n  A["入口" --&gt; B</ur-diagram>`, { isError: true, includes: "3 处问题" }));
  this.review.modelOptions.readingScript = [...script, finish];
});

Then("这次提交被拒绝且拒绝原因同时列出三处问题", function (this: ApiWorld) {
  const rejected = latest(this).submissions.filter((item) => item.outcome === "rejected");
  assert.equal(rejected.length, 1);
  assert.match(rejected[0]!.reason ?? "", /3 处问题/);
  assert.match(rejected[0]!.reason ?? "", /不支持属性 verdict/);
  assert.match(rejected[0]!.reason ?? "", /没有内容/);
  assert.match(rejected[0]!.reason ?? "", /无法解析/);
});

Then("修正后的这一节被接受", function (this: ApiWorld) {
  assert.match(completed(this).sections.design ?? "", /改后：库存恢复/);
});

const revisedSummary = "<p>超时订单会恢复已占用的库存，后续订单可以继续使用这些库存。</p>";
const revisedDesign = `<p>订单超时后，入口调用库存恢复操作。</p><svg viewBox="0 0 240 60"><rect class="c-bad" x="10" y="10" width="90" height="36"></rect>`
  + `<text x="55" y="32">改前：不恢复</text><rect class="c-ok" x="140" y="10" width="90" height="36"></rect><text x="185" y="32">改后：恢复</text></svg>`;

Given("审读人对第一稿提出照抄缩写与越界评价两条意见", function (this: ApiWorld) {
  this.review.modelOptions.readingReviewScript = [{ name: "submit_review", input: { issues: [
    { section: "summary", kind: "jargon", quote: "释放后的库存", problem: "「释放」与「恢复」混用，读者分不清是否同一操作。", suggestion: "统一写成恢复库存。" },
    { section: "design", kind: "judgment", quote: "改动后", problem: "图题暗示改动修好了问题。", suggestion: "只描述改前改后的行为。" },
  ] }, result: ok }];
  // 第一稿结束后先停下，等宿主转来审读意见再修订。
  this.review.modelOptions.readingScript = [...draft(), { name: END_TURN, input: {}, result: ok },
    write("summary", revisedSummary), write("design", revisedDesign), { name: "finish_document", input: {}, result: ok }];
});

Then("解读记录这两条审读意见和被重写的章节", function (this: ApiWorld) {
  const review = latest(this).metrics?.review;
  assert.ok(review);
  assert.equal(review.failed, null);
  assert.deepEqual(review.issues.map((issue) => issue.kind), ["jargon", "judgment"]);
  assert.deepEqual(review.revisedSections, ["summary", "design"]);
});

Then("被重写章节的内容为修订后的版本", function (this: ApiWorld) {
  const content = completed(this);
  assert.equal(content.sections.summary, revisedSummary);
  assert.equal(content.sections.design, revisedDesign);
});

Given("本轮审读解读时模型不可用", function (this: ApiWorld) { this.review.modelOptions.readingReviewMode = "model-error"; });
Then("解读已完成且内容为第一稿", function (this: ApiWorld) {
  assert.match(completed(this).sections.summary ?? "", /释放后的库存可供后续订单使用/);
});
Then("解读记录审读失败的原因", function (this: ApiWorld) {
  const review = latest(this).metrics?.review;
  assert.ok(review);
  assert.ok(review.failed?.trim());
  assert.deepEqual(review.issues, []);
  assert.deepEqual(review.revisedSections, []);
});

Given("本轮生成解读时模型不可用", function (this: ApiWorld) { this.review.modelOptions.readingMode = "model-error"; });
Then("解读显示失败原因且本轮库存问题仍有评审结论", function (this: ApiWorld) {
  const document = latest(this);
  assert.equal(document.status, "failed");
  assert.ok(document.failureReason?.trim());
  assert.equal(document.content, null);
  const review = this.review.observedReview!;
  assert.equal(review.status, "completed");
  assert.deepEqual(review.findings.map((finding) => finding.title), [fixtureFinding.title]);
});

Given("本轮生成评审结论时模型不可用", function (this: ApiWorld) { this.review.modelOptions.mode = "model-error"; });
Then("评审失败且张伟仍能读取已完成的解读及代码摘录", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  assert.equal(review.status, "failed");
  assert.ok(review.failureReason?.trim());
  assert.equal(completed(this).excerpts[`${releasePath}#L3-L4`]?.excerpt, releaseExcerpt);
});

const regeneration = new WeakMap<ApiWorld, { status: number; message: string }>();
Given("库存变更的本轮评审与解读已完成", async function (this: ApiWorld) {
  await this.review.openPullRequest("李娜", this.review.gitlab.state.title);
  await this.review.waitForReview((review) => review.status === "completed");
  assert.equal((await this.review.waitForReading()).status, "completed");
});
When("张伟请求重新生成本轮解读", async function (this: ApiWorld) {
  this.review.holdModel("reading");
  const response = await this.review.request<{ document: ReadingDocumentRecord }>(`/api/reviews/${this.review.reviewId}/reading-documents`, {});
  assert.equal(response.status, 202);
});
When("在新解读生成期间再次请求重新生成", async function (this: ApiWorld) {
  const response = await this.review.request<{ error: { message: string } }>(`/api/reviews/${this.review.reviewId}/reading-documents`, {});
  regeneration.set(this, { status: response.status, message: response.body.error?.message ?? "" });
});
Then("第二次请求被拒绝并说明已有解读正在生成", function (this: ApiWorld) {
  const result = regeneration.get(this);
  assert.equal(result?.status, 409);
  assert.match(result.message, /正在生成/);
});
Then("本轮保留两份解读且新的一份已完成", async function (this: ApiWorld) {
  this.review.resumeModel();
  readings.set(this, await this.review.waitForReading());
  const documents = await this.review.readingDocuments();
  assert.deepEqual(documents.map((document) => document.status), ["completed", "completed"]);
  assert.ok(completed(this).sections.summary);
});

Then("本轮读取了该变更的提交信息与关闭的需求", function (this: ApiWorld) {
  for (const endpoint of ["commits", "closes_issues"]) {
    const requests = this.review.gitlab.requests.filter((request) => request.path.includes(`/merge_requests/${this.review.gitlab.iid}/${endpoint}`));
    assert.ok(requests.length > 0);
    assert.ok(requests.every((request) => request.method === "GET"));
  }
  assert.deepEqual(this.review.gitlab.state.writes, []);
});

Then("评审详情不包含综述", async function (this: ApiWorld) {
  const review = await this.review.readReview();
  assert.equal("overview" in review, false);
  const generator = this.review.model.requests.filter((request) => request.body.model === "fixture-generator"
    && request.body.tools?.some((tool) => tool.name === "finish_report"));
  assert.ok(generator.length);
  for (const request of generator) {
    assert.deepEqual(request.body.tools!.map((tool) => tool.name).filter((name) => name.startsWith("report_")).sort(),
      ["report_file_groups", "report_finding"]);
  }
});
Then("代码文件树按 Generator 提交的语义分组排列全部变更文件", function (this: ApiWorld) {
  const review = this.review.observedReview!;
  assert.ok(review.fileGroups.length);
  assert.ok(review.fileGroups.every((group) => group.name.trim() && group.files.length && group.files.every((file) => file.theme.trim())));
  assert.deepEqual(review.fileGroups.flatMap((group) => group.files.map((file) => file.path)).sort(),
    review.files.map((file) => file.deletedFile ? file.oldPath : file.newPath).sort());
});
