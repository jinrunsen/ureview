import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { IdentityScenario, fixturePassword } from "../auth/test-support.js";
import type { SessionView } from "../auth/service.js";
let app: IdentityScenario;
beforeEach(async () => { app = new IdentityScenario(); await app.start(); });
afterEach(async () => { await app.stop(); });

describe("服务配置与实例权限", () => {
  it("首次管理员获得服务权限，密钥加密保存、读取不回显、更新即时被解析，旧版本不能覆盖", async () => {
    expect((await app.setup()).user?.serviceRole).toBe("service_admin");
    const update = { version: 0, generatorApiKey: "fixture-generator-key", graderApiKey: "fixture-grader-key" };
    const saved = await app.request("/api/service-settings", update, { method: "PUT" });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("fixture-");
    expect(await app.serviceSettings.resolve("UREVIEW_GENERATOR_API_KEY")).toBe(update.generatorApiKey);
    const row = (await app.pool.query<{ generator: Buffer; grader: Buffer }>("SELECT generator,grader FROM service_model_keys")).rows[0]!;
    expect(row.generator.toString()).not.toContain(update.generatorApiKey);
    expect(row.grader.toString()).not.toContain(update.graderApiKey);
    expect((await app.request("/api/service-settings", update, { method: "PUT" })).status).toBe(409);
    expect((await app.request("/api/service-settings", { version: 1, generatorApiKey: "replacement-key" }, { method: "PUT" })).status).toBe(200);
    expect(await app.serviceSettings.resolve("UREVIEW_GENERATOR_API_KEY")).toBe("replacement-key");
    expect(await app.serviceSettings.resolve("UREVIEW_GRADER_API_KEY")).toBe(update.graderApiKey);
    expect((await app.request("/api/service-settings", { version: 2, generatorApiKey: "" }, { method: "PUT" })).status).toBe(400);
  });
  it("只更新模型连接时保留密钥，非法地址不能落库", async () => {
    await app.setup();
    await app.request("/api/service-settings", { version: 0, generatorApiKey: "preserved-key" }, { method: "PUT" });
    const config = { version: 1, generatorModel: "deepseek-flash", generatorBaseURL: "https://models.example.test/v1", graderModel: "deepseek-v4-pro", graderBaseURL: "https://models.example.test/v1" };
    const result = await app.request<{ settings: { generator: { model: string; baseURL: string } } }>("/api/service-settings", config, { method: "PUT" });
    expect(result.status).toBe(200);
    expect(result.body.settings.generator).toMatchObject({ model: config.generatorModel, baseURL: config.generatorBaseURL });
    expect(await app.serviceSettings.resolve("UREVIEW_GENERATOR_API_KEY")).toBe("preserved-key");
    for (const generatorBaseURL of ["file:///tmp/models", "https://user:password@models.example.test", "https://models.example.test?key=secret", "https://models.example.test#key", "invalid"]) {
      expect((await app.request("/api/service-settings", { version: 2, generatorBaseURL }, { method: "PUT" })).status).toBe(400);
    }
    expect((await app.request("/api/service-settings", { version: 2, generatorModel: "" }, { method: "PUT" })).status).toBe(400);
  });

  it("团队管理员无服务权限，服务管理员可以授权已有用户并保留至少一人", async () => {
    const initial = await app.setup();
    const ownerCookie = app.cookie;
    await app.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "admin" });
    const login = await app.request<SessionView>("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
    app.cookie = login.cookie;
    expect(login.body.user?.serviceRole).toBe("user");
    expect((await app.request("/api/service-settings")).status).toBe(403);
    expect((await app.request("/api/service-users")).status).toBe(403);
    expect((await app.request("/api/service-settings", { version: 0, generatorApiKey: "denied-key" }, { method: "PUT" })).status).toBe(403);
    const target = login.body.user!.userId;
    expect((await app.request(`/api/service-users/${target}`, { role: "service_admin" }, { method: "PUT" })).status).toBe(403);
    app.cookie = ownerCookie;
    expect((await app.request(`/api/service-users/${initial.user!.userId}`, { role: "user" }, { method: "PUT" })).status).toBe(409);
    expect((await app.request(`/api/service-users/${target}`, { role: "service_admin" }, { method: "PUT" })).status).toBe(200);
    app.cookie = login.cookie;
    expect((await app.request("/api/service-settings")).status).toBe(200);
    expect((await app.request(`/api/service-users/${initial.user!.userId}`, { role: "user" }, { method: "PUT" })).status).toBe(200);
    expect((await app.request("/api/service-settings", undefined, { cookie: ownerCookie })).status).toBe(403);
  });
});
