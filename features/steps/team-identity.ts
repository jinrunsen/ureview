import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { SessionView, TeamSummary } from "../../packages/server/src/auth/service.js";
import { DEFAULT_TEAM_ID } from "../../packages/server/src/db/tenant.js";
import { fixturePassword, fixtureRepository, IdentityScenario } from "../support/identity-scenario.js";
import type { ApiWorld } from "../support/world.js";

interface State {
  app: IdentityScenario; session?: SessionView; team?: TeamSummary; statuses?: number[]; repositories?: Array<{ name: string }>;
  memberUsername?: string; memberResponse?: { status: number; body: { error?: { code: string } } };
}
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld): State {
  const value = states.get(world);
  assert.ok(value);
  return value;
}
Before({ tags: "@story:team-identity", timeout: 60_000 }, async function (this: ApiWorld) {
  const app = new IdentityScenario();
  states.set(this, { app });
  await app.start();
});
After({ tags: "@story:team-identity", timeout: 60_000 }, async function (this: ApiWorld) {
  await states.get(this)?.app.stop();
  states.delete(this);
});

async function addMember(app: IdentityScenario): Promise<void> {
  assert.equal((await app.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "member" })).status, 201);
}
async function login(app: IdentityScenario, username: string): Promise<SessionView> {
  const response = await app.request<SessionView>("/api/auth/login", { username, password: fixturePassword }, { cookie: "" });
  assert.equal(response.status, 200);
  app.cookie = response.cookie;
  return response.body;
}

Given("工作台尚未创建任何账号", async function (this: ApiWorld) {
  const response = await state(this).app.request<SessionView>("/api/auth/session");
  assert.equal(response.status, 200);
  assert.equal(response.body.setupRequired, true);
});
When("张伟使用服务器初始化码创建管理员账号", async function (this: ApiWorld) {
  const current = state(this);
  current.session = await current.app.setup();
});
Then("张伟成为默认团队的管理员", function (this: ApiWorld) {
  assert.equal(state(this).session?.user?.role, "admin");
  assert.equal(state(this).session?.user?.teamId, DEFAULT_TEAM_ID);
});
When("张伟退出后使用正确的用户名密码登录", async function (this: ApiWorld) {
  const current = state(this);
  assert.equal((await current.app.request("/api/auth/logout", {})).status, 200);
  current.session = await login(current.app, "zhang.wei");
});
Then("张伟重新进入默认团队", function (this: ApiWorld) {
  assert.equal(state(this).session?.user?.teamId, DEFAULT_TEAM_ID);
  assert.equal(state(this).session?.user?.name, "张伟");
});

Given("张伟已接入库存服务仓库并添加普通成员李娜", async function (this: ApiWorld) {
  const app = state(this).app;
  await app.setup();
  assert.equal((await app.request("/api/repositories", fixtureRepository)).status, 201);
  await addMember(app);
});
When("李娜登录并查看仓库", async function (this: ApiWorld) {
  const current = state(this);
  await login(current.app, "li.na");
  const response = await current.app.request<{ repositories: Array<{ name: string }> }>("/api/repositories");
  assert.equal(response.status, 200);
  current.repositories = response.body.repositories;
});
Then("李娜可以看到库存服务仓库", function (this: ApiWorld) {
  assert.deepEqual(state(this).repositories?.map((item) => item.name), ["inventory-service"]);
});
When("李娜尝试接入仓库和创建团队", async function (this: ApiWorld) {
  const current = state(this);
  current.statuses = [(await current.app.request("/api/repositories", fixtureRepository)).status,
    (await current.app.request("/api/admin/teams", { name: "支付研发" })).status];
});
Then("工作台提示这些操作需要管理员权限", function (this: ApiWorld) { assert.deepEqual(state(this).statuses, [403, 403]); });

Given("张伟管理默认团队和支付研发团队且李娜只属于默认团队", async function (this: ApiWorld) {
  const current = state(this);
  await current.app.setup();
  await addMember(current.app);
  const response = await current.app.request<TeamSummary>("/api/admin/teams", { name: "支付研发" });
  assert.equal(response.status, 201);
  current.team = response.body;
});
Given("默认团队已接入库存服务仓库", async function (this: ApiWorld) {
  assert.equal((await state(this).app.request("/api/repositories", fixtureRepository)).status, 201);
});
When("张伟切换到支付研发团队", async function (this: ApiWorld) {
  const current = state(this);
  assert.equal((await current.app.request("/api/auth/team", { teamId: current.team?.id })).status, 200);
});
Then("张伟看不到默认团队的库存服务仓库", async function (this: ApiWorld) {
  const response = await state(this).app.request<{ repositories: unknown[] }>("/api/repositories");
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.repositories, []);
});
When("李娜尝试切换到支付研发团队", async function (this: ApiWorld) {
  const current = state(this);
  await login(current.app, "li.na");
  current.statuses = [(await current.app.request("/api/auth/team", { teamId: current.team?.id })).status];
  current.session = (await current.app.request<SessionView>("/api/auth/session")).body;
});
Then("李娜被拒绝并仍然处于默认团队", function (this: ApiWorld) {
  assert.deepEqual(state(this).statuses, [403]);
  assert.equal(state(this).session?.user?.teamId, DEFAULT_TEAM_ID);
});

Given("张伟已登录评审工作台", async function (this: ApiWorld) { await state(this).app.setup(); });
When("张伟添加没有用户名的成员", async function (this: ApiWorld) {
  const current = state(this);
  current.memberResponse = await current.app.request("/api/admin/members", {
    email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "member",
  });
});
Then("工作台要求填写用户名", async function (this: ApiWorld) {
  const current = state(this);
  assert.equal(current.memberResponse?.status, 400);
  assert.equal(current.memberResponse?.body.error?.code, "invalid_input");
  const members = await current.app.request<{ members: Array<{ username: string }> }>("/api/team/members");
  assert.equal(members.status, 200);
  assert.deepEqual(members.body.members.map((member) => member.username), ["zhang.wei"]);
});
When("张伟以用户名 {string} 添加不填写邮箱的普通成员李娜", async function (this: ApiWorld, username: string) {
  const current = state(this);
  const response = await current.app.request("/api/admin/members", { username, name: "李娜", password: fixturePassword, role: "member" });
  assert.equal(response.status, 201);
  current.memberUsername = username;
});
Then("李娜可以使用用户名和密码登录且邮箱未填写", async function (this: ApiWorld) {
  const current = state(this);
  assert.ok(current.memberUsername);
  current.session = await login(current.app, current.memberUsername);
  assert.equal(current.session.user?.username, current.memberUsername);
  assert.equal(current.session.user?.name, "李娜");
  assert.equal(current.session.user?.role, "member");
  assert.equal(current.session.user?.email, null);
});
When("张伟退出账号后继续访问仓库列表", async function (this: ApiWorld) {
  const current = state(this);
  assert.equal((await current.app.request("/api/auth/logout", {})).status, 200);
  current.statuses = [(await current.app.request("/api/repositories")).status];
});
Then("工作台要求张伟重新登录", function (this: ApiWorld) { assert.deepEqual(state(this).statuses, [401]); });
