import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { IdentityScenario, fixtureRepository } from "../auth/test-support.js";
import { DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import { ReviewStore } from "../reviews/store.js";
import { migrate } from "../db/migrate.js";
import type { InstanceHealth, OnboardingChecklist } from "./types.js";

const environment = {
  UREVIEW_GENERATOR_VENDOR: "deepseek", UREVIEW_GENERATOR_PROVIDER: "generator", UREVIEW_GENERATOR_MODEL: "deepseek-flash",
  UREVIEW_GENERATOR_API: "openai-completions", UREVIEW_GENERATOR_BASE_URL: "https://models.example.test/v1", UREVIEW_GENERATOR_API_KEY: "sk-fixture-generator",
  UREVIEW_GRADER_VENDOR: "anthropic", UREVIEW_GRADER_PROVIDER: "grader", UREVIEW_GRADER_MODEL: "claude-sonnet",
  UREVIEW_GRADER_API: "anthropic-messages", UREVIEW_GRADER_BASE_URL: "https://grader.example.test/v1", UREVIEW_GRADER_API_KEY: "sk-fixture-grader",
};
let scenario: IdentityScenario | undefined;
afterEach(async () => { await scenario?.stop(); scenario = undefined; });

async function start(options: ConstructorParameters<typeof IdentityScenario>[0] = {}) {
  scenario = new IdentityScenario({ serviceEnvironment: environment, ...options });
  await scenario.start(); await scenario.setup();
  return scenario;
}

describe("引导与实例健康的数据边界", () => {
  it("启用规范步骤按 Git 规范的启用与自动匹配状态判定", async () => {
    const app = await start();
    const connected = await app.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    const repositoryId = connected.body.repository.id;
    const checklist = async () => {
      const response = await app.request<{ onboarding: OnboardingChecklist }>("/api/onboarding");
      expect(response.status).toBe(200);
      return response.body.onboarding.steps.find((step) => step.id === "rules")?.completed;
    };
    const saveRule = async (enabled: boolean, lazy: boolean) => withTeam(DEFAULT_TEAM_ID, () => app.pool.query(
      `INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,'repository:.agents/rules/inventory.md',$2)
       ON CONFLICT(team_id,repository_id,rule_id) DO UPDATE SET payload=excluded.payload`,
      [repositoryId, JSON.stringify({ id: "repository:.agents/rules/inventory.md", name: "库存更新保持原子性", body: "库存更新在同一事务中完成。",
        scope: "repository", layer: "team", languages: [], overrides: [], paths: lazy ? [] : ["src/**"], enabled, lazy,
        source: { kind: "manual" }, file: { kind: "repository", repositoryId, repositoryName: fixtureRepository.projectPath,
          path: ".agents/rules/inventory.md", commitSha: "fixture-head", url: `${fixtureRepository.instanceUrl}/${fixtureRepository.projectPath}/-/blob/fixture-head/.agents/rules/inventory.md` } })],
    ));
    await saveRule(false, false);
    expect(await checklist()).toBe(false);
    await saveRule(true, true);
    expect(await checklist()).toBe(false);
    await saveRule(true, false);
    expect(await checklist()).toBe(true);
    await saveRule(false, false);
    expect(await checklist()).toBe(false);
  });

  it("配置齐全才完成模型步骤，环境值与数据库值共同生效且输出不含连接密钥", async () => {
    const app = await start({ serviceEnvironment: { ...environment, UREVIEW_GRADER_API_KEY: "" } });
    const checklist = async () => (await app.request<{ onboarding: OnboardingChecklist }>("/api/onboarding")).body.onboarding;
    expect((await checklist()).steps.find((step) => step.id === "models")?.completed).toBe(false);
    await app.request("/api/service-settings", { version: 0, graderApiKey: "sk-fixture-database" }, { method: "PUT" });
    expect((await checklist()).steps.find((step) => step.id === "models")?.completed).toBe(true);
    const health = (await app.request<{ health: InstanceHealth }>("/api/instance-health")).body.health;
    expect(health.models).toMatchObject([{ phase: "generator", source: "environment", configured: true },
      { phase: "grader", source: "database", configured: true }]);
    expect(JSON.stringify(health)).not.toContain("sk-fixture");
    expect(health.versions).toEqual({ ureview: "0.0.0", dsh: "0.1.7-alpha.2", migration: "0036_enterprise_sso.sql" });
    await app.request("/api/service-settings", { version: 1, graderBaseURL: "https://changed.example.test/v1" }, { method: "PUT" });
    expect((await checklist()).steps.find((step) => step.id === "models")?.completed).toBe(true);
  });

  it("模型验证分别保留最近成功与失败，失败历史只接受安全分类", async () => {
    let success = true;
    const app = await start({ modelProbe: async () => success
      ? { ok: true, code: "verified", message: "验证通过", latencyMs: 1 }
      : { ok: false, code: "secret-provider-payload", message: "敏感上游正文", latencyMs: 1 } });
    const input = { version: 0, model: "candidate-model", baseURL: "https://candidate.example.test/v1" };
    expect((await app.request("/api/service-settings/generator/verify", input)).status).toBe(200);
    success = false;
    expect((await app.request("/api/service-settings/generator/verify", input)).status).toBe(200);
    const health = (await app.request<{ health: InstanceHealth }>("/api/instance-health")).body.health;
    expect(health.models[0]).toMatchObject({ model: "deepseek-flash", lastSuccessAt: expect.any(String),
      lastFailure: { at: expect.any(String), code: "protocol_error" } });
    expect(JSON.stringify(health)).not.toContain("secret-provider");
    expect(JSON.stringify(health)).not.toContain("敏感上游");
    expect((await app.pool.query("SELECT last_failure_code FROM service_model_health WHERE phase='generator'")).rows[0]).toEqual({ last_failure_code: "protocol_error" });
  });

  it("同阶段重复会话按轮次去重，拒绝次数按阶段统计并排除窗口外及未结束轮次", async () => {
    const app = await start();
    const connected = await app.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    const repositoryId = connected.body.repository.id;
    await withTeam(DEFAULT_TEAM_ID, async () => {
      for (const [index, status, age] of [[1, "completed", 1], [2, "failed", 2], [3, "failed", 9], [4, "queued", 1], [5, "completed", -1]] as const) {
        const id = randomUUID();
        await app.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,status,round,completed_at,report_submissions,failure_code)
          VALUES($1,$2,$3,$4,$3,'库存变更','张伟',$5,1,CASE WHEN $5='queued' THEN NULL ELSE now()-$6*interval '1 day' END,$7,$8)`,
        [id, repositoryId, `fixture-${index}`, index, status, age, JSON.stringify([
          { phase: "generator", tool: "report_finding", outcome: "rejected", code: "invalid_finding", reason: "位置无效" },
          { phase: "generator", tool: "finish_report", outcome: "rejected", code: "missing_overview", reason: "缺少综述" },
          { phase: "grader", tool: "grade_finding", outcome: "rejected", code: "invalid_score", reason: "分数无效" },
        ]), status === "failed" ? "model_unavailable" : null]);
        for (const kind of ["review_generator", "review_generator", "review_grader"] as const) {
          await app.pool.query(`INSERT INTO agent_sessions(id,dsh_session_id,review_id,kind,model,provider,status,completed_at)
            VALUES($1::uuid,$1::text,$2,$3,'fixture-model','fixture-provider','completed',now())`, [randomUUID(), id, kind]);
        }
      }
    });
    const response = await app.request<{ health: InstanceHealth }>("/api/instance-health");
    expect(response.status).toBe(200);
    expect(response.body.health.modelMetrics).toEqual([
      { phase: "generator", provider: "fixture-provider", model: "fixture-model", total: 2, completed: 1, failed: 1, completionRate: 0.5, averageRejectedSubmissions: 2 },
      { phase: "grader", provider: "fixture-provider", model: "fixture-model", total: 2, completed: 1, failed: 1, completionRate: 0.5, averageRejectedSubmissions: 1 },
    ]);
    expect(response.body.health.failures).toHaveLength(1);
    expect(response.body.health.failures[0]).toMatchObject({ code: "model_unavailable", count: 1 });
    expect(response.body.health.queue).toMatchObject({ queued: 1, running: 0, oldestWaitSeconds: expect.any(Number) });
    expect(response.body.health.models[0]?.lastSuccessAt).toEqual(expect.any(String));
  });

  it("评审失败持久化安全错误码，异常字符串归入通用失败", async () => {
    const app = await start();
    const connected = await app.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    await withTeam(DEFAULT_TEAM_ID, async () => {
      const id = randomUUID();
      await app.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round)
        VALUES($1,$2,'failed-review',41,'failure-head','库存变更','张伟',1)`, [id, connected.body.repository.id]);
      const store = new ReviewStore(app.pool);
      await store.fail(id, "评审未完成", "report_incomplete");
      expect((await app.pool.query("SELECT failure_code FROM reviews WHERE id=$1", [id])).rows[0]?.failure_code).toBe("report_incomplete");
      await store.fail(id, "评审未完成", "Authorization: secret");
      expect((await app.pool.query("SELECT failure_code FROM reviews WHERE id=$1", [id])).rows[0]?.failure_code).toBe("operation_failed");
    });
  });

  it("模型失败优先使用已脱敏事件的分类，保留会话业务错误码供评审诊断", async () => {
    const app = await start();
    const connected = await app.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    await withTeam(DEFAULT_TEAM_ID, async () => {
      const reviewId = randomUUID(), sessionId = randomUUID();
      await app.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,status,completed_at)
        VALUES($1,$2,'authentication-failed',42,'failure-head','库存变更','张伟',1,'failed',now())`, [reviewId, connected.body.repository.id]);
      await app.pool.query(`INSERT INTO agent_sessions(id,dsh_session_id,review_id,kind,model,provider,status,completed_at,error_code)
        VALUES($1::uuid,$1::text,$2,'review_generator','fixture-model','fixture-provider','failed',now(),'model_unavailable')`, [sessionId, reviewId]);
      await app.pool.query(`INSERT INTO agent_session_events(session_id,seq,event) VALUES($1,0,$2)`, [sessionId,
        JSON.stringify({ type: "turn/end", data: { reason: { kind: "error", error: { code: "authentication_failed", message: "模型服务认证失败。" } } } })]);
    });
    const response = await app.request<{ health: InstanceHealth }>("/api/instance-health");
    expect(response.status).toBe(200);
    expect(response.body.health.models[0]?.lastFailure).toEqual({ at: expect.any(String), code: "authentication_failed" });
  });

  it("无团队上下文的迁移为每个团队回填旧失败码并保持行隔离", async () => {
    const app = await start();
    const teamId = randomUUID();
    await app.pool.query("INSERT INTO teams(id,name) VALUES($1,'支付团队')", [teamId]);
    for (const tenant of [DEFAULT_TEAM_ID, teamId]) {
      await withTeam(tenant, async () => {
        const repositoryId = randomUUID();
        await app.pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
          VALUES($1,'https://gitlab.example.test',42,'inventory','commerce/inventory','https://gitlab.example.test/commerce/inventory',
          'https://gitlab.example.test/commerce/inventory.git',$2)`, [repositoryId, Buffer.from("fixture")]);
        await app.pool.query(`INSERT INTO reviews(id,repository_id,event_id,iid,head_sha,title,author,round,status,completed_at)
          VALUES($1,$2,'old-failed',41,'failure-head','历史评审','张伟',1,'failed',now())`, [randomUUID(), repositoryId]);
      });
    }
    await app.pool.query("ALTER TABLE reviews DROP COLUMN failure_code");
    await app.pool.query("DROP INDEX reviews_health_completed");
    await app.pool.query("DROP TABLE service_model_health");
    await app.pool.query("DELETE FROM schema_migrations WHERE filename='0030_instance_health.sql'");
    const directory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    expect(await migrate(app.pool, directory)).toEqual(["0030_instance_health.sql"]);
    for (const tenant of [DEFAULT_TEAM_ID, teamId]) {
      const codes = await withTeam(tenant, () => app.pool.query("SELECT failure_code FROM reviews"));
      expect(codes.rows).toEqual([{ failure_code: "operation_failed" }]);
    }
    expect((await app.pool.query("SELECT id FROM reviews")).rows).toEqual([]);
    expect(await migrate(app.pool, directory)).toEqual([]);
  });
});
