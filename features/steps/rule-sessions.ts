import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import { buildApp } from "../../packages/server/src/http.js";
import { ManagedRuleScenario, managedDraft } from "../../packages/server/src/rules/managed/test-support.js";
import type { ManagedRule } from "../../packages/server/src/rules/managed-types.js";
import type { RuleSession } from "../../packages/server/src/rules/sessions-types.js";
import { bootReviewHost } from "../../packages/server/src/runtime/host.js";
import { startMockModelServer, type MockModelOptions } from "../../packages/server/src/runtime/test-support.js";

const refinement = "退款时允许零金额，请在规则中补充例外，保留其他约束。";
const refinedDraft = { ...managedDraft, body: `${managedDraft.body}退款金额允许为零。` };
interface State {
  app: ManagedRuleScenario; directory: string; options: MockModelOptions;
  model?: Awaited<ReturnType<typeof startMockModelServer>>;
  host?: Awaited<ReturnType<typeof bootReviewHost>>;
  session?: RuleSession; rule?: ManagedRule;
  memberRead?: RuleSession; memberWriteStatus?: number;
  otherReadStatus?: number; otherSessions?: RuleSession[];
  refinementRequestIndex?: number;
}
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State { const value = states.get(world); assert.ok(value); return value; }
async function startHost(value: State, restart = false) {
  assert.ok(value.model);
  value.host = await bootReviewHost({ homeDir: join(value.directory, "dsh"), models: value.model.models,
    onReady: async (_runtime, generator) => {
      if (!restart) await value.app.start({ generator: generator.generate.bind(generator), conversationGenerator: generator });
      else {
        value.app.app = buildApp({ pool: value.app.pool, auth: value.app.identity.auth, repositories: value.app.repositories,
          managedRules: value.app.managed, ruleGenerator: generator.generate.bind(generator), ruleConversationGenerator: generator,
          publicOrigin: "http://identity.example.test" });
        value.app.baseUrl = await value.app.app.listen({ host: "127.0.0.1", port: 0 });
      }
      return async () => { await value.app.app?.close(); value.app.app = undefined; };
    } });
}
Before({ tags: "@layer:api and @story:rule-sessions", timeout: 60_000 }, async function (this: ApiWorld) {
  const value: State = { app: new ManagedRuleScenario(), directory: await mkdtemp(join(tmpdir(), "ureview-rule-session-bdd-")), options: { ruleDraft: managedDraft } };
  states.set(this, value);
  value.model = await startMockModelServer(value.options);
  await startHost(value);
});
After({ tags: "@layer:api and @story:rule-sessions", timeout: 60_000 }, async function (this: ApiWorld) {
  const value = states.get(this); if (!value) return;
  const errors: unknown[] = [];
  for (const close of [() => value.host?.dispose(), () => value.app.stop(), () => value.model?.dispose(),
    () => rm(value.directory, { recursive: true, force: true })]) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  states.delete(this); if (errors.length) throw new AggregateError(errors, "规范会话场景清理失败");
});
async function turn(value: State, message: string) {
  assert.ok(value.session);
  const result = await value.app.request<{ session: RuleSession }>(`/api/rule-sessions/${value.session.id}/turns`,
    { version: value.session.version, message });
  assert.equal(result.status, 200, JSON.stringify(result.body)); value.session = result.body.session;
}
async function rules(value: State) {
  const result = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
  assert.equal(result.status, 200); return result.body.rules;
}
async function save(value: State, status: "draft" | "active") {
  assert.ok(value.session?.workingCopy);
  const result = await value.app.request<{ session: RuleSession; rule: ManagedRule }>(`/api/rule-sessions/${value.session.id}/save-rule`,
    { version: value.session.version, workingCopy: { ...value.session.workingCopy, status } });
  assert.equal(result.status, 200, JSON.stringify(result.body)); value.session = result.body.session; value.rule = result.body.rule;
}
Given("张伟通过对话生成了金额规范草稿", async function (this: ApiWorld) {
  const value = state(this);
  const result = await value.app.request<{ session: RuleSession }>("/api/rule-sessions", {});
  assert.equal(result.status, 201, JSON.stringify(result.body)); value.session = result.body.session;
  await turn(value, "交易金额必须使用整数分，请生成团队规范。");
  assert.equal(value.session.turns.at(-1)?.status, "completed");
  assert.equal(value.session.workingCopy?.body, managedDraft.body);
});
Given("张伟将该规范保存为草稿", async function (this: ApiWorld) { await save(state(this), "draft"); });
When("工作台重启后张伟重新打开生成会话", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = state(this), previous = value.session!;
  await value.host!.dispose(); delete value.host;
  await startHost(value, true);
  const result = await value.app.request<{ session: RuleSession }>(`/api/rule-sessions/${previous.id}`);
  assert.equal(result.status, 200); assert.deepEqual(result.body.session, previous); value.session = result.body.session;
});
When("张伟要求增加退款时允许零金额的例外", async function (this: ApiWorld) {
  const value = state(this); value.options.ruleDraft = refinedDraft; value.refinementRequestIndex = value.model!.requests.length;
  await turn(value, refinement);
});
Then("会话保留前一次要求和两轮生成结果", function (this: ApiWorld) {
  const value = state(this), session = value.session!;
  assert.equal(session.turns.length, 2); assert.ok(session.turns.every((item) => item.status === "completed"));
  assert.deepEqual(session.turns.map((item) => item.draft?.body), [managedDraft.body, refinedDraft.body]);
  assert.match(session.turns[0]!.message, /交易金额必须使用整数分/);
  const messages = value.model!.requests[value.refinementRequestIndex!]!.body.messages;
  const history = JSON.stringify(messages);
  assert.match(history, /交易金额必须使用整数分/); assert.match(history, /submit_rule/); assert.match(history, /退款时允许零金额/);
  const content = messages.flatMap((message) => typeof message.content === "string" ? [] : message.content);
  const previousSubmission = content.find((part) => part.type === "tool_use" && part.name === "submit_rule");
  assert.ok(previousSubmission); assert.deepEqual(previousSubmission.input, managedDraft);
  assert.ok(content.some((part) => part.type === "tool_result" && part.tool_use_id === previousSubmission.id));
  assert.equal("checkpoint" in session, false);
});
Then("已保存的规范仍保持调整前的内容", async function (this: ApiWorld) { const value = state(this); assert.deepEqual(await rules(value), [value.rule]); });
When("张伟确认保存并启用调整后的规范", async function (this: ApiWorld) { await save(state(this), "active"); });
Then("原规范更新为包含退款例外的已启用版本", async function (this: ApiWorld) {
  const value = state(this), saved = await rules(value); assert.equal(saved.length, 1);
  assert.equal(saved[0]!.id, value.session!.ruleId); assert.equal(saved[0]!.version, 2);
  assert.equal(saved[0]!.body, refinedDraft.body); assert.equal(saved[0]!.status, "active");
});
When("张伟要求微调时模型暂时不可用", async function (this: ApiWorld) {
  const value = state(this); value.options.ruleGenerationMode = "error"; await turn(value, refinement);
});
Then("会话显示失败原因并保留上一份草稿", function (this: ApiWorld) {
  const session = state(this).session!; assert.equal(session.turns.at(-1)?.status, "failed");
  assert.ok(session.turns.at(-1)?.error); assert.equal(session.workingCopy?.body, managedDraft.body);
  assert.doesNotMatch(JSON.stringify(session), /PRIVATE_MODEL_ERROR_SENTINEL/);
});
When("模型恢复后张伟再次要求增加退款例外", async function (this: ApiWorld) {
  const value = state(this); value.options.ruleGenerationMode = "success"; value.options.ruleDraft = refinedDraft;
  await turn(value, refinement);
});
Then("会话显示调整后的草稿且规范尚未启用", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.session!.turns.at(-1)?.status, "completed");
  assert.equal(value.session!.workingCopy?.body, refinedDraft.body); assert.deepEqual(await rules(value), []);
});
When("李娜作为普通成员打开该会话并尝试微调", async function (this: ApiWorld) {
  const value = state(this), session = value.session!, cookie = value.app.memberCookie;
  const result = await value.app.request<{ session: RuleSession }>(`/api/rule-sessions/${session.id}`, undefined, { cookie });
  assert.equal(result.status, 200); value.memberRead = result.body.session;
  value.memberWriteStatus = (await value.app.request(`/api/rule-sessions/${session.id}/turns`, { version: session.version, message: refinement }, { cookie })).status;
});
Then("李娜可以阅读对话但不能改变草稿", function (this: ApiWorld) {
  const value = state(this); assert.deepEqual(value.memberRead, value.session); assert.equal(value.memberWriteStatus, 403);
});
When("张伟切换到物流研发团队查找该会话", async function (this: ApiWorld) {
  const value = state(this), other = await value.app.otherTeam();
  value.otherReadStatus = (await value.app.request(`/api/rule-sessions/${value.session!.id}`, undefined, { cookie: other.cookie })).status;
  const result = await value.app.request<{ sessions: RuleSession[] }>("/api/rule-sessions", undefined, { cookie: other.cookie });
  assert.equal(result.status, 200); value.otherSessions = result.body.sessions;
});
Then("物流研发团队看不到该会话或草稿", function (this: ApiWorld) {
  const value = state(this); assert.equal(value.otherReadStatus, 404); assert.deepEqual(value.otherSessions, []);
});
