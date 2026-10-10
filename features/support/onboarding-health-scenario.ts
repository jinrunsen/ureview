import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SessionView, TeamSummary } from "../../packages/server/src/auth/service.js";
import { withTeam } from "../../packages/server/src/db/tenant.js";
import type { ReportSubmission } from "../../packages/server/src/reviews/types.js";
import { IdentityScenario, fixturePassword, fixtureRepository } from "./identity-scenario.js";

export class OnboardingHealthScenario {
  readonly environment: NodeJS.ProcessEnv = {
    UREVIEW_GENERATOR_VENDOR: "deepseek", UREVIEW_GENERATOR_PROVIDER: "ureview-generator",
    UREVIEW_GENERATOR_API: "openai-completions",
    UREVIEW_GRADER_VENDOR: "anthropic", UREVIEW_GRADER_PROVIDER: "ureview-grader",
    UREVIEW_GRADER_API: "anthropic-messages",
  };
  readonly identity = new IdentityScenario({ serviceEnvironment: this.environment });
  ownerCookie = "";
  ownerId = "";
  teamId = "";
  repositoryId = "";
  ruleId = "";
  modelVersion = 0;
  private nextIid = 1;
  readonly expectedFailures = new Map<string, { code: string; teamId: string; title: string; iid: number }>();

  async start(): Promise<void> {
    await this.identity.start();
    const session = await this.identity.setup();
    this.ownerCookie = this.identity.cookie;
    this.ownerId = session.user!.userId;
    this.teamId = session.user!.teamId;
  }

  stop() { return this.identity.stop(); }

  configureEnvironment(): void {
    Object.assign(this.environment, {
      UREVIEW_GENERATOR_MODEL: "deepseek-chat", UREVIEW_GENERATOR_BASE_URL: "https://models.example.test/v1",
      UREVIEW_GENERATOR_API_KEY: "sk-fixture-generator-environment",
      UREVIEW_GRADER_MODEL: "claude-sonnet", UREVIEW_GRADER_BASE_URL: "https://grader.example.test",
      UREVIEW_GRADER_API_KEY: "sk-fixture-grader-environment",
    });
  }

