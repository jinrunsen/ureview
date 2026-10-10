import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { migrate } from "../db/migrate.js";
import { afterEach, describe, expect, it } from "vitest";
import { withTeam } from "../db/tenant.js";
import type { ManagedRule, RuleWaiver } from "./managed-types.js";
import type { RuleSession } from "./sessions-types.js";
import { ManagedRuleScenario, managedDraft, managedInput } from "./managed/test-support.js";

let fixture: ManagedRuleScenario | undefined;
afterEach(async () => { await fixture?.stop(); fixture = undefined; });
async function start(options: Parameters<ManagedRuleScenario["start"]>[0] = {}) {
  fixture = new ManagedRuleScenario();
  await fixture.start(options);
  return fixture;
}
type RuleResponse = { rule: ManagedRule };

describe("规范层级与适用语言", () => {
  it("保存四种层级和多语言，旧请求缺省团队层与全部语言，拒绝非法枚举", async () => {
    const app = await start();
    const metadata = await app.request<{ layers: string[]; languages: Array<{ id: string; label: string }> }>("/api/rule-metadata");
    expect(metadata.body.layers).toEqual(["principle", "general", "language", "team"]);
    expect(metadata.body.languages).toContainEqual({ id: "sql", label: "SQL" });
    for (const layer of metadata.body.layers) {
      const saved = await app.request<RuleResponse>("/api/managed-rules", { ...managedInput, layer, languages: ["sql", "c"] });
      expect(saved).toMatchObject({ status: 201, body: { rule: { layer, languages: ["sql", "c"], overrides: [], waivers: [] } } });
    }
    const { layer: _layer, languages: _languages, overrides: _overrides, ...legacy } = managedInput;
    expect(await app.request<RuleResponse>("/api/managed-rules", legacy)).toMatchObject({ status: 201, body: { rule: { layer: "team", languages: [], overrides: [] } } });
    for (const invalid of [{ layer: "constitution" }, { layer: null }, { languages: ["SQL"] }, { languages: null }, { languages: ["sql", "sql"] }, { overrides: ["missing-prefix"] }]) {
      expect((await app.request("/api/managed-rules", { ...managedInput, ...invalid })).status).toBe(400);
    }
  });

  it("生成建议保留层级语言，管理员手改后持久会话继续保存这些字段", async () => {
    const suggested = { ...managedDraft, layer: "language" as const, languages: ["sql"] };
    const app = await start({ generator: async () => suggested,
      conversationGenerator: { continue: async () => ({ draft: suggested, reply: "已补充参数化查询约束。", checkpoint: {} }) } });
    expect(await app.request("/api/managed-rules/generate", { intent: "SQL 使用参数化查询" })).toMatchObject({ status: 200, body: { draft: suggested } });
    const created = await app.request<{ session: RuleSession }>("/api/rule-sessions", {});
    const generated = await app.request<{ session: RuleSession }>(`/api/rule-sessions/${created.body.session.id}/turns`, { version: 1, message: "SQL 使用参数化查询" });
    expect(generated.body.session.workingCopy).toMatchObject({ layer: "language", languages: ["sql"], overrides: [] });
    const edited = { ...generated.body.session.workingCopy, layer: "team", languages: ["sql", "python"] };
    const saved = await app.request<RuleResponse>(`/api/rule-sessions/${created.body.session.id}/save-rule`, { version: generated.body.session.version, workingCopy: edited });
    expect(saved).toMatchObject({ status: 200, body: { rule: { layer: "team", languages: ["sql", "python"] } } });
    const reopened = await app.request<{ session: RuleSession }>("/api/rule-sessions", { ruleId: saved.body.rule.id });
    expect(reopened.body.session.workingCopy).toMatchObject({ layer: "team", languages: ["sql", "python"] });
  });
});

