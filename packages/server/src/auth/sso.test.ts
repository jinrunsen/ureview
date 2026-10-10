import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdentityScenario, fixturePassword } from "./test-support.js";
import { defaultSsoConfig, type SsoConfig } from "./sso-config.js";
import { returnPath, fieldAt, validateIdToken } from "./sso-protocol.js";
import { loginSsoAccount, ssoUsername } from "./sso-accounts.js";
import { createHash } from "node:crypto";
let app: IdentityScenario;
let config: SsoConfig;
let version: number;
const nativeFetch = globalThis.fetch;
const issuer = "https://identity.example.test";
const secret = "private-client-secret";
const code = "private-authorization-code";
const accessToken = "private-access-token";
let nonce: string;
let failToken: boolean;
let tokenOverride: Record<string, unknown> | undefined;
let userinfoOverride: Record<string, unknown> | undefined;
let claims: Record<string, unknown>;
const jwt = (value: unknown) => `e30.${Buffer.from(JSON.stringify(value)).toString("base64url")}.signature`;
beforeEach(async () => {
  app = new IdentityScenario({ publicOrigin: "https://review.example.test" }); await app.start(); const session = await app.setup(); version = 0; failToken = false; tokenOverride = undefined; userinfoOverride = undefined;
  config = { ...defaultSsoConfig, enabled: true, issuer, clientId: "enterprise", defaultTeamId: session.user!.teamId };
  claims = { sub: "staff-zhaolei", preferred_username: "zhaolei", name: "赵磊", email: "zhaolei@example.test" };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (!url.startsWith(issuer)) return nativeFetch(input, init);
    if (url.endsWith("openid-configuration")) return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, userinfo_endpoint: `${issuer}/userinfo` });
    if (url.endsWith("/token")) {
      if (failToken) throw new Error(`${code} ${secret} ${accessToken} private-provider-response`);
      if (tokenOverride) return Response.json(tokenOverride);
      return Response.json({ access_token: accessToken, id_token: jwt({ ...claims, iss: issuer, aud: "enterprise", exp: Date.now() / 1000 + 60, nonce }) });
    }
    return Response.json(userinfoOverride ?? claims);
  });
  await save();
});
afterEach(async () => { vi.restoreAllMocks(); await app.stop(); });
async function save() { expect((await app.request("/api/service-sso", { version, configuration: config, clientSecret: secret }, { method: "PUT" })).status).toBe(200); version++; }
async function begin(returnTo = "/?rules=1") {
  const response = await nativeFetch(`${app.baseUrl}/api/auth/sso/start?returnTo=${encodeURIComponent(returnTo)}`, { redirect: "manual" });
  expect(response.status).toBe(302); const target = new URL(response.headers.get("location")!); nonce = target.searchParams.get("nonce")!;
  expect(response.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Max-Age=600; Secure");
  return { target, cookie: response.headers.get("set-cookie")!.split(";")[0]!, callback: `/api/auth/sso/callback?state=${target.searchParams.get("state")}&code=${code}` };
}
async function finish(attempt: Awaited<ReturnType<typeof begin>>, cookie = attempt.cookie) {
  return nativeFetch(`${app.baseUrl}${attempt.callback}`, { headers: { cookie }, redirect: "manual" });
}
it("字段只读自有属性，回跳拒绝外站、编码绕过及接口路径，用户名后缀不超长", () => {
  expect(fieldAt({ data: { userid: 10086 } }, "data.userid")).toBe(10086);
  expect(fieldAt({}, "constructor.name")).toBeUndefined();
  for (const path of ["//evil.test", "/\\evil.test", "/api/auth/logout", "/x/../api/auth/logout", "/%61pi/auth", "/%2f%2fevil.test", "/%252f%252fevil.test", "https://evil.test", "/\n/evil.test"]) expect(returnPath(path)).toBe("/");
  expect(returnPath("/?rules=1#details")).toBe("/?rules=1#details");
  expect(ssoUsername(" LI Na@example.test ")).toBe("lina");
  expect(ssoUsername("张".repeat(254), 12)).toHaveLength(254);
  expect(ssoUsername("zhaolei", 2)).toBe("zhaolei-2");
});
it("核对声明的签发者、接收者、过期时间、nonce 与多接收者授权方", () => {
  const valid = { sub: "staff", iss: issuer, aud: "enterprise", exp: Date.now() / 1000 + 60, nonce: "nonce" };
  expect(validateIdToken(jwt(valid), issuer, "enterprise", "nonce")).toMatchObject(valid);
  for (const patch of [{ iss: "https://other.test" }, { aud: "other" }, { exp: 0 }, { exp: "9999999999" }, { nonce: "other" }, { aud: ["enterprise", "other"] }, { azp: "other" }]) expect(() => validateIdToken(jwt({ ...valid, ...patch }), issuer, "enterprise", "nonce")).toThrow();
  expect(validateIdToken(jwt({ ...valid, aud: ["enterprise", "other"], azp: "enterprise" }), issuer, "enterprise", "nonce")).toBeTruthy();
});
it("发起记录仅存摘要且包含 S256，绑定 Cookie 与会话 Cookie 各自保留路径和安全属性", async () => {
  const attempt = await begin(); const row = (await app.pool.query("SELECT * FROM auth_sso_attempts")).rows[0];
  expect(row.state_hash).not.toBe(attempt.target.searchParams.get("state")); expect(row.binding_hash).not.toBe(attempt.cookie.split("=")[1]);
  expect(attempt.target.searchParams.get("code_challenge")).toBe(createHash("sha256").update(row.code_verifier).digest("base64url"));
  expect(attempt.target.searchParams.get("code_challenge_method")).toBe("S256");
  const result = await finish(attempt); expect(result.headers.get("location")).toBe("/?rules=1");
  const cookies = result.headers.getSetCookie(); expect(cookies.some((c) => c.includes("ureview_session=") && c.includes("SameSite=Strict") && c.includes("HttpOnly"))).toBe(true);
  expect(cookies.some((c) => c.includes("ureview_sso_binding=;") && c.includes("Path=/api/auth/sso") && c.includes("Max-Age=0"))).toBe(true);
  expect((await finish(attempt)).headers.get("location")).toBe("/?sso_error=expired");
});
it("错误浏览器也原子消耗 state，并发回调只有一次成功", async () => {
  const stolen = await begin(); expect((await finish(stolen, "")).headers.get("location")).toBe("/?sso_error=expired");
  expect((await finish(stolen)).headers.get("location")).toBe("/?sso_error=expired");
  const attempt = await begin(); const results = await Promise.all([finish(attempt), finish(attempt)]);
  expect(results.map((r) => r.headers.get("location")).sort()).toEqual(["/?rules=1", "/?sso_error=expired"]);
});
it("超时、配置变更、拒绝和上游故障不创建会话，响应与日志不泄露凭据和原始错误", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const expired = await begin(); await app.pool.query("UPDATE auth_sso_attempts SET expires_at=now()-interval '1 second'");
  expect((await finish(expired)).headers.get("location")).toBe("/?sso_error=expired");
  const stale = await begin(); await save(); expect((await finish(stale)).headers.get("location")).toBe("/?sso_error=expired");
  const denied = await begin(); denied.callback += `&error=${secret}&error_description=${accessToken}`;
  expect((await finish(denied)).headers.get("location")).toBe("/?sso_error=denied");
  const failed = await begin(); failToken = true; const result = await finish(failed);
  expect(result.headers.get("location")).toBe("/?sso_error=unavailable");
  const output = JSON.stringify([...result.headers]) + await result.text() + JSON.stringify(log.mock.calls);
  for (const value of [secret, code, accessToken, "private-provider-response"]) expect(output).not.toContain(value);
  expect((await app.pool.query("SELECT count(*) FROM auth_users")).rows[0].count).toBe("1");
  expect((await app.pool.query("SELECT count(*) FROM auth_sessions")).rows[0].count).toBe("1");
});
it("同名新账号并发首次登录使用不同后缀，同一身份再次登录复用账号", async () => {
  config.linking = "none";
  await Promise.all([loginSsoAccount(app.auth, config, issuer, "staff-1", claims), loginSsoAccount(app.auth, config, issuer, "staff-2", claims)]);
  expect((await app.pool.query("SELECT username FROM auth_users WHERE password_hash IS NULL ORDER BY username")).rows).toEqual([{ username: "zhaolei" }, { username: "zhaolei-2" }]);
  await loginSsoAccount(app.auth, config, issuer, "staff-1", claims);
  expect((await app.pool.query("SELECT count(*) FROM auth_sso_bindings")).rows[0].count).toBe("2");
});
it("身份源命名空间隔离相同标识，邮箱未验证或多人共用时不关联已有账号", async () => {
  config.linking = "none";
  await loginSsoAccount(app.auth, config, issuer, "staff", claims);
  await loginSsoAccount(app.auth, config, "https://other.test", "staff", claims);
  expect((await app.pool.query("SELECT count(*) FROM auth_sso_bindings")).rows[0].count).toBe("2");
  await app.request("/api/admin/members", { username: "lina", name: "李娜", email: "lina@example.test", password: fixturePassword, role: "admin" });
  config.linking = "email";
  await loginSsoAccount(app.auth, config, issuer, "ambiguous-email", { ...claims, preferred_username: "shared-email" });
  expect((await app.pool.query("SELECT username FROM auth_users WHERE username='shared-email'")).rowCount).toBe(1);
  await loginSsoAccount(app.auth, config, issuer, "lina-unverified", { preferred_username: "lina", email: "lina@example.test", email_verified: false });
  expect((await app.pool.query("SELECT username FROM auth_users WHERE username='lina-2'")).rowCount).toBe(1);
});

