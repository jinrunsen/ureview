import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityScenario, fixturePassword } from "../auth/test-support.js";
import type { SessionView } from "../auth/service.js";
import type { ModelConnectionInput } from "../runtime/model-probe.js";

let app: IdentityScenario;
let calls: ModelConnectionInput[];
const input = { version: 0, model: "deepseek-flash", baseURL: "https://models.example.test/v1" };
beforeEach(async () => {
  calls = [];
  app = new IdentityScenario({ serviceEnvironment: {
    UREVIEW_GENERATOR_API: "openai-completions", UREVIEW_GENERATOR_API_KEY: "sk-environment-generation", UREVIEW_GENERATOR_PROVIDER: "ureview-generator",
    UREVIEW_GRADER_API: "anthropic-messages",
  }, modelProbe: async (connection) => {
    calls.push(connection);
    return { ok: true, code: "available", message: "模型调用成功。", latencyMs: 5 };
  } });
  await app.start(); await app.setup();
});
afterEach(async () => { await app.stop(); });

describe("服务模型密钥显隐与调用验证", () => {
  it("按需读取当前阶段密钥，数据库值优先于环境变量，配置摘要仍不带密钥", async () => {
    const before = await app.request("/api/service-settings/generator/reveal-key", { version: 0 });
    expect(before.body).toEqual({ apiKey: "sk-environment-generation", version: 0 });
    expect((await app.request("/api/service-settings/grader/reveal-key", { version: 0 })).status).toBe(404);
    await app.request("/api/service-settings", { version: 0, generatorApiKey: "sk-database-generation", graderApiKey: "sk-database-grading" }, { method: "PUT" });
    const reveal = await fetch(`${app.baseUrl}/api/service-settings/generator/reveal-key`, {
      method: "POST", headers: { cookie: app.cookie, "x-ureview-request": "1", "content-type": "application/json" }, body: JSON.stringify({ version: 1 }),
    });
    expect(reveal.status).toBe(200);
    expect(reveal.headers.get("cache-control")).toBe("no-store");
    expect(await reveal.json()).toEqual({ apiKey: "sk-database-generation", version: 1 });
    expect((await app.request("/api/service-settings/grader/reveal-key", { version: 1 })).body).toEqual({ apiKey: "sk-database-grading", version: 1 });
    expect(JSON.stringify((await app.request("/api/service-settings")).body)).not.toContain("sk-");
  });

  it("验证当前填写的连接，不更改密钥或配置版本，未填新密钥时使用现有值", async () => {
    await app.request("/api/service-settings", { version: 0, generatorApiKey: "sk-saved-generation", graderApiKey: "sk-saved-grading" }, { method: "PUT" });
    const before = (await app.request("/api/service-settings")).body;
    const result = await app.request("/api/service-settings/generator/verify", { ...input, version: 1, apiKey: "sk-unsaved-generation", baseURL: "https://candidate.example.test/v1/" });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ verification: { ok: true, code: "available", message: "模型调用成功。", latencyMs: 5 } });
    expect(calls[0]).toEqual({ api: "openai-completions", provider: "ureview-generator-v1", model: input.model, baseURL: "https://candidate.example.test/v1", apiKey: "sk-unsaved-generation" });
    expect((await app.request("/api/service-settings/grader/verify", { ...input, version: 1, model: "deepseek-v4-pro", apiKey: "" })).status).toBe(200);
    expect(calls[1]).toMatchObject({ api: "anthropic-messages", model: "deepseek-v4-pro", apiKey: "sk-saved-grading" });
    expect((await app.request("/api/service-settings")).body).toEqual(before);
    expect(await app.serviceSettings.resolve("UREVIEW_GENERATOR_API_KEY")).toBe("sk-saved-generation");
    expect(await app.serviceSettings.resolve("UREVIEW_GRADER_API_KEY")).toBe("sk-saved-grading");
  });

  it("未填新密钥时可以验证环境配置，缺少密钥则不发起调用", async () => {
    expect((await app.request("/api/service-settings/generator/verify", input)).status).toBe(200);
    expect(calls[0]?.apiKey).toBe("sk-environment-generation");
    expect((await app.request("/api/service-settings/grader/verify", input)).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it("配置冲突、非法连接或阶段不能回显密钥或触发模型请求", async () => {
    await app.request("/api/service-settings", { version: 0, generatorApiKey: "sk-current-generation" }, { method: "PUT" });
    expect((await app.request("/api/service-settings/generator/reveal-key", { version: 0 })).status).toBe(409);
    expect((await app.request("/api/service-settings/generator/verify", input)).status).toBe(409);
    for (const patch of [{ baseURL: "file:///tmp/model" }, { baseURL: "https://user:secret@example.test" }, { baseURL: "https://example.test?key=secret" }, { model: " " }, { apiKey: "contains a space" }]) {
      expect((await app.request("/api/service-settings/generator/verify", { ...input, version: 1, ...patch })).status).toBe(400);
    }
    expect((await app.request("/api/service-settings/unknown/reveal-key", { version: 1 })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("未登录、无实例权限、失权与缺少同源请求标识时拒绝敏感操作", async () => {
    const ownerCookie = app.cookie;
    const owner = (await app.request<SessionView>("/api/auth/session")).body.user!;
    for (const operation of ["reveal-key", "verify"]) {
      const body = operation === "verify" ? input : { version: 0 };
      expect((await app.request(`/api/service-settings/generator/${operation}`, body, { cookie: "" })).status).toBe(401);
      const csrf = await fetch(`${app.baseUrl}/api/service-settings/generator/${operation}`, {
        method: "POST", headers: { cookie: app.cookie, "content-type": "application/json" }, body: JSON.stringify(body),
      });
      expect(csrf.status).toBe(403);
    }
    await app.request("/api/admin/members", { username: "li.na", email: "li.na@example.test", name: "李娜", password: fixturePassword, role: "admin" });
    const login = await app.request<SessionView>("/api/auth/login", { username: "li.na", password: fixturePassword }, { cookie: "" });
    app.cookie = login.cookie;
    expect((await app.request("/api/service-settings/generator/reveal-key", { version: 0 })).status).toBe(403);
    expect((await app.request("/api/service-settings/generator/verify", input)).status).toBe(403);
    app.cookie = ownerCookie;
    await app.request(`/api/service-users/${login.body.user!.userId}`, { role: "service_admin" }, { method: "PUT" });
    await app.request(`/api/service-users/${owner.userId}`, { role: "user" }, { method: "PUT" });
    expect((await app.request("/api/service-settings/generator/reveal-key", { version: 0 })).status).toBe(403);
    expect((await app.request("/api/service-settings/generator/verify", input)).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
