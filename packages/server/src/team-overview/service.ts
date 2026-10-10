import type pg from "pg";
import { requireAdmin } from "../auth/context.js";
import { dismissalReasons } from "../reviews/dispositions.js";
import { selectVisibleFindings } from "../reviews/presentation.js";
import type { DismissalReasonCategory, FindingStatus, ReviewFinding, ReviewRule, ReviewStatus } from "../reviews/types.js";

export interface TeamOverview {
  period: { from: string; to: string };
  totals: { repositories: number; pullRequests: number; completed: number; queued: number; running: number };
  reviewRounds: number;
  findings: { high: number; medium: number; resolved: number; dismissed: number };
  adoptionRate: number | null;
  dismissalReasons: Array<{ category: DismissalReasonCategory; count: number }>;
  mostDismissedRules: Array<{ id: string; name: string; repositoryId: string | null; repositoryName: string | null; count: number }>;
}

interface RoundRow {
  id: string;
  repository_id: string;
  repository_name: string;
  status: ReviewStatus;
  rules: ReviewRule[];
  findings: Array<{ payload: ReviewFinding; status: FindingStatus; reason: DismissalReasonCategory | null }>;
}

export class TeamOverviewService {
  constructor(private readonly pool: pg.Pool) {}

  async get(): Promise<TeamOverview> {
    const identity = requireAdmin();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const window = (await client.query<{ starts_at: Date; ends_at: Date }>(
        "SELECT now() - interval '28 days' AS starts_at, now() AS ends_at")).rows[0]!;
      const totals = (await client.query<TeamOverview["totals"]>(`WITH latest AS (
        SELECT DISTINCT ON (repository_id,iid) status FROM reviews WHERE team_id=$1 ORDER BY repository_id,iid,round DESC
      ) SELECT (SELECT count(*)::int FROM repositories WHERE team_id=$1) AS repositories,
        count(*)::int AS "pullRequests", count(*) FILTER (WHERE status='completed')::int AS completed,
        count(*) FILTER (WHERE status='queued')::int AS queued, count(*) FILTER (WHERE status='running')::int AS running FROM latest`,
      [identity.teamId])).rows[0]!;
      const { rows } = await client.query<RoundRow>(`SELECT review.id,review.repository_id,repository.name AS repository_name,
        review.status,review.rules,coalesce(jsonb_agg(jsonb_build_object('payload',finding.payload,
          'status',finding.status,'reason',event.reason_category)) FILTER (WHERE finding.id IS NOT NULL),'[]') AS findings
        FROM reviews review JOIN repositories repository ON repository.id=review.repository_id
        LEFT JOIN review_findings finding ON finding.review_id=review.id AND review.status='completed'
        LEFT JOIN finding_disposition_events event ON event.finding_id=finding.id AND event.version=finding.disposition_version
        WHERE review.team_id=$1 AND review.created_at >= $2 AND review.created_at <= $3
        GROUP BY review.id,repository.name ORDER BY review.created_at DESC,review.id`,
      [identity.teamId, window.starts_at, window.ends_at]);
      await client.query("COMMIT");

      const findings = { high: 0, medium: 0, resolved: 0, dismissed: 0 };
      const reasons = new Map<DismissalReasonCategory, number>(dismissalReasons.map((category) => [category, 0]));
      const rules = new Map<string, TeamOverview["mostDismissedRules"][number]>();
      for (const round of rows) {
        const records = new Map(round.findings.map((entry) => [entry.payload.id, entry]));
        const visible = selectVisibleFindings(round.findings.map((entry) => ({ ...entry.payload, status: entry.status }))).findings;
        for (const finding of visible) {
          if (finding.severity === "high") findings.high++;
          if (finding.severity === "medium") findings.medium++;
          if (finding.status === "Resolved") findings.resolved++;
          if (finding.status !== "Dismissed") continue;
          findings.dismissed++;
          const reason = records.get(finding.id)?.reason;
          if (reason) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
          if (!finding.ruleId) continue;
          const snapshot = round.rules.find((rule) => rule.id === finding.ruleId);
          const repositoryId = snapshot?.file.kind === "database" || finding.ruleId.startsWith("managed:") ? null : round.repository_id;
          const key = JSON.stringify([repositoryId, finding.ruleId]);
          const existing = rules.get(key);
          if (existing) existing.count++;
          else rules.set(key, { id: finding.ruleId, name: snapshot?.name || snapshot?.body.split("\n")[0]?.replace(/^#+\s*/, "").trim() || finding.ruleId,
            repositoryId, repositoryName: repositoryId ? round.repository_name : null, count: 1 });
        }
      }
      const disposed = findings.resolved + findings.dismissed;
      return { period: { from: window.starts_at.toISOString(), to: window.ends_at.toISOString() }, totals, reviewRounds: rows.length,
        findings, adoptionRate: disposed ? findings.resolved / disposed : null,
        dismissalReasons: dismissalReasons.map((category) => ({ category, count: reasons.get(category)! })),
        mostDismissedRules: [...rules.values()].sort((a, b) => b.count - a.count || a.id.localeCompare(b.id, "en") || (a.repositoryId ?? "").localeCompare(b.repositoryId ?? "", "en")).slice(0, 5) };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}