describe("规范覆盖关系", () => {
  it("允许向通用层和语言层覆盖，拒绝原则层、反向、自己、环和不存在的目标", async () => {
    const app = await start();
    const general = (await app.request<RuleResponse>("/api/managed-rules", { ...managedInput, layer: "general" })).body.rule;
    const language = (await app.request<RuleResponse>("/api/managed-rules", { ...managedInput, layer: "language", overrides: [`managed:${general.id}`] })).body.rule;
    const team = (await app.request<RuleResponse>("/api/managed-rules", { ...managedInput, overrides: [`managed:${language.id}`, `managed:${general.id}`] })).body.rule;
    expect(team.overrides).toEqual([`managed:${language.id}`, `managed:${general.id}`]);
    const principle = (await app.request<RuleResponse>("/api/managed-rules", { ...managedInput, layer: "principle" })).body.rule;
    for (const input of [
      { ...managedInput, overrides: [`managed:${principle.id}`] },
      { ...managedInput, layer: "principle", overrides: [`managed:${general.id}`] },
      { ...managedInput, layer: "general", overrides: [`managed:${language.id}`] },
      { ...managedInput, overrides: [`managed:${randomUUID()}`] },
      { ...managedInput, overrides: ["repository:.agents/rules/missing.md"] },
    ]) expect((await app.request("/api/managed-rules", input)).status).toBe(400);
    expect((await app.request(`/api/managed-rules/${team.id}`, { ...managedInput, version: 1, overrides: [`managed:${team.id}`] }, { method: "PUT" })).status).toBe(400);
    expect((await app.request(`/api/managed-rules/${general.id}`, { ...managedInput, version: 1, overrides: [`managed:${team.id}`] }, { method: "PUT" })).status).toBe(400);
    expect((await app.request(`/api/managed-rules/${general.id}`, { ...managedInput, layer: "principle", version: 1 }, { method: "PUT" })).status).toBe(400);
    const listed = await app.request<{ rules: ManagedRule[] }>("/api/managed-rules");
    expect(listed.body.rules.find((rule) => rule.id === general.id)).toMatchObject({ layer: "general", version: 1 });
  });

  it("Git 目标按仓库范围校验，跨团队规范不能用作覆盖目标", async () => {
    const app = await start();
    const gitId = "repository:.agents/rules/errors.md";
    await withTeam(app.teamId, () => app.pool.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,$2,$3)",
      [app.repositoryId, gitId, JSON.stringify({ id: gitId, layer: "general", overrides: [] })]));
    expect((await app.request("/api/managed-rules", { ...managedInput, overrides: [gitId] })).status).toBe(201);
    const local = (await app.request<RuleResponse>("/api/managed-rules", { ...managedInput, layer: "general" })).body.rule;
    const other = await app.otherTeam();
    expect((await app.request("/api/managed-rules", { ...managedInput, overrides: [`managed:${local.id}`] }, { cookie: other.cookie })).status).toBe(400);
    expect((await app.request("/api/managed-rules", { ...managedInput, overrides: [gitId] }, { cookie: other.cookie })).status).toBe(400);
  });

  it("覆盖方创建与目标层级变更并发时，只保留满足方向的关系", async () => {
    const app = await start();
    const general = (await app.request<RuleResponse>("/api/managed-rules", { ...managedInput, layer: "general" })).body.rule;
    const results = await Promise.all([
      app.request("/api/managed-rules", { ...managedInput, overrides: [`managed:${general.id}`] }),
      app.request(`/api/managed-rules/${general.id}`, { ...managedInput, layer: "principle", version: 1 }, { method: "PUT" }),
    ]);
    expect(results.filter((result) => result.status < 300)).toHaveLength(1);
    expect(results.filter((result) => result.status === 400)).toHaveLength(1);
  });
});

