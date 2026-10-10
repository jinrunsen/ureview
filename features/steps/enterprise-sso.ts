import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { SessionView } from "../../packages/server/src/auth/service.js";
import assert from "node:assert/strict";
import { Before, After, Given, When, Then } from "@cucumber/cucumber";
import { IdentityScenario, fixturePassword } from "../support/identity-scenario.js";
import { SsoProvider } from "../support/sso-provider.js";
import { defaultSsoConfig, type SsoConfig } from "../../packages/server/src/auth/sso-config.js";
import type { ApiWorld } from "../support/world.js";
interface State { app: IdentityScenario; provider: SsoProvider; owner: string; config: SsoConfig; version: number; before?: unknown; result?: Record<string, unknown>; statuses: number[]; location?: string; binding?: string; callback?: string; loginCookie?: string; session?: SessionView; userId?: string; browserSession?: string; browserOrigin?: string }
const states = new WeakMap<ApiWorld, State>();
function state(world: ApiWorld) { const s = states.get(world); assert.ok(s); return s; }
Before({ tags: "@story:enterprise-sso", timeout: 60_000 }, async function(this: ApiWorld, { pickle }) {
  const browser = pickle.tags.some((tag) => tag.name === "@layer:e2e");
  let port = 0;
  if (browser) {
    const probe = createServer(); await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address(); assert.ok(address && typeof address !== "string"); port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
  }
  const browserOrigin = `http://localhost:${port}`;
  const app = new IdentityScenario(browser ? { port, publicOrigin: browserOrigin, webDir: fileURLToPath(new URL("../../packages/web/dist/", import.meta.url)) } : {});
  const provider = new SsoProvider(); provider.interactive = browser;
  const s: State = { app, provider, owner: "", config: { ...defaultSsoConfig }, version: 0, statuses: [] }; states.set(this, s);
  if (browser) { s.browserSession = `ureview-sso-${randomUUID()}`; s.browserOrigin = browserOrigin; }
  await provider.start(); await app.start(); const session = await app.setup(); s.owner = app.cookie;
  s.config = { ...defaultSsoConfig, enabled: true, issuer: provider.origin, clientId: "enterprise-client", defaultTeamId: session.user!.teamId };
});
After({ tags: "@story:enterprise-sso", timeout: 60_000 }, async function(this: ApiWorld) {
  const s = states.get(this); if (s) { if (s.browserSession) await browserCommand(s, "close").catch(() => {}); await s.app.stop(); await s.provider.stop(); states.delete(this); }
});
async function save(s: State, clientSecret = s.provider.clientSecret) {
  const result = await s.app.request<Record<string, unknown>>("/api/service-sso", { version: s.version, configuration: s.config, clientSecret }, { method: "PUT", cookie: s.owner });
  assert.equal(result.status, 200); s.version++; s.result = result.body;
}
Given("服务管理员张伟已保存 OIDC 配置和 Client Secret", async function(this: ApiWorld) { await save(state(this)); });
When("张伟只把登录按钮文案改为“使用公司统一认证登录”并保存", async function(this: ApiWorld) {
  const s = state(this); s.config.buttonLabel = "使用公司统一认证登录"; await save(s, "");
});
Then("配置显示 Client Secret 已配置但不显示明文", async function(this: ApiWorld) {
  const s = state(this); const result = await s.app.request<Record<string, unknown>>("/api/service-sso");
  assert.equal(result.body.secretConfigured, true); assert.ok(!JSON.stringify(result.body).includes(s.provider.clientSecret));
});
Given("支付团队管理员李娜不是服务管理员", async function(this: ApiWorld) {
  const s = state(this); await save(s); s.before = (await s.app.request("/api/service-sso")).body;
  assert.equal((await s.app.request("/api/admin/members", { username: "lina", name: "李娜", role: "admin", password: fixturePassword })).status, 201);
  const login = await s.app.request("/api/auth/login", { username: "lina", password: fixturePassword }); assert.equal(login.status, 200); s.app.cookie = login.cookie;
});
When("李娜尝试查看和修改企业登录配置", async function(this: ApiWorld) {
  const s = state(this); const read = await s.app.request<Record<string, unknown>>("/api/service-sso"); s.result = read.body;
  s.statuses = [read.status, (await s.app.request("/api/service-sso", { version: s.version, configuration: { ...s.config, buttonLabel: "未经授权" } }, { method: "PUT" })).status];
});
Then("李娜看不到配置内容，配置保持不变", async function(this: ApiWorld) {
  const s = state(this); assert.deepEqual(s.statuses, [403,403]); assert.ok(!("configuration" in s.result!));
  assert.deepEqual((await s.app.request("/api/service-sso", undefined, { cookie: s.owner })).body, s.before);
});
Given("服务管理员张伟正在填写 OIDC 配置", async function(this: ApiWorld) { const s = state(this); s.before = (await s.app.request("/api/service-sso")).body; });
When("张伟用填写的 Issuer 测试连接", async function(this: ApiWorld) {
  const s = state(this); const result = await s.app.request<Record<string, unknown>>("/api/service-sso/test", { protocol: "oidc", issuer: s.provider.origin }); assert.equal(result.status, 200); s.result = result.body;
});
Then("页面显示身份源可达以及读到的授权与令牌端点", function(this: ApiWorld) {
  const s = state(this); assert.equal(s.result?.ok, true); assert.equal(s.result?.authorizationEndpoint, `${s.provider.origin}/authorize`); assert.equal(s.result?.tokenEndpoint, `${s.provider.origin}/token`);
});
Then("已保存的配置保持不变", async function(this: ApiWorld) { const s = state(this); assert.deepEqual((await s.app.request("/api/service-sso")).body, s.before); });

