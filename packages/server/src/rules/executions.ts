import type pg from "pg";
import { selectVisibleFindings } from "../reviews/presentation.js";
import type { DismissalReasonCategory, FindingDisposition, FindingStatus, ReviewFinding, ReviewRule } from "../reviews/types.js";
import { getManagedRuleId } from "./managed-types.js";

export interface RuleCounts { hits: number; adopted: number; dismissed: number; ignored: number }
export interface RuleExecutionSummary extends RuleCounts { dismissalReasons: Partial<Record<DismissalReasonCategory, number>> }
export interface RuleExecution {
  reviewId: string;
  repositoryId: string;
  repositoryName: string;
  iid: number;
  title: string;
  round: number;
  completedAt: string | null;
  pullRequestUrl: string | null;
  findingId: string;
  findingTitle: string;
  severity: ReviewFinding["severity"];
  status: FindingStatus;
  disposition: FindingDisposition;
  ruleVersion: number | string;
}
interface ExecutionRow {
  review_id: string; repository_id: string; repository_name: string; iid: string; title: string;
  round: number; completed_at: Date | null; pull_request_url: string | null; rules: ReviewRule[];
  payload: ReviewFinding; status: FindingStatus; disposition_version: number;
  actor_id: string | null; actor_name: string | null; disposed_at: Date | null;
  reason_category: DismissalReasonCategory | null; explanation: string | null;
}

export function ruleExecutionKey(ruleId: string, repositoryId?: string): string {
  return getManagedRuleId(ruleId) ? ruleId : `${repositoryId}:${ruleId}`;
}

export function summarizeRuleExecutions(records: readonly RuleExecution[]): RuleExecutionSummary {
  const dismissalReasons: RuleExecutionSummary["dismissalReasons"] = {};
  for (const record of records) {
    const reason = record.disposition.reasonCategory;
    if (record.status === "Dismissed" && reason) dismissalReasons[reason] = (dismissalReasons[reason] ?? 0) + 1;
  }
  return { hits: records.length, adopted: records.filter((record) => record.status === "Resolved").length,
    dismissed: records.filter((record) => record.status === "Dismissed").length,
    ignored: 0, dismissalReasons };
}

/** 目录与详情复用评审页的展示选择，折叠项不进入命中和处置统计。 */
export async function loadRuleExecutions(pool: pg.Pool, repositoryId?: string, ruleId?: string): Promise<Map<string, RuleExecution[]>> {
  const { rows } = await pool.query<ExecutionRow>(`SELECT review.id AS review_id,review.repository_id,
      repository.path_with_namespace AS repository_name,review.iid,review.title,review.round,review.completed_at,
      review.pull_request->>'webUrl' AS pull_request_url,review.rules,
      finding.payload,finding.status,finding.disposition_version,
      event.actor_id,event.actor_name,event.created_at AS disposed_at,event.reason_category,event.explanation
    FROM reviews review JOIN repositories repository ON repository.id=review.repository_id
      JOIN review_findings finding ON finding.review_id=review.id
      LEFT JOIN finding_disposition_events event ON event.finding_id=finding.id AND event.version=finding.disposition_version
    WHERE review.status='completed' AND ($1::uuid IS NULL OR review.repository_id=$1)
      AND ($2::text IS NULL OR EXISTS(SELECT 1 FROM review_findings hit WHERE hit.review_id=review.id AND hit.payload->>'ruleId'=$2))
    ORDER BY review.completed_at DESC NULLS LAST,review.id,finding.id`, [repositoryId ?? null, ruleId ?? null]);
  const reviews = new Map<string, ExecutionRow[]>();
  for (const row of rows) {
    const entries = reviews.get(row.review_id) ?? [];
    entries.push(row);
    reviews.set(row.review_id, entries);
  }
  const result = new Map<string, RuleExecution[]>();
  for (const entries of reviews.values()) {
    const visible = new Set(selectVisibleFindings(entries.map((row) => ({ ...row.payload, status: row.status }))).findings.map((finding) => finding.id));
    for (const row of entries) {
      const id = row.payload.ruleId;
      if (!id || (ruleId && id !== ruleId) || !visible.has(row.payload.id)) continue;
      const snapshot = row.rules.find((rule) => rule.id === id && (rule.file.kind === "database"
        ? id === `managed:${rule.file.ruleId}` : rule.file.repositoryId === row.repository_id));
      if (!snapshot) continue;
      const key = ruleExecutionKey(id, row.repository_id);
      const records = result.get(key) ?? [];
      records.push({ reviewId: row.review_id, repositoryId: row.repository_id, repositoryName: row.repository_name,
        iid: Number(row.iid), title: row.title, round: row.round, completedAt: row.completed_at?.toISOString() ?? null,
        pullRequestUrl: row.pull_request_url, findingId: row.payload.id, findingTitle: row.payload.title,
        severity: row.payload.severity, status: row.status, ruleVersion: snapshot.file.kind === "database" ? snapshot.file.version : snapshot.file.commitSha,
        disposition: { status: row.status, version: row.disposition_version,
          actor: row.actor_id ? { id: row.actor_id, name: row.actor_name! } : null, updatedAt: row.disposed_at?.toISOString() ?? null,
          reasonCategory: row.reason_category, explanation: row.explanation } });
      result.set(key, records);
    }
  }
  return result;
}
