import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureRepository } from "../auth/test-support.js";
import { withTeam } from "../db/tenant.js";
import { ManagedRuleScenario } from "../rules/managed/test-support.js";
import { ReviewSettingsService, type ReviewSettings } from "./settings.js";

let scenario: ManagedRuleScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });
async function start() {
  scenario = new ManagedRuleScenario();
  await scenario.start();
  return scenario;
}
type SettingsResponse = { settings: ReviewSettings };
function settingsRoute(repositoryId: string): string { return `/api/repositories/${repositoryId}/review-settings`; }

describe("评审排除目录配置", () => {
  it("未配置时为空，保存规范化目录并递增版本，清空后允许重新评审目录", async () => {
    const fixture = await start();
    const route = settingsRoute(fixture.repositoryId);
    expect(await fixture.request(route)).toMatchObject({ status: 200, body: { settings: { excludedDirectories: [], version: 0 } } });
    const missing = await fixture.request(route, { excludedDirectories: ["features/steps"], version: 1 }, { method: "PUT" });
    expect(missing).toMatchObject({ status: 409, body: { error: { code: "review_settings_conflict" } } });
    const saved = await fixture.request<SettingsResponse>(route,
      { excludedDirectories: ["./features/steps/", "features/steps", "test/fixtures/"], version: 0 }, { method: "PUT" });
    expect(saved).toMatchObject({ status: 200, body: { settings: { excludedDirectories: ["features/steps", "test/fixtures"], version: 1 } } });
    expect((await fixture.request<SettingsResponse>(route)).body).toEqual(saved.body);
    expect(await withTeam(fixture.teamId, () => new ReviewSettingsService(fixture.pool).get(fixture.repositoryId))).toEqual(saved.body.settings);
    expect(await fixture.request(route, { excludedDirectories: [], version: 1 }, { method: "PUT" }))
      .toMatchObject({ status: 200, body: { settings: { excludedDirectories: [], version: 2 } } });
  });

  it("成员可读但不可改配置，未登录请求不能读写", async () => {
    const fixture = await start();
    const route = settingsRoute(fixture.repositoryId);
    const input = { excludedDirectories: ["features/steps"], version: 0 };
    expect((await fixture.request(route, input, { method: "PUT" })).status).toBe(200);
    expect(await fixture.request(route, undefined, { cookie: fixture.memberCookie }))
      .toMatchObject({ status: 200, body: { settings: { excludedDirectories: input.excludedDirectories, version: 1 } } });
    expect((await fixture.request(route, { excludedDirectories: [], version: 1 }, { method: "PUT", cookie: fixture.memberCookie })).status).toBe(403);
    expect((await fixture.request(route, undefined, { cookie: "" })).status).toBe(401);
    expect((await fixture.request(route, input, { method: "PUT", cookie: "" })).status).toBe(401);
    expect((await fixture.request<SettingsResponse>(route)).body.settings.excludedDirectories).toEqual(input.excludedDirectories);
  });

  it("同一团队按仓库分别保存配置，新接入的仓库默认空目录且各自校验版本", async () => {
    const fixture = await start();
    const route = settingsRoute(fixture.repositoryId);
    const original = await fixture.request<SettingsResponse>(route, { excludedDirectories: ["features/steps"], version: 0 }, { method: "PUT" });
    const connected = await fixture.request<{ repository: { id: string } }>("/api/repositories",
      { ...fixtureRepository, projectPath: "commerce/payment-service" });
    expect(connected.status).toBe(201);
    const otherRoute = settingsRoute(connected.body.repository.id);
    expect(await fixture.request(otherRoute)).toMatchObject({ status: 200, body: { settings: { excludedDirectories: [], version: 0 } } });
    expect(await fixture.request(otherRoute, { excludedDirectories: ["fixtures"], version: 0 }, { method: "PUT" }))
      .toMatchObject({ status: 200, body: { settings: { excludedDirectories: ["fixtures"], version: 1 } } });
    expect((await fixture.request<SettingsResponse>(route)).body).toEqual(original.body);
    expect((await fixture.request(otherRoute, { excludedDirectories: [], version: 1 }, { method: "PUT" })).status).toBe(200);
    expect((await fixture.request(route, { excludedDirectories: ["generated"], version: 1 }, { method: "PUT" })).status).toBe(200);
    expect((await fixture.request<SettingsResponse>(otherRoute)).body.settings).toEqual({ excludedDirectories: [], version: 2 });
  });

  it("配置按团队隔离，其他团队和不存在的仓库均不可读写，数据库阻止越界关联", async () => {
    const fixture = await start();
    const route = settingsRoute(fixture.repositoryId);
    const input = { excludedDirectories: ["features/steps"], version: 0 };
    await fixture.request(route, input, { method: "PUT" });
    const other = await fixture.otherTeam();
    for (const { repositoryId, cookie } of [
      { repositoryId: fixture.repositoryId, cookie: other.cookie },
      { repositoryId: other.repositoryId, cookie: fixture.cookie },
      { repositoryId: randomUUID(), cookie: fixture.cookie },
    ]) {
      const target = settingsRoute(repositoryId);
      expect(await fixture.request(target, undefined, { cookie }))
        .toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
      for (const version of [0, 1]) expect(await fixture.request(target, { ...input, version }, { method: "PUT", cookie }))
        .toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    }
    expect((await fixture.pool.query("SELECT team_id FROM repository_review_settings")).rowCount).toBe(0);
    await withTeam(fixture.teamId, async () => {
      expect((await fixture.pool.query("SELECT team_id FROM repository_review_settings")).rows).toEqual([{ team_id: fixture.teamId }]);
      await expect(fixture.pool.query("UPDATE repository_review_settings SET team_id=$1", [other.teamId])).rejects.toMatchObject({ code: "42501" });
      await expect(fixture.pool.query("INSERT INTO repository_review_settings(team_id,repository_id) VALUES($1,$2)", [other.teamId, other.repositoryId]))
        .rejects.toMatchObject({ code: "42501" });
      await expect(fixture.pool.query("INSERT INTO repository_review_settings(repository_id) VALUES($1)", [other.repositoryId]))
        .rejects.toMatchObject({ code: "23503" });
    });
    const otherRoute = settingsRoute(other.repositoryId);
    expect(await fixture.request(otherRoute, { excludedDirectories: ["test/fixtures"], version: 0 }, { method: "PUT", cookie: other.cookie }))
      .toMatchObject({ status: 200, body: { settings: { excludedDirectories: ["test/fixtures"], version: 1 } } });
    await withTeam(fixture.teamId, async () => {
      expect((await fixture.pool.query("UPDATE repository_review_settings SET excluded_directories='[]' WHERE repository_id=$1", [other.repositoryId])).rowCount).toBe(0);
    });
    expect((await fixture.request<SettingsResponse>(route)).body.settings.excludedDirectories).toEqual(["features/steps"]);
    expect((await fixture.request<SettingsResponse>(otherRoute, undefined, { cookie: other.cookie })).body.settings.excludedDirectories).toEqual(["test/fixtures"]);
  });

  it("团队级配置接口已移除，无效仓库标识返回参数错误", async () => {
    const fixture = await start();
    expect((await fixture.request("/api/review-settings")).status).toBe(404);
    expect((await fixture.request("/api/review-settings", { excludedDirectories: [], version: 0 }, { method: "PUT" })).status).toBe(404);
    const route = settingsRoute("not-a-repository");
    expect((await fixture.request(route)).status).toBe(400);
    expect((await fixture.request(route, { excludedDirectories: [], version: 0 }, { method: "PUT" })).status).toBe(400);
  });

  it("首次创建与已有版本的并发保存都只有一个成功，冲突保留胜出的配置", async () => {
    const fixture = await start();
    const route = settingsRoute(fixture.repositoryId);
    for (const version of [0, 1]) {
      const results = await Promise.all(["features/steps", "test/fixtures"].map((directory) => fixture.request<SettingsResponse>(route,
        { excludedDirectories: [directory], version }, { method: "PUT" })));
      expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
      const winner = results.find((result) => result.status === 200)!;
      expect(winner.body.settings.version).toBe(version + 1);
      expect(results.find((result) => result.status === 409)?.body).toMatchObject({ error: { code: "review_settings_conflict" } });
      expect((await fixture.request<SettingsResponse>(route)).body).toEqual(winner.body);
    }
  });

  it("拒绝危险路径、glob、超限数组与畸形版本，错误不反射输入且不覆盖已有配置", async () => {
    const fixture = await start();
    const route = settingsRoute(fixture.repositoryId);
    const saved = await fixture.request<SettingsResponse>(route, { excludedDirectories: ["features/steps"], version: 0 }, { method: "PUT" });
    const invalidDirectories: unknown[] = [null, "features/steps", [null], [""], ["."], ["./"], ["/features/steps"], ["../src"],
      ["features/../src"], ["features\\steps"], ["features\u0000steps"], ["features\nsteps"], ["features/*"], ["features/?"],
      ["features/[ab]"], ["features/{a,b}"], ["x".repeat(513)], Array.from({ length: 101 }, (_, index) => `tests/${index}`)];
    for (const excludedDirectories of invalidDirectories) {
      const response = await fixture.request(route, { excludedDirectories, version: 1 }, { method: "PUT" });
      expect(response).toMatchObject({ status: 400, body: { error: { code: "invalid_excluded_directories" } } });
      expect(JSON.stringify(response.body)).not.toMatch(/features|tests|\.\.\/src/);
    }
    const invalidInputs = [
      { excludedDirectories: [], version: -1 }, { excludedDirectories: [], version: 1.5 }, { excludedDirectories: [], version: "1" },
      { excludedDirectories: [], version: 2_147_483_647 }, { excludedDirectories: [] },
      { excludedDirectories: [], version: 1, teamId: randomUUID() },
    ];
    for (const input of invalidInputs) expect(await fixture.request(route, input, { method: "PUT" }))
      .toMatchObject({ status: 400, body: { error: { code: "invalid_review_settings" } } });
    expect((await fixture.request<SettingsResponse>(route)).body).toEqual(saved.body);
  });

  it("迁移为评审提供空排除快照，数据库拒绝负数的排除计数", async () => {
    const fixture = await start();
    await withTeam(fixture.teamId, async () => {
      const id = randomUUID();
      const result = await fixture.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round)
        VALUES($1,$2,'directory-settings-fixture',1,'fixture-head','测试目录排除','张伟',1)
        RETURNING excluded_directories,excluded_file_count`, [id, fixture.repositoryId]);
      expect(result.rows).toEqual([{ excluded_directories: [], excluded_file_count: 0 }]);
      await expect(fixture.pool.query("UPDATE reviews SET excluded_file_count=-1 WHERE id=$1", [id])).rejects.toMatchObject({ code: "23514" });
    });
  });
});