async function enterpriseLogin(s: State, cookie?: string) {
  const start = await fetch(`${s.app.baseUrl}/api/auth/sso/start?returnTo=${encodeURIComponent('/?rules=1')}`, { redirect: "manual" });
  if (start.headers.get("location")?.startsWith("/")) { s.location = start.headers.get("location")!; return; }
  assert.equal(start.status, 302);
  const bind = start.headers.getSetCookie().find((value) => value.startsWith("ureview_sso_binding="));
  assert.ok(bind);
  assert.ok(bind.includes("SameSite=Lax") && bind.includes("Path=/api/auth/sso") && bind.includes("HttpOnly"));
  s.binding = bind.split(";")[0]!;
  // 授权端点属于身份源，不接收工作台 Cookie。
  const authorized = await fetch(start.headers.get("location")!, { redirect: "manual" });
  assert.equal(authorized.status, 302); s.callback = new URL(authorized.headers.get("location")!).pathname + new URL(authorized.headers.get("location")!).search;
  await callback(s, cookie ?? s.binding);
}
async function callback(s: State, cookie: string) {
  const response = await fetch(`${s.app.baseUrl}${s.callback}`, { redirect: "manual", headers: { cookie } });
  assert.equal(response.status, 302); s.location = response.headers.get("location")!;
  const sessionCookie = response.headers.getSetCookie().find((value) => value.startsWith("ureview_session="));
  if (sessionCookie) { assert.ok(sessionCookie.includes("HttpOnly") && sessionCookie.includes("SameSite=Strict")); s.loginCookie = sessionCookie.split(";")[0]!; }
  else s.loginCookie = "";
  const session = await s.app.request<SessionView>("/api/auth/session", undefined, { cookie: s.loginCookie ?? "" });
  s.session = session.body;
}
Given("服务管理员已按 OIDC 对接公司统一认证", async function(this: ApiWorld) { await save(state(this)); });
Given("服务管理员已按 OIDC 对接公司统一认证，新账号加入“数据面团队”", async function(this: ApiWorld) {
  const s = state(this); const team = await s.app.request<{ id: string }>("/api/admin/teams", { name: "数据面团队" }); assert.equal(team.status, 201); s.config.defaultTeamId = team.body.id; await save(s);
});
Given("员工赵磊在 uReview 中还没有账号", async function(this: ApiWorld) {
  const s = state(this); const users = await s.app.request<{ users: { username: string }[] }>("/api/service-users"); assert.ok(!users.body.users.some((user) => user.username === "zhaolei"));
});
When("赵磊使用企业账号登录", async function(this: ApiWorld) { await enterpriseLogin(state(this)); });
Then("赵磊进入 uReview，账号以成员身份属于数据面团队", function(this: ApiWorld) {
  const s = state(this); assert.equal(s.location, "/?rules=1"); assert.equal(s.session?.user?.name, "赵磊"); assert.equal(s.session.user.teamName, "数据面团队"); assert.equal(s.session.user.role, "member"); s.userId = s.session.user.userId;
});
When("赵磊退出后再次使用企业账号登录", async function(this: ApiWorld) { const s = state(this); assert.equal((await s.app.request("/api/auth/logout", {}, { cookie: s.loginCookie ?? "" })).status, 200); await enterpriseLogin(s); });
Then("赵磊进入的仍是同一个账号", function(this: ApiWorld) { const s = state(this); assert.equal(s.session?.user?.userId, s.userId); });
Then("赵磊仍可以使用企业账号登录", async function(this: ApiWorld) { const s = state(this); await enterpriseLogin(s); assert.equal(s.session?.user?.name, "赵磊"); });
Given("服务管理员已按 OIDC 对接公司统一认证，按用户名关联已有账号", async function(this: ApiWorld) { await save(state(this)); });
Given("支付团队管理员李娜已有用户名为“lina”的本地账号", async function(this: ApiWorld) {
  const s = state(this); const team = await s.app.request<{ id: string }>("/api/admin/teams", { name: "支付团队" });
  assert.equal((await s.app.request("/api/auth/team", { teamId: team.body.id })).status, 200);
  assert.equal((await s.app.request("/api/admin/members", { username: "lina", name: "李娜", role: "admin", password: fixturePassword })).status, 201);
  const login = await s.app.request<SessionView>("/api/auth/login", { username: "lina", password: fixturePassword }); s.userId = login.body.user!.userId;
});
When("李娜使用企业账号登录，统一认证返回的用户名为“lina”", async function(this: ApiWorld) {
  const s = state(this); s.provider.claims = { sub: "staff-lina", preferred_username: "lina", name: "李娜的新名字" }; await enterpriseLogin(s);
});
Then("李娜进入原有账号，仍是支付团队管理员", function(this: ApiWorld) { const s = state(this); assert.ok(s.session?.user); assert.equal(s.session.user.userId, s.userId); assert.equal(s.session.user.role, "admin"); assert.equal(s.session.user.teamName, "支付团队"); assert.equal(s.session.user.name, "李娜"); });
Then("李娜仍可以用原密码登录", async function(this: ApiWorld) { const s = state(this); const result = await s.app.request<SessionView>("/api/auth/login", { username: "lina", password: fixturePassword }); assert.equal(result.status, 200); assert.equal(result.body.user?.userId, s.userId); });
Given("服务管理员已按 OAuth2 对接自研统一认证，唯一标识字段为“data.userid”", async function(this: ApiWorld) {
  const s = state(this); s.config = { ...s.config, protocol: "oauth2", issuer: "", authorizationEndpoint: `${s.provider.origin}/oauth2/authorize`, tokenEndpoint: `${s.provider.origin}/oauth2/token`, userinfoEndpoint: `${s.provider.origin}/oauth2/get_user_info`, subjectField: "data.userid", usernameField: "data.username", nameField: "data.name", emailField: "data.email", tokenAuthMethod: "client_secret_post", scope: "" }; await save(s);
});
When("员工王芳使用企业账号登录，统一认证返回工号“10086”与姓名“王芳”", async function(this: ApiWorld) {
  const s = state(this); s.provider.claims = { userid: 10086, username: "wangfang", name: "王芳", email: "wangfang@example.test" }; await enterpriseLogin(s);
});
Then("王芳进入 uReview，账号姓名为王芳并绑定工号 10086", async function(this: ApiWorld) {
  const s = state(this); assert.equal(s.session?.user?.name, "王芳"); const id = s.session.user.userId;
  s.provider.claims.username = "wangfang.changed"; await enterpriseLogin(s); assert.equal(s.session?.user?.userId, id);
});
When("赵磊在另一个浏览器中打开别人发起登录后得到的回调链接", async function(this: ApiWorld) { await enterpriseLogin(state(this), ""); });
Then("登录失败并提示重新登录，赵磊没有进入 uReview", function(this: ApiWorld) { const s = state(this); assert.equal(s.location, "/?sso_error=expired"); assert.equal(s.session?.user, null); });
When("发起登录的浏览器再次打开已经用过的回调链接", async function(this: ApiWorld) { const s = state(this); await callback(s, s.binding!); });
Then("登录仍然失败", function(this: ApiWorld) { const s = state(this); assert.equal(s.location, "/?sso_error=expired"); assert.equal(s.session?.user, null); });
When("员工孙悦使用企业账号登录，统一认证返回的用户信息缺少工号", async function(this: ApiWorld) {
  const s = state(this); s.before = (await s.app.request("/api/service-users")).body; s.provider.claims = { username: "sunyue", name: "孙悦" }; await enterpriseLogin(s);
});
Then("登录失败并提示统一认证未返回用户标识，没有新建账号", async function(this: ApiWorld) { const s = state(this); assert.equal(s.location, "/?sso_error=missing_identity"); assert.equal(s.session?.user, null); assert.deepEqual((await s.app.request("/api/service-users", undefined, { cookie: s.owner })).body, s.before); });
Given("统一认证的令牌服务暂时无法访问", function(this: ApiWorld) { state(this).provider.tokenFailure = true; });
Then("登录页提示无法连接统一认证，赵磊没有进入 uReview", function(this: ApiWorld) { const s = state(this); assert.equal(s.location, "/?sso_error=unavailable"); assert.equal(s.session?.user, null); });
Given("服务管理员尚未启用企业账号登录", function(this: ApiWorld) { state(this).app.cookie = ""; });
When("访客打开登录页", async function(this: ApiWorld) { const s = state(this); s.session = (await s.app.request<SessionView>("/api/auth/session", undefined, { cookie: "" })).body; });
Then("登录页只提供用户名密码登录", function(this: ApiWorld) { const s = state(this); assert.equal(s.session?.user, null); assert.equal(s.session?.sso?.enabled, false); assert.equal(s.session.sso.passwordLogin, "all"); });
When("访客直接打开企业登录入口", async function(this: ApiWorld) { await enterpriseLogin(state(this)); });
Then("回到登录页并提示企业登录未启用", function(this: ApiWorld) { assert.equal(state(this).location, "/?sso_error=disabled"); });
Given("赵磊已通过企业账号登录并属于数据面团队", async function(this: ApiWorld) {
  const s = state(this); const team = await s.app.request<{ id: string }>("/api/admin/teams", { name: "数据面团队" }); s.config.defaultTeamId = team.body.id; await save(s); await enterpriseLogin(s); s.userId = s.session!.user!.userId;
});
Given("数据面团队管理员把赵磊移出团队", async function(this: ApiWorld) {
  const s = state(this); await s.app.pool.query("DELETE FROM team_members WHERE user_id=$1", [s.userId]);
});
Then("登录失败并提示账号尚未加入团队，请联系管理员", function(this: ApiWorld) { const s = state(this); assert.equal(s.location, "/?sso_error=no_team"); assert.equal(s.session?.user, null); });

