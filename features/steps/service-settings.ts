import assert from "node:assert/strict";
import { Before, After, Given, When, Then } from "@cucumber/cucumber";
import { IdentityScenario, fixturePassword } from "../support/identity-scenario.js";
import type { ApiWorld } from "../support/world.js";
import type { SessionView } from "../../packages/server/src/auth/service.js";
interface State { app: IdentityScenario; owner: string; member?: string; ownerId?: string; memberId?: string; result?: unknown; statuses: number[] }
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld) { const value = states.get(world); assert.ok(value); return value; }
Before({ tags: "@story:service-settings", timeout: 60_000 }, async function(this: ApiWorld) {
  const app = new IdentityScenario(); states.set(this, { app, owner: "", statuses: [] }); await app.start();
});
After({ tags: "@story:service-settings", timeout: 60_000 }, async function(this: ApiWorld) { await states.get(this)?.app.stop(); states.delete(this); });
Given("张伟是工作台的服务管理员", async function(this: ApiWorld) {
  const s = state(this); const session = await s.app.setup(); s.owner = s.app.cookie; s.ownerId = session.user!.userId;
  assert.equal(session.user?.serviceRole, "service_admin");
});
Given("李娜是团队管理员但没有服务权限", async function(this: ApiWorld) {
  const s = state(this); assert.equal((await s.app.request("/api/admin/members", { name: "李娜", username: "li.na", email: "li.na@example.test", password: fixturePassword, role: "admin" })).status, 201);
  const login = await s.app.request<SessionView>("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
  assert.equal(login.status, 200); assert.equal(login.body.user?.serviceRole, "user"); s.member = login.cookie; s.memberId = login.body.user!.userId;
});
When("张伟分别保存生成模型和评分模型的密钥", async function(this: ApiWorld) {
  const s = state(this); const result = await s.app.request("/api/service-settings", { version: 0, generatorApiKey: "sk-fixture-generation", graderApiKey: "sk-fixture-grading" }, { method: "PUT" });
  assert.equal(result.status, 200); s.result = (await s.app.request("/api/service-settings")).body;
});
Then("工作台显示两个模型的密钥均已配置但不展示密钥内容", function(this: ApiWorld) {
  const result = state(this).result; assert.ok(result && typeof result === "object" && "settings" in result);
  assert.deepEqual(result.settings, { version: 1, generator: { configured: true, source: "database", model: "", baseURL: "" }, grader: { configured: true, source: "database", model: "", baseURL: "" } });
  assert.ok(!JSON.stringify(result).includes("sk-fixture"));
});
When("张伟设置生成与评分模型的名称和接口地址", async function(this: ApiWorld) {
  const s = state(this);
  const result = await s.app.request("/api/service-settings", { version: 0,
    generatorModel: "deepseek-flash", graderModel: "deepseek-v4-pro",
    generatorBaseURL: "https://models.example.test/v1", graderBaseURL: "https://models.example.test/v1" }, { method: "PUT" });
  assert.equal(result.status, 200); s.result = (await s.app.request("/api/service-settings")).body;
});
Then("工作台保留保存的模型名称和接口地址", function(this: ApiWorld) {
  const result = state(this).result;
  assert.ok(result && typeof result === "object" && "settings" in result && result.settings && typeof result.settings === "object");
  assert.ok("generator" in result.settings && "grader" in result.settings);
  assert.deepEqual(result.settings.generator, { configured: false, source: "none", model: "deepseek-flash", baseURL: "https://models.example.test/v1" });
  assert.deepEqual(result.settings.grader, { configured: false, source: "none", model: "deepseek-v4-pro", baseURL: "https://models.example.test/v1" });
});
When("李娜尝试查看和修改服务配置", async function(this: ApiWorld) {
  const s = state(this); s.app.cookie = s.member!;
  s.statuses = [(await s.app.request("/api/service-settings")).status, (await s.app.request("/api/service-settings", { version: 0, generatorApiKey: "sk-denied" }, { method: "PUT" })).status];
});
Then("工作台提示需要服务管理员权限", function(this: ApiWorld) { assert.deepEqual(state(this).statuses, [403,403]); });
When("张伟尝试取消自己的唯一服务管理员权限", async function(this: ApiWorld) {
  const s = state(this); s.app.cookie = s.owner; s.statuses = [(await s.app.request(`/api/service-users/${s.ownerId}`, { role: "user" }, { method: "PUT" })).status];
});
Then("工作台提示至少保留一名服务管理员", function(this: ApiWorld) { assert.deepEqual(state(this).statuses, [409]); });
When("张伟授权李娜为服务管理员", async function(this: ApiWorld) {
  const s = state(this); s.app.cookie = s.owner;
  assert.equal((await s.app.request(`/api/service-users/${s.memberId}`, { role: "service_admin" }, { method: "PUT" })).status, 200);
});
Then("李娜可以管理服务配置", async function(this: ApiWorld) { const s = state(this); s.app.cookie = s.member!; assert.equal((await s.app.request("/api/service-settings")).status, 200); });