it("令牌声明、用户信息与标识错误仅返回安全类别，不泄露上游字段", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  for (const kind of ["issuer", "audience", "expiry", "nonce", "subject", "userinfo"]) {
    const attempt = await begin();
    const tokenClaims = { ...claims, iss: issuer, aud: "enterprise", exp: Date.now() / 1000 + 60, nonce,
      ...(kind === "issuer" ? { iss: secret } : {}), ...(kind === "audience" ? { aud: accessToken } : {}),
      ...(kind === "expiry" ? { exp: 0 } : {}), ...(kind === "nonce" ? { nonce: code } : {}), ...(kind === "subject" ? { sub: "" } : {}) };
    tokenOverride = { access_token: accessToken, id_token: jwt(tokenClaims), raw: "private-provider-response" };
    userinfoOverride = kind === "userinfo" ? { sub: secret, raw: "private-provider-response" } : undefined;
    const response = await finish(attempt);
    expect(response.headers.get("location")).toBe(`/?sso_error=${kind === "subject" ? "missing_identity" : "unavailable"}`);
    const output = JSON.stringify([...response.headers]) + await response.text() + JSON.stringify(log.mock.calls);
    for (const value of [secret, code, accessToken, "private-provider-response"]) expect(output).not.toContain(value);
  }
  expect((await app.pool.query("SELECT count(*) FROM auth_users")).rows[0].count).toBe("1");
});
it("到达 IP 限流后不创建发起记录，新登录清理过期记录", async () => {
  await begin(); await app.pool.query("UPDATE auth_sso_attempts SET expires_at=now()-interval '1 second'");
  await begin(); expect((await app.pool.query("SELECT count(*) FROM auth_sso_attempts")).rows[0].count).toBe("1");
  await app.pool.query("UPDATE auth_attempts SET attempts=30");
  const response = await nativeFetch(`${app.baseUrl}/api/auth/sso/start`, { redirect: "manual" });
  expect(response.headers.get("location")).toBe("/?sso_error=unavailable");
  expect((await app.pool.query("SELECT count(*) FROM auth_sso_attempts")).rows[0].count).toBe("1");
});

