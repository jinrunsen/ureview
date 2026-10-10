import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { IdentityScenario, fixturePassword, fixtureRepository } from "./test-support.js";
import type { IdentitySettings, LinkedIdentities } from "./identities.js";
import type { SessionView } from "./service.js";

let app: IdentityScenario;
const input: LinkedIdentities = { gitlab: [{ instanceUrl: fixtureRepository.instanceUrl, username: "zhangwei" }], mobile: "13800138000", feishuOpenId: "ou_zhangwei", feishuUserId: null };
beforeEach(async () => { app = new IdentityScenario(); await app.start(); await app.setup(); await app.request("/api/repositories", fixtureRepository); });
afterEach(async () => { await app.stop(); });
async function member() {
  expect((await app.request("/api/admin/members", { name: "李娜", username: "lina", email: "lina@example.test", password: fixturePassword, role: "member" })).status).toBe(201);
  return (await app.request<{ members: Array<{ id: string; username: string }> }>("/api/team/members")).body.members.find((item) => item.username === "lina")!.id;
}

describe("账号的 GitLab 与即时通讯身份", () => {
  it("本人和管理员均可保存身份，同实例用户名忽略大小写唯一，冲突回滚全部修改", async () => {
    const memberId = await member();
    const saved = await app.request<IdentitySettings>("/api/account/identities", input, { method: "PUT" });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ ...input, instances: [fixtureRepository.instanceUrl] });
    const path = `/api/admin/members/${memberId}/identities`;
    expect((await app.request(path, { ...input, gitlab: [{ ...input.gitlab[0], username: "ZHANGWEI" }] }, { method: "PUT" })).status).toBe(409);
    expect((await app.request<IdentitySettings>(path)).body).toMatchObject({ gitlab: [], mobile: null });
    expect((await app.request(path, { ...input, gitlab: [{ ...input.gitlab[0], username: "lina" }] }, { method: "PUT" })).status).toBe(200);
    const login = await app.request<SessionView>("/api/auth/login", { username: "lina", password: fixturePassword });
    app.cookie = login.cookie;
    expect((await app.request<IdentitySettings>("/api/account/identities")).body.gitlab[0]?.username).toBe("lina");
    expect((await app.request(path, input, { method: "PUT" })).status).toBe(403);
    expect((await app.request(`/api/admin/members/${randomUUID()}/identities`)).status).toBe(403);
  });

  it("用户名仅能关联当前团队已接入的实例，飞书身份互斥，手机号格式受校验", async () => {
    for (const invalid of [
      { ...input, gitlab: [{ instanceUrl: "https://unconnected.example.test", username: "zhangwei" }] },
      { ...input, gitlab: [input.gitlab[0], input.gitlab[0]] },
      { ...input, feishuUserId: "zhangwei" }, { ...input, mobile: "张伟" },
      { ...input, feishuOpenId: "all" }, { ...input, feishuOpenId: null, feishuUserId: "ALL" },
    ]) expect((await app.request("/api/account/identities", invalid, { method: "PUT" })).status).toBe(400);
    expect((await app.request(`/api/admin/members/${randomUUID()}/identities`)).status).toBe(404);
  });

  it("切换团队编辑身份保留其他实例关联，相同用户名可在不同实例使用", async () => {
    const memberId = await member();
    expect((await app.request("/api/account/identities", input, { method: "PUT" })).status).toBe(200);
    const team = (await app.request<{ id: string }>("/api/admin/teams", { name: "支付研发" })).body;
    await app.request("/api/auth/team", { teamId: team.id });
    const second = "https://gitlab.payments.example.test";
    await app.request("/api/repositories", { ...fixtureRepository, instanceUrl: second });
    expect((await app.request<IdentitySettings>("/api/account/identities")).body.gitlab).toEqual([]);
    expect((await app.request("/api/account/identities", { ...input, gitlab: [{ instanceUrl: second, username: "zhangwei" }] }, { method: "PUT" })).status).toBe(200);
    expect((await app.request(`/api/admin/members/${memberId}/identities`, input, { method: "PUT" })).status).toBe(404);
    expect((await app.pool.query("SELECT 1 FROM auth_gitlab_identities")).rowCount).toBe(2);
  });
});