describe("仓库规范豁免", () => {
  it("理由必填，新增与撤销保留操作人和时间，成员只读，仓库范围规则不能豁免", async () => {
    const app = await start();
    const saved = (await app.request<RuleResponse>("/api/managed-rules", managedInput)).body.rule;
    const path = `/api/managed-rules/${saved.id}/waivers/${app.repositoryId}`;
    for (const invalid of [{ reason: " " }, { reason: "x".repeat(2001) }, { reason: "迁移中", createdBy: app.userId }]) {
      expect((await app.request(path, invalid, { method: "PUT" })).status).toBe(400);
    }
    expect((await app.request(path, { reason: "只读报表仓库" }, { method: "PUT", cookie: app.memberCookie })).status).toBe(403);
    const waived = await app.request<RuleResponse>(path, { reason: "  只读报表仓库  " }, { method: "PUT" });
    expect(waived.status).toBe(200);
    expect(waived.body.rule.waivers).toHaveLength(1);
    expect(waived.body.rule.waivers[0]).toMatchObject({ repositoryId: app.repositoryId, reason: "只读报表仓库", createdBy: app.userId, revokedBy: null, revokedAt: null });
    expect(Number.isFinite(Date.parse(waived.body.rule.waivers[0]!.createdAt))).toBe(true);
    expect((await app.request(path, undefined, { method: "DELETE", cookie: app.memberCookie })).status).toBe(403);
    expect(await app.request<RuleResponse>(path, undefined, { method: "DELETE" })).toMatchObject({ status: 200, body: { rule: { waivers: [] } } });
    const history = await app.request<{ waivers: RuleWaiver[] }>(`/api/managed-rules/${saved.id}/waivers`, undefined, { cookie: app.memberCookie });
    expect(history.body.waivers).toHaveLength(1);
    expect(history.body.waivers[0]).toMatchObject({ createdBy: app.userId, revokedBy: app.userId, reason: "只读报表仓库" });
    expect(Number.isFinite(Date.parse(history.body.waivers[0]!.revokedAt!))).toBe(true);
    await app.request(`/api/managed-rules/${saved.id}`, { ...managedInput, version: 1, scope: "repositories", repositories: [{ repositoryId: app.repositoryId, paths: [] }] }, { method: "PUT" });
    expect((await app.request(path, { reason: "仅此仓库" }, { method: "PUT" })).status).toBe(400);
  });

  it("更新理由与改为仓库范围保留历史，并发设置始终只有一个活动豁免", async () => {
    const app = await start();
    const saved = (await app.request<RuleResponse>("/api/managed-rules", managedInput)).body.rule;
    const path = `/api/managed-rules/${saved.id}/waivers/${app.repositoryId}`;
    const results = await Promise.all(["只读报表仓库", "历史格式兼容"].map((reason) => app.request(path, { reason }, { method: "PUT" })));
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    const before = await app.request<{ waivers: RuleWaiver[] }>(`/api/managed-rules/${saved.id}/waivers`);
    expect(before.body.waivers).toHaveLength(2);
    expect(before.body.waivers.filter((waiver) => !waiver.revokedAt)).toHaveLength(1);
    const updated = await app.request<RuleResponse>(`/api/managed-rules/${saved.id}`, { ...managedInput, version: 1, scope: "repositories", repositories: [{ repositoryId: app.repositoryId, paths: [] }] }, { method: "PUT" });
    expect(updated.body.rule.waivers).toEqual([]);
    const after = await app.request<{ waivers: RuleWaiver[] }>(`/api/managed-rules/${saved.id}/waivers`);
    expect(after.body.waivers.every((waiver) => waiver.revokedBy === app.userId && waiver.revokedAt)).toBe(true);
  });

  it("豁免 RLS 与复合外键隔离团队，越权读写均被拒绝", async () => {
    const app = await start();
    const saved = (await app.request<RuleResponse>("/api/managed-rules", managedInput)).body.rule;
    const path = `/api/managed-rules/${saved.id}/waivers/${app.repositoryId}`;
    await app.request(path, { reason: "只读仓库" }, { method: "PUT" });
    const other = await app.otherTeam();
    expect((await app.request(`/api/managed-rules/${saved.id}/waivers`, undefined, { cookie: other.cookie })).status).toBe(404);
    expect((await app.request(path, { reason: "越界修改" }, { method: "PUT", cookie: other.cookie })).status).toBe(404);
    expect((await app.request(path, undefined, { method: "DELETE", cookie: other.cookie })).status).toBe(404);
    expect((await app.request(`/api/managed-rules/${saved.id}/waivers/${other.repositoryId}`, { reason: "越界仓库" }, { method: "PUT" })).status).toBe(404);
    expect((await app.pool.query("SELECT id FROM managed_rule_waivers")).rowCount).toBe(0);
    await withTeam(other.teamId, async () => {
      expect((await app.pool.query("SELECT id FROM managed_rule_waivers")).rowCount).toBe(0);
      await expect(app.pool.query("INSERT INTO managed_rule_waivers(id,rule_id,repository_id,reason,created_by) VALUES($1,$2,$3,'越界', $4)",
        [randomUUID(), saved.id, other.repositoryId, app.userId])).rejects.toMatchObject({ code: "23503" });
    });
  });
});


