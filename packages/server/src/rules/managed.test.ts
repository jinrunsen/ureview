import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTeam } from "../db/tenant.js";
import { ReviewError } from "../reviews/types.js";
import { RuleCatalogService } from "./catalog.js";
import type { ManagedRule } from "./managed-types.js";
import { ManagedRuleScenario, managedDraft, managedInput } from "./managed/test-support.js";

let scenario: ManagedRuleScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });
async function start(options: Parameters<ManagedRuleScenario["start"]>[0] = {}) {
  scenario = new ManagedRuleScenario();
  await scenario.start(options);
  return scenario;
}
type RuleResponse = { rule: ManagedRule };
type RulesResponse = { rules: ManagedRule[] };

describe("数据库规范", () => {
  it("判断题属性默认关闭，管理员可保存、修改，非法属性被拒绝", async () => {
    const fixture = await start();
    const { judgement: _judgement, ...legacy } = managedInput;
    const saved = await fixture.request<RuleResponse>("/api/managed-rules", legacy);
    expect(saved.status).toBe(201);
    expect(saved.body.rule.judgement).toBe(false);
    const updated = await fixture.request<RuleResponse>(`/api/managed-rules/${saved.body.rule.id}`,
      { ...managedInput, judgement: true, version: 1 }, { method: "PUT" });
    expect(updated.status).toBe(200);
    expect(updated.body.rule.judgement).toBe(true);
    expect((await fixture.request<RulesResponse>("/api/managed-rules")).body.rules[0]?.judgement).toBe(true);
    for (const judgement of ["true", 1, null]) {
      expect((await fixture.request("/api/managed-rules", { ...managedInput, judgement })).status).toBe(400);
    }
  });

  it("生成只返回草稿；保存、激活及再次编辑持久化正文、示例、范围与审计版本", async () => {
    let received = "";
    const fixture = await start({ generator: async (intent) => { received = intent; return managedDraft; } });
    const generated = await fixture.request("/api/managed-rules/generate", { intent: "  金额使用整数分  " });
    expect(generated).toMatchObject({ status: 200, body: { draft: managedDraft } });
    expect(received).toBe("金额使用整数分");
    expect((await fixture.request<RulesResponse>("/api/managed-rules")).body.rules).toEqual([]);
    const saved = await fixture.request<RuleResponse>("/api/managed-rules", managedInput);
    expect(saved.status).toBe(201);
    expect(saved.body.rule).toMatchObject({ ...managedInput, version: 1, createdBy: fixture.userId, updatedBy: fixture.userId });
    expect(Number.isFinite(Date.parse(saved.body.rule.createdAt))).toBe(true);
    const active = { ...managedInput, scope: "repositories", repositories: [{ repositoryId: fixture.repositoryId, paths: ["src/**"] }],
      category: "reliability", severity: "warning", status: "active", version: 1 };
    const updated = await fixture.request<RuleResponse>(`/api/managed-rules/${saved.body.rule.id}`, active, { method: "PUT" });
    expect(updated.status).toBe(200);
    expect(updated.body.rule).toMatchObject({ category: "reliability", severity: "warning", scope: "repositories", status: "active", version: 2,
      repositories: active.repositories, createdAt: saved.body.rule.createdAt, createdBy: fixture.userId, updatedBy: fixture.userId });
    expect((await fixture.request<RulesResponse>(`/api/managed-rules?repositoryId=${fixture.repositoryId}`)).body.rules).toEqual([updated.body.rule]);
    const catalog = await withTeam(fixture.teamId, () => new RuleCatalogService(fixture.pool, fixture.repositories).list());
    expect(catalog.managedRules).toEqual([{ ...updated.body.rule, counts: { hits: 0, adopted: 0, dismissed: 0, ignored: 0 } }]);
    expect(catalog.rules).toEqual([]);
  });

  it("没有配置生成模型返回503，仍可手动保存草稿", async () => {
    const fixture = await start();
    expect(await fixture.request("/api/managed-rules/generate", { intent: "所有重试必须有上限" }))
      .toMatchObject({ status: 503, body: { error: { code: "model_not_configured" } } });
    expect((await fixture.request<RulesResponse>("/api/managed-rules")).body.rules).toEqual([]);
    expect((await fixture.request("/api/managed-rules", managedInput)).status).toBe(201);
  });

  it("运行时未配置与模型失败、畸形响应分别返回安全错误，已有规范保持不变", async () => {
    let outcome: "unconfigured" | "error" | "malformed" = "unconfigured";
    const fixture = await start({ generator: async () => {
      if (outcome === "unconfigured") throw new ReviewError("models_not_configured", "PRIVATE MODEL SETTINGS");
      if (outcome === "error") throw new Error("SECRET PROVIDER RESPONSE");
      return JSON.parse(JSON.stringify({ ...managedDraft, severity: "critical" }));
    } });
    const saved = await fixture.request<RuleResponse>("/api/managed-rules", managedInput);
    for (const mode of ["unconfigured", "error", "malformed"] as const) {
      outcome = mode;
      const result = await fixture.request("/api/managed-rules/generate", { intent: "支付调用必须带超时" });
      expect(result.status).toBe(mode === "unconfigured" ? 503 : 502);
      expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE|SECRET|critical/);
      expect((await fixture.request<RulesResponse>("/api/managed-rules")).body.rules).toEqual([saved.body.rule]);
    }
  });

  it("成员可读，生成与保存仅管理员可用，未登录请求被拒绝", async () => {
    let generated = 0;
    const fixture = await start({ generator: async () => { generated++; return managedDraft; } });
    const saved = await fixture.request<RuleResponse>("/api/managed-rules", managedInput);
    expect((await fixture.request<RulesResponse>("/api/managed-rules", undefined, { cookie: fixture.memberCookie })).body.rules).toEqual([saved.body.rule]);
    expect((await fixture.request("/api/managed-rules/generate", { intent: "重试有界" }, { cookie: fixture.memberCookie })).status).toBe(403);
    expect((await fixture.request("/api/managed-rules", managedInput, { cookie: fixture.memberCookie })).status).toBe(403);
    expect((await fixture.request(`/api/managed-rules/${saved.body.rule.id}`, { ...managedInput, version: 1 }, { method: "PUT", cookie: fixture.memberCookie })).status).toBe(403);
    expect((await fixture.request("/api/managed-rules", undefined, { cookie: "" })).status).toBe(401);
    expect(generated).toBe(0);
  });

  it("跨团队规则和仓库无法访问，数据库RLS与复合外键阻止越界关联", async () => {
    const fixture = await start();
    const saved = await fixture.request<RuleResponse>("/api/managed-rules", managedInput);
    const other = await fixture.otherTeam();
    expect((await fixture.request<RulesResponse>("/api/managed-rules", undefined, { cookie: other.cookie })).body.rules).toEqual([]);
    expect((await fixture.request(`/api/managed-rules/${saved.body.rule.id}`, { ...managedInput, version: 1 }, { method: "PUT", cookie: other.cookie })).status).toBe(404);
    expect((await fixture.request(`/api/managed-rules?repositoryId=${fixture.repositoryId}`, undefined, { cookie: other.cookie })).status).toBe(404);
    expect((await fixture.request("/api/managed-rules", { ...managedInput, scope: "repositories", repositories: [{ repositoryId: other.repositoryId, paths: [] }] })).status).toBe(404);
    expect((await fixture.pool.query("SELECT id FROM managed_rules")).rowCount).toBe(0);
    await withTeam(other.teamId, async () => {
      expect((await fixture.pool.query("SELECT id FROM managed_rules WHERE id=$1", [saved.body.rule.id])).rowCount).toBe(0);
      await expect(fixture.pool.query("INSERT INTO managed_rule_repositories(rule_id,repository_id,paths) VALUES($1,$2,'[]')", [saved.body.rule.id, other.repositoryId])).rejects.toMatchObject({ code: "23503" });
    });
    await withTeam(fixture.teamId, async () => {
      await expect(fixture.pool.query("INSERT INTO managed_rule_repositories(rule_id,repository_id,paths) VALUES($1,$2,'[]')", [saved.body.rule.id, other.repositoryId])).rejects.toMatchObject({ code: "23503" });
      await expect(fixture.pool.query("UPDATE managed_rules SET team_id=$1 WHERE id=$2", [other.teamId, saved.body.rule.id])).rejects.toMatchObject({ code: "42501" });
    });
    expect((await fixture.request<RulesResponse>("/api/managed-rules")).body.rules).toEqual([saved.body.rule]);
  });

  it("作用域、路径、枚举与审计字段校验失败不产生记录", async () => {
    const fixture = await start();
    const selected = [{ repositoryId: fixture.repositoryId, paths: ["src/**"] }];
    const invalid = [
      { ...managedInput, name: "  " }, { ...managedInput, body: "x".repeat(12001) }, { ...managedInput, category: "money" },
      { ...managedInput, severity: "high" }, { ...managedInput, repositories: selected },
      { ...managedInput, scope: "repositories", repositories: [] }, { ...managedInput, scope: "repositories", repositories: [...selected, ...selected] },
      { ...managedInput, scope: "repositories", repositories: [{ repositoryId: fixture.repositoryId, paths: ["../secrets"] }] },
      { ...managedInput, scope: "repositories", repositories: [{ repositoryId: fixture.repositoryId, paths: ["/etc/passwd"] }] },
      { ...managedInput, scope: "repositories", repositories: [{ repositoryId: fixture.repositoryId, paths: ["src/**", "src/**"] }] },
      { ...managedInput, createdBy: randomUUID() }, { ...managedInput, teamId: randomUUID() },
    ];
    for (const value of invalid) expect((await fixture.request("/api/managed-rules", value)).status).toBe(400);
    expect((await fixture.request("/api/managed-rules/generate", { intent: "  " })).status).toBe(400);
    expect((await fixture.request<RulesResponse>("/api/managed-rules")).body.rules).toEqual([]);
  });

  it("同一版本并发更新仅一个成功，冲突不会覆盖胜出的内容与范围", async () => {
    const fixture = await start();
    const saved = await fixture.request<RuleResponse>("/api/managed-rules", managedInput);
    const results = await Promise.all(["校验结算金额", "校验退款金额"].map((name) => fixture.request<RuleResponse>(`/api/managed-rules/${saved.body.rule.id}`,
      { ...managedInput, name, status: "active", version: 1 }, { method: "PUT" })));
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const winner = results.find((result) => result.status === 200)!.body.rule;
    expect(winner.version).toBe(2);
    expect((await fixture.request<RulesResponse>("/api/managed-rules")).body.rules).toEqual([winner]);
    expect((await fixture.request(`/api/managed-rules/${randomUUID()}`, { ...managedInput, version: 1 }, { method: "PUT" })).status).toBe(404);
  });

  it("多仓库规则按选择范围显示，切换团队全局时清除旧路径关联", async () => {
    const fixture = await start();
    const second = await fixture.request<{ repository: { id: string } }>("/api/repositories", {
      instanceUrl: "https://gitlab.example.test", projectPath: "commerce/order-service", token: "fixture-readonly",
    });
    const third = await fixture.request<{ repository: { id: string } }>("/api/repositories", {
      instanceUrl: "https://gitlab.example.test", projectPath: "commerce/product-service", token: "fixture-readonly",
    });
    const global = await fixture.request<RuleResponse>("/api/managed-rules", managedInput);
    const scopedInput = { ...managedInput, scope: "repositories", repositories: [
      { repositoryId: fixture.repositoryId, paths: ["src/**", "lib/*.ts"] }, { repositoryId: second.body.repository.id, paths: [] },
    ] };
    const scoped = await fixture.request<RuleResponse>("/api/managed-rules", scopedInput);
    expect(scoped.status).toBe(201);
    for (const repositoryId of [fixture.repositoryId, second.body.repository.id]) {
      const rules = (await fixture.request<RulesResponse>(`/api/managed-rules?repositoryId=${repositoryId}`)).body.rules;
      expect(rules.map((rule) => rule.id).sort()).toEqual([global.body.rule.id, scoped.body.rule.id].sort());
      expect(rules.find((rule) => rule.id === scoped.body.rule.id)?.repositories).toEqual(expect.arrayContaining(scopedInput.repositories));
    }
    expect((await fixture.request<RulesResponse>(`/api/managed-rules?repositoryId=${third.body.repository.id}`)).body.rules).toEqual([global.body.rule]);
    const update = await fixture.request<RuleResponse>(`/api/managed-rules/${scoped.body.rule.id}`, { ...managedInput, version: 1 }, { method: "PUT" });
    expect(update.status).toBe(200);
    expect(update.body.rule.repositories).toEqual([]);
    expect((await fixture.request<RulesResponse>(`/api/managed-rules?repositoryId=${third.body.repository.id}`)).body.rules.map((rule) => rule.id).sort())
      .toEqual([global.body.rule.id, scoped.body.rule.id].sort());
    expect(await withTeam(fixture.teamId, async () => (await fixture.pool.query("SELECT rule_id FROM managed_rule_repositories WHERE rule_id=$1", [scoped.body.rule.id])).rowCount)).toBe(0);
  });
});