const executeFile = promisify(execFile);
async function browserCommand(s: State, ...args: string[]) {
  assert.ok(s.browserSession);
  return (await executeFile("agent-browser", ["--session", s.browserSession, ...args], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout;
}
Given("员工赵磊未登录时打开了团队规范页的链接", { timeout: 30_000 }, async function(this: ApiWorld) {
  const s = state(this); await browserCommand(s, "open", `${s.browserOrigin}/?rules=1`);
  await browserCommand(s, "wait", "--text", "使用企业账号登录");
  const snapshot = await browserCommand(s, "snapshot", "-i"); assert.match(snapshot, /登录 uReview/); assert.match(snapshot, /使用企业账号登录/);
});
When("赵磊在登录页点击使用企业账号登录并在统一认证页完成登录", { timeout: 60_000 }, async function(this: ApiWorld) {
  const s = state(this);
  const login = /button "使用企业账号登录"[^\n]*ref=(e\d+)/.exec(await browserCommand(s, "snapshot", "-i")); assert.ok(login);
  await browserCommand(s, "click", `@${login[1]}`);
  await browserCommand(s, "wait", "--text", "确认登录");
  assert.equal(JSON.parse(await browserCommand(s, "eval", "location.origin")), s.provider.origin);
  const consent = /link "确认登录"[^\n]*ref=(e\d+)/.exec(await browserCommand(s, "snapshot", "-i")); assert.ok(consent);
  await browserCommand(s, "click", `@${consent[1]}`);
});
Then("浏览器回到团队规范页并显示赵磊已登录", { timeout: 30_000 }, async function(this: ApiWorld) {
  const s = state(this);
  await browserCommand(s, "wait", "--fn", 'Array.from(document.querySelectorAll("h1")).some(node => node.textContent === "团队规范") && document.body.innerText.includes("赵磊")');
  const snapshot = await browserCommand(s, "snapshot", "-i");
  assert.match(snapshot, /heading "团队规范"/); assert.match(snapshot, /赵磊，账号菜单/);
  const result: { url: string; sessionRequests: number; scriptCannotReadSession: boolean } = JSON.parse(await browserCommand(s, "eval",
    '({url:location.href,sessionRequests:performance.getEntriesByType("resource").filter(e=>new URL(e.name).pathname==="/api/auth/session").length,scriptCannotReadSession:!document.cookie.includes("ureview_session")})'));
  assert.equal(result.url, `${s.browserOrigin}/?rules=1`); assert.equal(result.sessionRequests, 1); assert.equal(result.scriptCannotReadSession, true);
  const jar: { data: { cookies: { name: string; httpOnly: boolean; sameSite: string }[] } } = JSON.parse(await browserCommand(s, "cookies", "get", "--json"));
  const session = jar.data.cookies.find((cookie) => cookie.name === "ureview_session"); assert.ok(session); assert.equal(session.httpOnly, true); assert.equal(session.sameSite, "Strict");
  assert.ok(!jar.data.cookies.some((cookie) => cookie.name === "ureview_sso_binding"));
});

Given("赵磊通过企业账号登录建立了账号", async function(this: ApiWorld) { const s = state(this); await save(s); await enterpriseLogin(s); assert.equal(s.session?.user?.username, "zhaolei"); });
When("赵磊用自己的用户名和一个密码登录", async function(this: ApiWorld) { const s = state(this); const result = await s.app.request<Record<string, unknown>>("/api/auth/login", { username: "zhaolei", password: fixturePassword }, { cookie: "" }); s.statuses = [result.status]; s.result = result.body; });
Then("登录失败并提示该账号使用企业账号登录", function(this: ApiWorld) { const s = state(this); assert.deepEqual(s.statuses, [401]); assert.deepEqual(s.result, { error: { code: "enterprise_account", message: "该账号使用企业账号登录" } }); });
Given("服务管理员张伟把密码登录设为仅服务管理员可用", async function(this: ApiWorld) {
  const s = state(this); assert.equal((await s.app.request("/api/admin/members", { username: "lina", name: "李娜", role: "admin", password: fixturePassword })).status, 201);
  s.config.passwordLogin = "service_admin"; await save(s);
});
When("支付团队管理员李娜用正确的密码登录", async function(this: ApiWorld) { const s = state(this); const result = await s.app.request<Record<string, unknown>>("/api/auth/login", { username: "lina", password: fixturePassword }, { cookie: "" }); s.statuses = [result.status]; s.result = result.body; });
Then("登录失败并提示请使用企业账号登录", function(this: ApiWorld) { const s = state(this); assert.deepEqual(s.statuses, [401]); assert.deepEqual(s.result, { error: { code: "enterprise_login_required", message: "请使用企业账号登录" } }); });
When("张伟用正确的密码登录", async function(this: ApiWorld) { const s = state(this); const result = await s.app.request<SessionView>("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" }); assert.equal(result.status, 200); s.session = result.body; });
Then("张伟进入 uReview", function(this: ApiWorld) { const s = state(this); assert.equal(s.session?.user?.username, "zhang.wei"); assert.equal(s.session.user.serviceRole, "service_admin"); });
Given("服务管理员张伟的本地账号用户名为“zhangwei”", async function(this: ApiWorld) {
  const s = state(this);
  const created = await s.app.request<{ id: string }>("/api/admin/members", { username: "zhangwei", name: "张伟", role: "admin", password: fixturePassword });
  assert.equal(created.status, 201);
  const login = await s.app.request<SessionView>("/api/auth/login", { username: "zhangwei", password: fixturePassword });
  assert.equal(login.status, 200); s.userId = login.body.user!.userId;
  assert.equal((await s.app.request(`/api/service-users/${s.userId}`, { role: "service_admin" }, { method: "PUT", cookie: s.owner })).status, 200);
});
When("员工使用企业账号登录，统一认证返回的用户名为“zhangwei”", async function(this: ApiWorld) {
  const s = state(this); s.provider.claims = { sub: "employee-zhangwei", preferred_username: "zhangwei", name: "同名员工" }; await enterpriseLogin(s);
});
Then("员工进入的是新建的成员账号，不具有服务管理员权限", function(this: ApiWorld) {
  const s = state(this); assert.ok(s.session?.user); assert.notEqual(s.session.user.userId, s.userId);
  assert.equal(s.session.user.username, "zhangwei-2"); assert.equal(s.session.user.role, "member"); assert.equal(s.session.user.serviceRole, "user");
});
Then("张伟仍可以用原密码登录并保留服务管理员权限", async function(this: ApiWorld) {
  const s = state(this); const login = await s.app.request<SessionView>("/api/auth/login", { username: "zhangwei", password: fixturePassword }, { cookie: "" });
  assert.equal(login.status, 200); assert.equal(login.body.user?.userId, s.userId); assert.equal(login.body.user?.serviceRole, "service_admin");
});