describe("规范分层迁移", () => {
  it("非特权角色迁移已有团队规则与会话，保留正文审计且重复执行无变化", async () => {
    const app = await start({ conversationGenerator: { continue: async () => ({ draft: managedDraft, reply: "已整理金额约束。", checkpoint: {} }) } });
    const saved = (await app.request<RuleResponse>("/api/managed-rules", managedInput)).body.rule;
    const created = await app.request<{ session: RuleSession }>("/api/rule-sessions", { ruleId: saved.id });
    const generated = await app.request<{ session: RuleSession }>(`/api/rule-sessions/${created.body.session.id}/turns`, { version: 1, message: "补充示例" });
    await withTeam(app.teamId, () => app.pool.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,'repository:.agents/rules/legacy.md',$2)",
      [app.repositoryId, JSON.stringify({ id: "repository:.agents/rules/legacy.md", languages: [] })]));
    const other = await app.otherTeam();
    const otherRule = (await app.request<RuleResponse>("/api/managed-rules", managedInput, { cookie: other.cookie })).body.rule;
    const otherSession = await app.request<{ session: RuleSession }>("/api/rule-sessions", { ruleId: otherRule.id }, { cookie: other.cookie });
    for (const teamId of [app.teamId, other.teamId]) await withTeam(teamId, async () => {
      await app.pool.query("UPDATE managed_rule_sessions SET working_copy=working_copy-'layer'-'languages'-'overrides', turns=(SELECT coalesce(jsonb_agg(CASE WHEN turn ? 'draft' THEN jsonb_set(turn,'{draft}',(turn->'draft')-'layer'-'languages') ELSE turn END ORDER BY position),'[]'::jsonb) FROM jsonb_array_elements(turns) WITH ORDINALITY AS entries(turn,position))");
    });
    await app.pool.query("DROP TABLE managed_rule_waivers");
    await app.pool.query("ALTER TABLE managed_rules DROP COLUMN layer,DROP COLUMN languages,DROP COLUMN overrides");
    await app.pool.query("DELETE FROM schema_migrations WHERE filename IN ('0024_rule_layers_and_languages.sql','0025_rule_overrides_and_waivers.sql')");
    const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    expect(await migrate(app.pool, directory)).toEqual(["0024_rule_layers_and_languages.sql", "0025_rule_overrides_and_waivers.sql"]);
    for (const entry of [{ rule: saved, session: generated.body.session, cookie: app.cookie }, { rule: otherRule, session: otherSession.body.session, cookie: other.cookie }]) {
      const rules = await app.request<{ rules: ManagedRule[] }>("/api/managed-rules", undefined, { cookie: entry.cookie });
      expect(rules.body.rules).toEqual([entry.rule]);
      const session = await app.request<{ session: RuleSession }>(`/api/rule-sessions/${entry.session.id}`, undefined, { cookie: entry.cookie });
      expect(session.body.session).toEqual(entry.session);
    }
    await withTeam(app.teamId, async () => {
      expect((await app.pool.query("SELECT payload FROM rule_catalog")).rows).toEqual([
        { payload: { id: "repository:.agents/rules/legacy.md", layer: "team", languages: [], overrides: [] } },
      ]);
    });
    expect(await migrate(app.pool, directory)).toEqual([]);
  });
});
