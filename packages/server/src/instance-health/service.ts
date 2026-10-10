import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type pg from "pg";
import { requireAdmin, requireServiceAdmin } from "../auth/context.js";
import type { ServiceSettings } from "../service-settings/service.js";
import { modelFailureCode } from "./model-failure.js";
import type { InstanceHealth, ModelPhase, OnboardingChecklist } from "./types.js";

const require = createRequire(import.meta.url);
const packageInfo = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const dshInfo = require("@deepseek-ai/dsh-app-boot/package.json") as { version: string };
interface ModelHistoryRow { phase: ModelPhase; last_success_at: Date | null; last_failure_at: Date | null; last_failure_code: string | null }
interface MetricRow { phase: ModelPhase; provider: string; model: string; total: number; completed: number; failed: number; rejected: string }
interface FailureRow { id: string; title: string; repository_name: string; iid: string; round: number; completed_at: Date; code: string }

export class InstanceHealthService {
  constructor(private readonly pool: pg.Pool, private readonly settings?: ServiceSettings) {}

  private async availability() {
    return this.settings?.availability() ?? { ready: false,
      models: (["generator", "grader"] as const).map((phase) => ({ phase, configured: false, source: "none" as const, model: "" })) };
  }

  async onboarding(): Promise<OnboardingChecklist> {
    const identity = requireAdmin();
    const models = await this.availability();
    const row = (await this.pool.query<{ repository_id: string | null; webhook: boolean; rules: boolean; review: boolean }>(`SELECT
      (SELECT id FROM repositories ORDER BY connected_at,id LIMIT 1) AS repository_id,
      EXISTS(SELECT 1 FROM repository_webhook_events) AS webhook,
      (EXISTS(SELECT 1 FROM managed_rules WHERE status='active') OR EXISTS(SELECT 1 FROM rule_catalog
        WHERE payload->>'kind' IS DISTINCT FROM 'lint' AND payload->>'enabled'='true' AND payload->>'lazy'='false')) AS rules,
      EXISTS(SELECT 1 FROM reviews WHERE status='completed') AS review`)).rows[0]!;
    const steps: OnboardingChecklist["steps"] = [
      { id: "models", completed: models.ready }, { id: "repository", completed: row.repository_id !== null },
      { id: "webhook", completed: row.webhook }, { id: "rules", completed: row.rules }, { id: "review", completed: row.review },
    ];
    return { completed: steps.every((step) => step.completed), canManageModels: identity.serviceRole === "service_admin",
      repositoryId: row.repository_id, steps };
  }

