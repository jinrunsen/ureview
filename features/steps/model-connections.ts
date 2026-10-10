import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { ModelConnectionScenario, candidateModelKey, savedModelKey } from "../support/model-connection-scenario.js";
import { fixturePassword } from "../support/identity-scenario.js";
import type { ApiWorld } from "../support/world.js";

interface State { app: ModelConnectionScenario; before?: unknown; result?: unknown; statuses?: number[]; rejectedKey?: string }
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State { const value = states.get(world); assert.ok(value); return value; }
Before({ tags: "@story:model-connections and @layer:api", timeout: 60_000 }, async function(this: ApiWorld) {
  const app = new ModelConnectionScenario(); states.set(this, { app }); await app.start();
});
After({ tags: "@story:model-connections and @layer:api", timeout: 60_000 }, async function(this: ApiWorld) { await states.get(this)?.app.stop(); states.delete(this); });
Given("张伟已保存生成与评分模型的连接配置", async function(this: ApiWorld) {
  const s = state(this); const config = await s.app.identity.request("/api/service-settings"); assert.equal(config.status, 200); s.before = config.body;
});
When("张伟请求查看生成模型的密钥", async function(this: ApiWorld) {
  const s = state(this); const result = await s.app.identity.request("/api/service-settings/generator/reveal-key", { version: 1 }); assert.equal(result.status, 200); s.result = result.body;
});
Then("展示已保存的生成密钥且常规配置摘要不包含密钥", async function(this: ApiWorld) {
  const s = state(this); assert.deepEqual(s.result, { apiKey: savedModelKey, version: 1 });
  assert.deepEqual((await s.app.identity.request("/api/service-settings")).body, s.before);
  assert.ok(!JSON.stringify(s.before).includes(savedModelKey)); assert.equal(s.app.requests.length, 0);
});
When("张伟验证当前填写的新模型地址和密钥", async function(this: ApiWorld) {
  const s = state(this); const result = await s.app.identity.request("/api/service-settings/generator/verify", {
    version: 1, model: "deepseek-flash-candidate", baseURL: `${s.app.modelURL}/candidate/v1`, apiKey: candidateModelKey,
  }); assert.equal(result.status, 200); s.result = result.body;
});
function successful(result: unknown) {
  assert.ok(result && typeof result === "object" && "verification" in result);
  const value = result.verification; assert.ok(value && typeof value === "object" && "ok" in value && "latencyMs" in value);
  assert.equal(value.ok, true); assert.ok(typeof value.latencyMs === "number" && value.latencyMs >= 0);
}
Then("验证使用新连接完成模型调用并保留已保存的配置", async function(this: ApiWorld) {
  const s = state(this); successful(s.result); assert.equal(s.app.requests.length, 1);
  assert.equal(s.app.requests[0]?.path, "/candidate/v1/chat/completions");
  assert.equal(s.app.requests[0]?.body.model, "deepseek-flash-candidate");
  assert.equal(s.app.requests[0]?.authorization, `Bearer ${candidateModelKey}`);
  assert.match(s.app.requests[0]!.userAgent, /deepseek-harness/);
  assert.deepEqual((await s.app.identity.request("/api/service-settings")).body, s.before);
  assert.deepEqual((await s.app.identity.request("/api/service-settings/generator/reveal-key", { version: 1 })).body, { apiKey: savedModelKey, version: 1 });
});
When("张伟验证已保存的生成模型连接", async function(this: ApiWorld) {
  const s = state(this); const result = await s.app.identity.request("/api/service-settings/generator/verify", {
    version: 1, model: "deepseek-flash", baseURL: `${s.app.modelURL}/v1`,
  }); assert.equal(result.status, 200); s.result = result.body;
});
Then("验证使用已保存的密钥完成模型调用", function(this: ApiWorld) {
  const s = state(this); successful(s.result); assert.equal(s.app.requests.length, 2);
  assert.equal(s.app.requests[1]?.authorization, `Bearer ${savedModelKey}`);
  assert.equal(s.app.requests[1]?.body.model, "deepseek-flash");
});
When("张伟验证一个被模型服务拒绝的密钥", async function(this: ApiWorld) {
  const s = state(this); s.rejectedKey = "sk-fixture-rejected-model";
  const result = await s.app.identity.request("/api/service-settings/generator/verify", {
    version: 1, model: "deepseek-flash", baseURL: `${s.app.modelURL}/v1`, apiKey: s.rejectedKey,
  }); assert.equal(result.status, 200); s.result = result.body;
});
Then("工作台提示认证失败且不暴露密钥或上游错误正文", async function(this: ApiWorld) {
  const s = state(this); const result = s.result; assert.ok(result && typeof result === "object" && "verification" in result);
  assert.ok(result.verification && typeof result.verification === "object" && "ok" in result.verification && "code" in result.verification);
  assert.equal(result.verification.ok, false); assert.equal(result.verification.code, "authentication_failed");
  const output = JSON.stringify(result); assert.ok(!output.includes(s.rejectedKey!)); assert.ok(!output.includes("PRIVATE_AUTH_DETAIL"));
  assert.equal(s.app.requests.length, 1); assert.deepEqual((await s.app.identity.request("/api/service-settings")).body, s.before);
});
Given("李娜只有团队管理员权限", async function(this: ApiWorld) {
  const s = state(this); const app = s.app.identity;
  assert.equal((await app.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "admin" })).status, 201);
  const login = await app.request("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" }); assert.equal(login.status, 200); app.cookie = login.cookie;
});
When("李娜尝试查看模型密钥和验证调用", async function(this: ApiWorld) {
  const s = state(this); s.statuses = [
    (await s.app.identity.request("/api/service-settings/generator/reveal-key", { version: 1 })).status,
    (await s.app.identity.request("/api/service-settings/generator/verify", { version: 1, model: "deepseek-flash", baseURL: `${s.app.modelURL}/v1` })).status,
  ];
});
Then("两项操作都被拒绝且没有发起模型调用", function(this: ApiWorld) {
  const s = state(this); assert.deepEqual(s.statuses, [403, 403]); assert.equal(s.app.requests.length, 0);
});