it("身份源的非空字符串标识保持原值，首尾空白不导致两个身份串号", async () => {
  config.linking = "none"; await save();
  claims.sub = " staff "; const first = await begin(); expect((await finish(first)).headers.get("location")).toBe("/?rules=1");
  claims.sub = "staff"; const second = await begin(); expect((await finish(second)).headers.get("location")).toBe("/?rules=1");
  expect((await app.pool.query("SELECT subject FROM auth_sso_bindings ORDER BY subject")).rows).toEqual([{ subject: " staff " }, { subject: "staff" }]);
});

it("超过安全整数范围的数字标识拒绝登录，避免精度丢失造成串号", async () => {
  config = { ...config, protocol: "oauth2", authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, userinfoEndpoint: `${issuer}/userinfo`, subjectField: "userid" };
  await save(); claims.userid = Number.MAX_SAFE_INTEGER + 1;
  const attempt = await begin(); expect((await finish(attempt)).headers.get("location")).toBe("/?sso_error=missing_identity");
  expect((await app.pool.query("SELECT count(*) FROM auth_users")).rows[0].count).toBe("1");
});
it.each(["username", "email"] as const)("按 %s 自动关联不会接管服务管理员，已绑定企业账号获授权后可继续登录", async (linking) => {
  const owner = (await app.request<{ user: { userId: string } }>("/api/auth/session")).body.user;
  config.linking = linking; await save();
  claims = { sub: "staff-zhangwei", preferred_username: "zhang.wei", name: "同名员工", email: "zhang.wei@example.test", email_verified: true };
  const response = await finish(await begin()); expect(response.headers.get("location")).toBe("/?rules=1");
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("ureview_session="))!.split(";")[0]!;
  const session = await app.request<{ user: { userId: string; username: string; role: string; serviceRole: string } }>("/api/auth/session", undefined, { cookie });
  expect(session.body.user.userId).not.toBe(owner.userId);
  expect(session.body.user).toMatchObject({ username: "zhang.wei-2", role: "member", serviceRole: "user" });
  const local = await app.request<{ user: { userId: string; serviceRole: string } }>("/api/auth/login", { username: "zhang.wei", password: fixturePassword });
  expect(local.status).toBe(200); expect(local.body.user).toMatchObject({ userId: owner.userId, serviceRole: "service_admin" });
  expect((await app.pool.query("SELECT user_id FROM auth_sso_bindings WHERE user_id=$1", [owner.userId])).rowCount).toBe(0);
  expect((await app.request(`/api/service-users/${session.body.user.userId}`, { role: "service_admin" }, { method: "PUT" })).status).toBe(200);
  const again = await finish(await begin());
  const nextCookie = again.headers.getSetCookie().find((value) => value.startsWith("ureview_session="))!.split(";")[0]!;
  expect((await app.request("/api/auth/session", undefined, { cookie: nextCookie })).body).toMatchObject({ user: { userId: session.body.user.userId, serviceRole: "service_admin" } });
});
