import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IdentityScenario, fixturePassword } from "./test-support.js";
import { defaultSsoConfig } from "./sso-config.js";
import { loginSsoAccount } from "./sso-accounts.js";
import type { SessionView } from "./service.js";
import * as passwords from "./password.js";
let app: IdentityScenario;
let teamId: string;
let ownerId: string;
beforeEach(async () => { app = new IdentityScenario(); await app.start(); const session = await app.setup(); teamId = session.user!.teamId; ownerId = session.user!.userId; });
afterEach(async () => { vi.restoreAllMocks(); await app.stop(); });
async function corporateUser() {
  const token = await loginSsoAccount(app.auth, { ...defaultSsoConfig, defaultTeamId: teamId }, "https://identity.example.test", "staff-zhaolei", { preferred_username: "zhaolei", name: "赵磊" });
  const cookie = `ureview_session=${token}`;
  const session = await app.request<SessionView>("/api/auth/session", undefined, { cookie });
  return { cookie, session: session.body };
}
it("企业新账号没有密码，禁止密码登录与改密，会话明确标记无密码", async () => {
  const employee = await corporateUser(); expect(employee.session.hasPassword).toBe(false);
  const verify = vi.spyOn(passwords, "verifyPassword");
  const login = await app.request("/api/auth/login", { username: "zhaolei", password: fixturePassword });
  expect(login).toMatchObject({ status: 401, body: { error: { code: "enterprise_account", message: "该账号使用企业账号登录" } } });
  expect(verify).toHaveBeenCalledWith(fixturePassword, null);
  expect((await app.request("/api/auth/password", { currentPassword: fixturePassword, newPassword: "next-password" }, { cookie: employee.cookie })).body)
    .toEqual({ error: { code: "password_unavailable", message: "该账号使用企业账号登录，不能修改密码" } });
  expect((await app.pool.query("SELECT password_hash FROM auth_users WHERE id=$1", [employee.session.user!.userId])).rows[0].password_hash).toBeNull();
  expect((await app.request<SessionView>("/api/auth/session")).body.hasPassword).toBe(true);
});
it("仅服务管理员密码登录独立于身份源可达性，错误密码与不存在账号仍执行密码校验", async () => {
  await app.request("/api/admin/members", { username: "lina", name: "李娜", password: fixturePassword, role: "admin" });
  const verify = vi.spyOn(passwords, "verifyPassword");
  const wrong = await app.request("/api/auth/login", { username: "lina", password: "wrong-password" });
  expect(wrong.body).toEqual({ error: { code: "invalid_credentials", message: "用户名或密码不正确" } });
  expect((await app.request("/api/service-sso", { version: 0, configuration: { ...defaultSsoConfig, passwordLogin: "service_admin" } }, { method: "PUT" })).status).toBe(200);
  expect((await app.request("/api/auth/login", { username: "lina", password: fixturePassword })).body)
    .toEqual({ error: { code: "enterprise_login_required", message: "请使用企业账号登录" } });
  expect((await app.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword })).status).toBe(200);
  expect((await app.request("/api/auth/login", { username: "zhang.wei", password: "wrong-password" })).body).toEqual(wrong.body);
  expect((await app.request("/api/auth/login", { username: "missing.employee", password: "wrong-password" })).body).toEqual(wrong.body);
  expect(verify).toHaveBeenCalledTimes(5); expect(verify).toHaveBeenCalledWith("wrong-password", undefined);
  expect((await app.request("/api/service-sso", { version: 1, configuration: defaultSsoConfig }, { method: "PUT" })).status).toBe(200);
  expect((await app.request("/api/auth/login", { username: "lina", password: fixturePassword })).status).toBe(200);
});
it("无密码与受限账号同样先执行用户名限流", async () => {
  await corporateUser();
  for (let attempt = 0; attempt < 10; attempt++) expect((await app.request("/api/auth/login", { username: "zhaolei", password: fixturePassword })).status).toBe(401);
  expect((await app.request("/api/auth/login", { username: "zhaolei", password: fixturePassword })).status).toBe(429);
  await app.request("/api/admin/members", { username: "lina", name: "李娜", password: fixturePassword, role: "admin" });
  await app.request("/api/service-sso", { version: 0, configuration: { ...defaultSsoConfig, passwordLogin: "service_admin" } }, { method: "PUT" });
  for (let attempt = 0; attempt < 10; attempt++) expect((await app.request("/api/auth/login", { username: "lina", password: fixturePassword })).status).toBe(401);
  expect((await app.request("/api/auth/login", { username: "lina", password: fixturePassword })).status).toBe(429);
});
it("企业账号可获服务权限，最后一名有密码的服务管理员必须保留", async () => {
  const employee = await corporateUser();
  expect((await app.request(`/api/service-users/${employee.session.user!.userId}`, { role: "service_admin" }, { method: "PUT" })).status).toBe(200);
  expect((await app.request(`/api/service-users/${ownerId}`, { role: "user" }, { method: "PUT" })).body)
    .toEqual({ error: { code: "last_password_service_admin", message: "至少需要保留一名可用密码登录的服务管理员" } });
  await app.request("/api/admin/members", { username: "lina", name: "李娜", password: fixturePassword, role: "admin" });
  const local = await app.request<SessionView>("/api/auth/login", { username: "lina", password: fixturePassword });
  expect((await app.request(`/api/service-users/${local.body.user!.userId}`, { role: "service_admin" }, { method: "PUT" })).status).toBe(200);
  expect((await app.request(`/api/service-users/${ownerId}`, { role: "user" }, { method: "PUT" })).status).toBe(200);
});
it("受限时错误密码与不存在账号返回相同错误，正确密码才提示企业登录", async () => {
  await app.request("/api/admin/members", { username: "lina", name: "李娜", password: fixturePassword, role: "admin" });
  await app.request("/api/service-sso", { version: 0, configuration: { ...defaultSsoConfig, passwordLogin: "service_admin" } }, { method: "PUT" });
  const wrong = await app.request("/api/auth/login", { username: "lina", password: "wrong-password" });
  const missing = await app.request("/api/auth/login", { username: "missing.employee", password: "wrong-password" });
  expect(wrong.status).toBe(401); expect(missing.status).toBe(401);
  expect(wrong.body).toEqual({ error: { code: "invalid_credentials", message: "用户名或密码不正确" } });
  expect(missing.body).toEqual(wrong.body);
  expect((await app.request("/api/auth/login", { username: "lina", password: fixturePassword })).body)
    .toEqual({ error: { code: "enterprise_login_required", message: "请使用企业账号登录" } });
});
