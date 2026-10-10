import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdentityScenario, fixturePassword } from "./test-support.js";
import { defaultSsoConfig, validateSsoConfig, ssoUrl } from "./sso-config.js";
let app: IdentityScenario;
beforeEach(async () => { app = new IdentityScenario(); await app.start(); });
afterEach(async () => { vi.restoreAllMocks(); await app.stop(); });
it("配置密钥加密保存、留空保留、读取隐藏，并发保存冲突", async () => {
  const session = await app.setup();
  const configuration = { ...defaultSsoConfig, enabled: true, issuer: "https://login.example.test", clientId: "enterprise", defaultTeamId: session.user!.teamId };
  const input = { version: 0, configuration, clientSecret: "secret-do-not-leak" };
  const saved = await app.request("/api/service-sso", input, { method: "PUT" });
  expect(saved.status).toBe(200); expect(JSON.stringify(saved.body)).not.toContain(input.clientSecret);
  const before = (await app.pool.query<{ client_secret: Buffer }>("SELECT client_secret FROM service_sso")).rows[0]!.client_secret;
  expect(before.toString()).not.toContain(input.clientSecret);
  expect((await app.request("/api/service-sso", input, { method: "PUT" })).status).toBe(409);
  expect((await app.request("/api/service-sso", { ...input, version: 1, clientSecret: "", configuration: { ...configuration, buttonLabel: "公司登录" } }, { method: "PUT" })).body).toMatchObject({ version: 2, secretConfigured: true });
  expect((await app.request("/api/service-sso", { version: 2, configuration }, { method: "PUT" })).status).toBe(200);
});
it("启用时拒绝不完整配置，停用时保留填写值", async () => {
  await app.setup();
  expect((await app.request("/api/service-sso", { version: 0, configuration: { ...defaultSsoConfig, enabled: true } }, { method: "PUT" })).status).toBe(400);
  expect((await app.request("/api/service-sso", { version: 0, configuration: defaultSsoConfig }, { method: "PUT" })).status).toBe(200);
  for (const field of ["clientId", "subjectField", "defaultTeamId", "issuer"]) expect(() => validateSsoConfig({ ...defaultSsoConfig, enabled: true, [field]: "" })).toThrow();
  for (const url of ["http://login.example.test", "file:///tmp/secret", "https://user:password@login.example.test", "https://login.example.test/#secret"]) expect(() => ssoUrl(url)).toThrow();
  expect(ssoUrl("http://localhost:8080")).toBe("http://localhost:8080/");
});
it("普通管理员与未登录访客不能读取、保存或测试配置，写请求仍验证来源", async () => {
  await app.setup();
  await app.request("/api/admin/members", { username: "lina", name: "李娜", password: fixturePassword, role: "admin" });
  const login = await app.request("/api/auth/login", { username: "lina", password: fixturePassword });
  for (const cookie of [login.cookie, ""]) {
    const status = cookie ? 403 : 401;
    expect((await app.request("/api/service-sso", undefined, { cookie })).status).toBe(status);
    expect((await app.request("/api/service-sso", { version: 0, configuration: defaultSsoConfig }, { cookie, method: "PUT" })).status).toBe(status);
    expect((await app.request("/api/service-sso/test", { protocol: "oidc", issuer: "http://localhost" }, { cookie })).status).toBe(status);
  }
  expect((await app.request("/api/service-sso", { version: 0, configuration: defaultSsoConfig }, { method: "PUT", headers: { origin: "https://foreign.example.test" } })).status).toBe(403);
});
it("测试连接失败不回显外部错误或提交的密钥，不保存配置", async () => {
  await app.setup(); const before = await app.request("/api/service-sso");
  const result = await app.request("/api/service-sso/test", { protocol: "oidc", issuer: "http://127.0.0.1:1", clientSecret: "private-secret" });
  expect(result.body).toEqual({ ok: false, code: "unavailable" }); expect((await app.request("/api/service-sso")).body).toEqual(before.body);
});
it("无密码账号安全拒绝密码校验，初始化仍保持已完成", async () => {
  const session = await app.setup();
  await app.pool.query("UPDATE auth_users SET password_hash=NULL WHERE id=$1", [session.user!.userId]);
  expect((await app.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword })).status).toBe(401);
  expect((await app.request("/api/auth/password", { currentPassword: fixturePassword, newPassword: "next-password" })).status).toBe(403);
  expect(await app.auth.setupRequired()).toBe(false);
});

it("连接测试区分网络、无效文档和 Issuer 不一致，响应与日志仅保留安全诊断", async () => {
  await app.setup(); const before = (await app.request("/api/service-sso")).body;
  const nativeFetch = globalThis.fetch;
  const issuer = "https://identity.example.test";
  const document = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` };
  const privateValue = "private-provider-secret-response";
  let respond: () => Response = () => { throw new Error(privateValue); };
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => String(input).startsWith(issuer) ? Promise.resolve().then(respond) : nativeFetch(input, init));
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const run = async (configuredIssuer = issuer) => (await app.request("/api/service-sso/test", { protocol: "oidc", issuer: configuredIssuer, clientSecret: privateValue })).body;
  expect(await run()).toEqual({ ok: false, code: "unavailable" });
  respond = () => new Response(privateValue, { status: 503 });
  expect(await run()).toEqual({ ok: false, code: "unavailable" });
  for (const body of [privateValue, JSON.stringify({ raw: privateValue }), JSON.stringify({ ...document, token_endpoint: "file:///private" }), JSON.stringify({ ...document, issuer: `${issuer}?secret=${privateValue}` })]) {
    respond = () => new Response(body);
    expect(await run()).toEqual({ ok: false, code: "invalid_discovery" });
  }
  respond = () => Response.json({ ...document, raw: privateValue });
  expect(await run(`${issuer}/`)).toEqual({ ok: false, code: "issuer_mismatch", discoveredIssuer: issuer });
  expect(await run()).toMatchObject({ ok: true, code: "reachable", issuer });
  expect(JSON.stringify(log.mock.calls)).not.toContain(privateValue);
  expect((await app.request("/api/service-sso")).body).toEqual(before);
});
