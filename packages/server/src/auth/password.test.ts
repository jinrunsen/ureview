import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionView } from "./service.js";
import { fixturePassword, IdentityScenario } from "./test-support.js";

let scenario: IdentityScenario;
beforeEach(async () => { scenario = new IdentityScenario(); await scenario.start(); });
afterEach(async () => { await scenario.stop(); });

describe("本人修改密码", () => {
  it("成员修改本人密码后保留当前会话，撤销其他会话，其他账号不受影响", async () => {
    const admin = await scenario.setup();
    const adminCookie = scenario.cookie;
    await scenario.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "member" });
    const login = { username: "li.na", password: fixturePassword };
    const member = await scenario.request<SessionView>("/api/auth/login", login, { cookie: "" });
    const otherSession = await scenario.request("/api/auth/login", login, { cookie: "" });
    scenario.cookie = member.cookie;
    const newPassword = "Chengdu-Changed-2026!";
    const changed = await scenario.request<SessionView>("/api/auth/password", {
      currentPassword: fixturePassword, newPassword, userId: admin.user?.userId,
    });
    expect(changed.status).toBe(200);
    expect(changed.body.user).toEqual(member.body.user);
    expect((await scenario.request<SessionView>("/api/auth/session")).body.user).toEqual(member.body.user);
    expect((await scenario.request("/api/repositories", undefined, { cookie: otherSession.cookie })).status).toBe(401);
    expect((await scenario.request("/api/repositories", undefined, { cookie: adminCookie })).status).toBe(200);
    expect((await scenario.request("/api/auth/login", login, { cookie: "" })).status).toBe(401);
    expect((await scenario.request("/api/auth/login", { ...login, password: newPassword }, { cookie: "" })).status).toBe(200);
    expect((await scenario.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" })).status).toBe(200);
  });

  it("错误当前密码和不合长度的新密码不改变密码或会话，接受六至三十二字符", async () => {
    await scenario.setup();
    const login = { username: "zhang.wei", password: fixturePassword };
    const otherSession = await scenario.request("/api/auth/login", login, { cookie: "" });
    const wrong = await scenario.request("/api/auth/password", { currentPassword: "wrong-password", newPassword: "next-password" });
    expect(wrong).toMatchObject({ status: 400, body: { error: { code: "invalid_current_password" } } });
    for (const length of [5, 33]) {
      expect((await scenario.request("/api/auth/password", { currentPassword: fixturePassword, newPassword: "a".repeat(length) })).status).toBe(400);
    }
    expect((await scenario.request("/api/repositories", undefined, { cookie: otherSession.cookie })).status).toBe(200);
    expect((await scenario.request("/api/auth/login", login, { cookie: "" })).status).toBe(200);
    let currentPassword = fixturePassword;
    for (const length of [6, 32]) {
      const newPassword = "a".repeat(length);
      expect((await scenario.request("/api/auth/password", { currentPassword, newPassword })).status).toBe(200);
      expect((await scenario.request("/api/auth/login", { ...login, password: newPassword }, { cookie: "" })).status).toBe(200);
      currentPassword = newPassword;
    }
  });

  it("修改密码需要真实会话及同源请求", async () => {
    await scenario.setup();
    const input = { currentPassword: fixturePassword, newPassword: "next-password" };
    expect((await scenario.request("/api/auth/password", input, { cookie: "" })).status).toBe(401);
    expect((await scenario.request("/api/auth/password", input, { headers: { origin: "https://untrusted.example.test" } })).status).toBe(403);
    expect((await scenario.request("/api/auth/password", input, { headers: { "x-ureview-request": "" } })).status).toBe(403);
    expect((await scenario.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" })).status).toBe(200);
  });

  it("同一会话并发使用旧密码提交时只有一个修改成功", async () => {
    await scenario.setup();
    const passwords = ["next-password-one", "next-password-two"];
    const results = await Promise.all(passwords.map((newPassword) => scenario.request("/api/auth/password", { currentPassword: fixturePassword, newPassword })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    const accepted = passwords[results.findIndex((result) => result.status === 200)];
    expect((await scenario.request("/api/auth/login", { username: "zhang.wei", password: accepted }, { cookie: "" })).status).toBe(200);
    expect((await scenario.request("/api/repositories")).status).toBe(200);
  });

  it("并发的旧密码登录不能留下改密后的有效会话", async () => {
    await scenario.setup();
    const [changed, login] = await Promise.all([
      scenario.request("/api/auth/password", { currentPassword: fixturePassword, newPassword: "next-password" }),
      scenario.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" }),
    ]);
    expect(changed.status).toBe(200);
    expect([200, 401]).toContain(login.status);
    expect((await scenario.request("/api/repositories", undefined, { cookie: login.cookie })).status).toBe(401);
    expect((await scenario.request("/api/repositories")).status).toBe(200);
  });
});