  async saveModel(phase: "generator" | "grader"): Promise<void> {
    const response = await this.identity.request("/api/service-settings", {
      version: this.modelVersion,
      [`${phase}Model`]: phase === "generator" ? "deepseek-chat" : "claude-sonnet",
      [`${phase}BaseURL`]: `https://${phase}.example.test/v1`,
      [`${phase}ApiKey`]: `sk-fixture-${phase}-database`,
    }, { method: "PUT" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    this.modelVersion += 1;
  }

  async connectRepository(): Promise<void> {
    const response = await this.identity.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    this.repositoryId = response.body.repository.id;
  }

  async event(authenticated: boolean): Promise<void> {
    const response = await this.identity.request(`/api/repositories/${this.repositoryId}/events/gitlab`, { object_kind: "push" }, {
      cookie: "", headers: { "x-gitlab-token": authenticated ? "fixture-webhook" : "untrusted-webhook",
        "x-gitlab-event": "Push Hook", "webhook-id": randomUUID() },
    });
    assert.equal(response.status, authenticated ? 202 : 401, JSON.stringify(response.body));
  }

  async addMember(name: string, username: string, role: "admin" | "member"): Promise<string> {
    const response = await this.identity.request("/api/admin/members", { name, username, role, password: fixturePassword });
    assert.equal(response.status, 201);
    const login = await this.identity.request<SessionView>("/api/auth/login", { username, password: fixturePassword }, { cookie: "" });
    assert.equal(login.status, 200);
    assert.equal(login.body.user?.role, role);
    assert.equal(login.body.user?.serviceRole, "user");
    return login.cookie;
  }

  async switchToNewTeam(): Promise<void> {
    const response = await this.identity.request<TeamSummary>("/api/admin/teams", { name: "支付研发" });
    assert.equal(response.status, 201);
    this.teamId = response.body.id;
    assert.equal((await this.identity.request("/api/auth/team", { teamId: this.teamId })).status, 200);
    this.repositoryId = "";
  }

  async seedRule(status: "draft" | "active"): Promise<void> {
    this.ruleId = randomUUID();
    await withTeam(this.teamId, () => this.identity.pool.query(`INSERT INTO managed_rules
      (id,name,body,good_example,bad_example,category,severity,scope,status,created_by,updated_by)
      VALUES ($1,'库存恢复幂等','恢复库存前检查订单处理记录。','','','correctness','error','global',$2,$3,$3)`,
    [this.ruleId, status, this.ownerId]));
  }

  async seedLint(): Promise<void> {
    await withTeam(this.teamId, () => this.identity.pool.query(`INSERT INTO rule_catalog(repository_id,rule_id,payload)
      VALUES ($1,'inventory-lint',$2::jsonb)`, [this.repositoryId, JSON.stringify({ kind: "lint", name: "库存 TypeScript 检查" })]));
  }

  async activateRule(): Promise<void> {
    await withTeam(this.teamId, () => this.identity.pool.query("UPDATE managed_rules SET status='active' WHERE id=$1", [this.ruleId]));
  }

  /** 统计场景预置历史记录；其输出始终通过正式 HTTP 接口读取。 */
  async seedReview(options: {
    status: "queued" | "running" | "completed" | "failed";
    ageMinutes?: number;
    failureCode?: string;
    generatorModel?: string;
    generatorRejected?: number;
    graderRejected?: number;
    duplicateGeneratorSession?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const iid = this.nextIid++;
    const title = `库存恢复评审 ${iid}`;
    const terminal = options.status === "completed" || options.status === "failed";
    const submissions: ReportSubmission[] = [{ phase: "generator", tool: "report_file_groups", outcome: "accepted", code: null, reason: null }];
    for (const [phase, count] of [["generator", options.generatorRejected ?? 0], ["grader", options.graderRejected ?? 0]] as const) {
      for (let index = 0; index < count; index += 1) submissions.push({ phase,
        tool: phase === "generator" ? "report_finding" : "grade_finding", outcome: "rejected", code: "unread_evidence", reason: "引用的证据尚未读取" });
    }
    await withTeam(this.teamId, async () => {
      await this.identity.pool.query(`INSERT INTO reviews
        (id,repository_id,event_id,iid,head_sha,title,author,status,round,failure_code,failure_reason,created_at,completed_at,report_submissions)
        VALUES ($1::uuid,$2,$1::text,$3,$1::text,$4,'李娜',$5,1,$6,$7,
          now()-($8::double precision*interval '1 minute'),
          CASE WHEN $9 THEN now()-($8::double precision*interval '1 minute') ELSE NULL END,$10::jsonb)`,
      [id, this.repositoryId, iid, title, options.status, options.failureCode ?? null,
        options.failureCode ? "评审未完成，请查看实例健康" : null, options.ageMinutes ?? 60, terminal, JSON.stringify(submissions)]);
      if (options.generatorModel) {
        for (const phase of ["generator", "grader"] as const) {
          const count = phase === "generator" && options.duplicateGeneratorSession ? 2 : 1;
          for (let index = 0; index < count; index += 1) {
            const sessionId = randomUUID();
            await this.identity.pool.query(`INSERT INTO agent_sessions
              (id,dsh_session_id,kind,review_id,model,provider,status,created_at,updated_at,completed_at,error_code)
              VALUES ($1::uuid,$1::text,$2,$3,$4,$5,$6,
                now()-($7::double precision*interval '1 minute'),now()-($7::double precision*interval '1 minute'),
                CASE WHEN $8 THEN now()-($7::double precision*interval '1 minute') ELSE NULL END,$9)`,
            [sessionId, `review_${phase}`, id, phase === "generator" ? options.generatorModel : "claude-sonnet",
              `ureview-${phase}`, terminal ? options.status : "running", options.ageMinutes ?? 60, terminal, options.failureCode ?? null]);
          }
        }
      }
    });
    if (options.status === "failed" && (options.ageMinutes ?? 60) < 7 * 24 * 60) {
      this.expectedFailures.set(id, { code: options.failureCode!, teamId: this.teamId, title, iid });
    }
    return id;
  }

  async completeOnboarding(): Promise<void> {
    this.configureEnvironment();
    await this.connectRepository();
    await this.event(true);
    await this.seedRule("active");
    await this.seedReview({ status: "completed" });
  }
}