  async get(): Promise<InstanceHealth> {
    const identity = requireServiceAdmin();
    const availability = await this.availability();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const period = (await client.query<{ from: Date; to: Date }>("SELECT now()-interval '7 days' AS from, now() AS to")).rows[0]!;
      const migration = (await client.query<{ filename: string }>("SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1")).rows[0]?.filename ?? null;
      const teams = (await client.query<{ id: string; name: string; can_open: boolean }>(`SELECT team.id,team.name,
        EXISTS(SELECT 1 FROM team_members member WHERE member.team_id=team.id AND member.user_id=$1) AS can_open
        FROM teams team ORDER BY team.id`, [identity.userId])).rows;
      const health: InstanceHealth = { period: { from: period.from.toISOString(), to: period.to.toISOString() },
        models: availability.models.map((model) => ({ ...model, lastSuccessAt: null, lastFailure: null })),
        queue: { queued: 0, running: 0, oldestQueuedAt: null, oldestWaitSeconds: null }, failures: [], modelMetrics: [],
        versions: { ureview: packageInfo.version, dsh: dshInfo.version, migration } };
      const histories = (await client.query<ModelHistoryRow>("SELECT * FROM service_model_health")).rows;
      const failureGroups = new Map<string, InstanceHealth["failures"][number]>();
      const metrics = new Map<string, MetricRow>();
      for (const team of teams) {
        // 实例管理员逐团队读取同一个数据库快照，查询仍受强制 RLS 约束。
        await client.query("SELECT set_config('app.team_id',$1,true)", [team.id]);
        const queue = (await client.query<{ queued: number; running: number; oldest: Date | null }>(`SELECT
          count(*) FILTER (WHERE status='queued')::int AS queued,count(*) FILTER (WHERE status='running')::int AS running,
          min(created_at) FILTER (WHERE status='queued') AS oldest FROM reviews WHERE status IN ('queued','running')`)).rows[0]!;
        health.queue.queued += queue.queued;
        health.queue.running += queue.running;
        if (queue.oldest && (!health.queue.oldestQueuedAt || queue.oldest.toISOString() < health.queue.oldestQueuedAt)) {
          health.queue.oldestQueuedAt = queue.oldest.toISOString();
        }
        const failures = (await client.query<FailureRow>(`SELECT review.id,review.title,repository.path_with_namespace AS repository_name,
          review.iid,review.round,review.completed_at,coalesce(review.failure_code,'operation_failed') AS code
          FROM reviews review JOIN repositories repository ON repository.id=review.repository_id
          WHERE review.status='failed' AND review.completed_at BETWEEN $1 AND $2 ORDER BY review.completed_at DESC,review.id`,
        [period.from, period.to])).rows;
        for (const failure of failures) {
          let group = failureGroups.get(failure.code);
          if (!group) { group = { code: failure.code, count: 0, reviews: [] }; failureGroups.set(failure.code, group); }
          group.count++;
          group.reviews.push({ id: failure.id, title: failure.title, repositoryName: failure.repository_name, iid: Number(failure.iid),
            round: failure.round, completedAt: failure.completed_at.toISOString(), teamId: team.id, teamName: team.name, canOpen: team.can_open });
        }
        const rows = (await client.query<MetricRow>(`WITH identities AS (
          SELECT DISTINCT review_id,CASE kind WHEN 'review_generator' THEN 'generator' ELSE 'grader' END AS phase,provider,model
          FROM agent_sessions WHERE kind IN ('review_generator','review_grader')
        ), rounds AS (
          SELECT identity.*,review.status,(SELECT count(*) FROM jsonb_array_elements(review.report_submissions) submission
            WHERE submission->>'phase'=identity.phase AND submission->>'outcome'='rejected') AS rejected
          FROM identities identity JOIN reviews review ON review.id=identity.review_id
          WHERE review.status IN ('completed','failed') AND review.completed_at BETWEEN $1 AND $2
        ) SELECT phase,provider,model,count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed,
          count(*) FILTER (WHERE status='failed')::int AS failed,sum(rejected)::text AS rejected FROM rounds GROUP BY phase,provider,model`,
        [period.from, period.to])).rows;
        for (const row of rows) {
          const key = JSON.stringify([row.phase, row.provider, row.model]);
          const existing = metrics.get(key);
          if (!existing) metrics.set(key, row);
          else {
            existing.total += row.total; existing.completed += row.completed; existing.failed += row.failed;
            existing.rejected = String(Number(existing.rejected) + Number(row.rejected));
          }
        }
        histories.push(...(await client.query<ModelHistoryRow>(`WITH activity AS (
          SELECT CASE kind WHEN 'review_grader' THEN 'grader' ELSE 'generator' END AS phase,status,completed_at,
            coalesce((SELECT event#>>'{data,reason,error,code}' FROM agent_session_events event
              WHERE event.session_id=session.id AND event.event->>'type'='turn/end'
                AND event.event#>>'{data,reason,kind}'='error' ORDER BY event.seq DESC LIMIT 1),session.error_code) AS error_code,id
          FROM agent_sessions session WHERE status IN ('completed','failed')
        ) SELECT phase,max(completed_at) FILTER (WHERE status='completed') AS last_success_at,
          max(completed_at) FILTER (WHERE status='failed') AS last_failure_at,
          (array_agg(error_code ORDER BY completed_at DESC,id) FILTER (WHERE status='failed'))[1] AS last_failure_code
          FROM activity GROUP BY phase`)).rows);
      }
      await client.query("COMMIT");
      for (const history of histories) {
        const model = health.models.find((item) => item.phase === history.phase)!;
        const successAt = history.last_success_at?.toISOString();
        if (successAt && (!model.lastSuccessAt || successAt > model.lastSuccessAt)) model.lastSuccessAt = successAt;
        const failureAt = history.last_failure_at?.toISOString();
        if (failureAt && (!model.lastFailure || failureAt > model.lastFailure.at)) {
          model.lastFailure = { at: failureAt, code: modelFailureCode(history.last_failure_code) };
        }
      }
      if (health.queue.oldestQueuedAt) {
        health.queue.oldestWaitSeconds = Math.max(0, Math.floor((period.to.getTime() - new Date(health.queue.oldestQueuedAt).getTime()) / 1000));
      }
      health.failures = [...failureGroups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code, "en"));
      for (const group of health.failures) group.reviews.sort((a, b) => b.completedAt.localeCompare(a.completedAt) || a.id.localeCompare(b.id));
      health.modelMetrics = [...metrics.values()].map(({ rejected, ...row }) => ({ ...row, completionRate: row.completed / row.total,
        averageRejectedSubmissions: Number(rejected) / row.total })).sort((a, b) => a.phase.localeCompare(b.phase) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
      return health;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
