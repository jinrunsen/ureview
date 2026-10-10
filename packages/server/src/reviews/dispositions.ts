import { randomUUID } from "node:crypto";
import type pg from "pg";
import { requireIdentity } from "../auth/context.js";
import { selectVisibleFindings } from "./presentation.js";
import type { FindingDisposition, FindingStatus, ReviewFinding } from "./types.js";
import { recordRuleFeedback } from "../rules/proposal-records.js";

export const dismissalReasons = ["false_positive", "rule_not_applicable", "rule_incorrect", "not_worth_fixing", "other"] as const;
type ReasonCategory = typeof dismissalReasons[number];
export interface DispositionInput {
  version: number;
  status: "Resolved" | "Dismissed" | "Pending";
  reasonCategory?: ReasonCategory;
  explanation?: string;
}
export class DispositionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
interface EventRow {
  id: string; actor_id: string; actor_name: string; created_at: Date;
  previous_status: FindingStatus; status: FindingStatus;
  reason_category: ReasonCategory | null; explanation: string | null; version: number;
}
interface DispositionRow {
  id: string; status: FindingStatus; disposition_version: number;
  actor_id: string | null; actor_name: string | null; created_at: Date | null;
  reason_category: ReasonCategory | null; explanation: string | null;
}
const eventColumns = `event.actor_id,event.actor_name,event.created_at,event.reason_category,event.explanation`;
function disposition(row: DispositionRow): FindingDisposition {
  return { status: row.status, version: row.disposition_version,
    actor: row.actor_id ? { id: row.actor_id, name: row.actor_name! } : null,
    updatedAt: row.created_at?.toISOString() ?? null,
    reasonCategory: row.reason_category, explanation: row.explanation };
}
export async function loadFindingDispositions(pool: pg.Pool, reviewId: string): Promise<Map<string, FindingDisposition>> {
  const { rows } = await pool.query<DispositionRow>(`SELECT finding.id,finding.status,finding.disposition_version,${eventColumns}
    FROM review_findings finding LEFT JOIN finding_disposition_events event
      ON event.finding_id=finding.id AND event.version=finding.disposition_version
    WHERE finding.review_id=$1`, [reviewId]);
  return new Map(rows.map((row) => [row.id, disposition(row)]));
}
export function validateDisposition(value: unknown): DispositionInput {
  const invalid = (message = "处置参数不正确") => new DispositionError(400, "invalid_input", message);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["version", "status", "reasonCategory", "explanation"].includes(key)) ||
    !Number.isInteger(input.version) || Number(input.version) < 0 || Number(input.version) >= 2_147_483_647 ||
    typeof input.status !== "string" || !["Pending", "Resolved", "Dismissed"].includes(input.status)) throw invalid();
  if (input.explanation !== undefined && (typeof input.explanation !== "string" || input.explanation.length > 4000)) throw invalid();
  const explanation = typeof input.explanation === "string" ? input.explanation.trim() : "";
  if (input.status === "Dismissed") {
    if (!dismissalReasons.includes(input.reasonCategory as ReasonCategory)) throw invalid("驳回需要选择理由类别");
    if (input.reasonCategory === "other" && !explanation) throw invalid("选择其他理由时需要填写说明");
  } else if (input.reasonCategory !== undefined || input.explanation !== undefined) throw invalid("只有驳回可以填写理由");
  return { version: Number(input.version), status: input.status as DispositionInput["status"],
    ...(input.status === "Dismissed" ? { reasonCategory: input.reasonCategory as ReasonCategory, ...(explanation ? { explanation } : {}) } : {}) };
}

export class FindingDispositionService {
  constructor(private readonly pool: pg.Pool) {}

  async change(reviewId: string, findingId: string, value: unknown): Promise<ReviewFinding> {
    const actor = requireIdentity();
    const input = validateDisposition(value);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 同轮处置串行，最后一条处置与看完标记在同一事务内判定。
      const review = await client.query<{ status: string }>("SELECT status FROM reviews WHERE id=$1 FOR UPDATE", [reviewId]);
      if (!review.rows[0]) throw new DispositionError(404, "not_found", "评审不存在");
      if (review.rows[0].status !== "completed") throw new DispositionError(409, "conflict", "评审完成后才能处置 finding");
      const result = await client.query<{ payload: ReviewFinding; status: FindingStatus; disposition_version: number }>(
        "SELECT payload,status,disposition_version FROM review_findings WHERE review_id=$1 ORDER BY id FOR UPDATE", [reviewId]);
      const findings = result.rows.map((row) => ({ ...row.payload, status: row.status }));
      const visible = selectVisibleFindings(findings).findings;
      const finding = visible.find((item) => item.id === findingId);
      if (!finding) throw new DispositionError(404, "not_found", "展示的 finding 不存在");
      const previous = result.rows.find((row) => row.payload.id === findingId)!;
      if (previous.disposition_version !== input.version) throw new DispositionError(409, "conflict", "处置已被其他人更新，请刷新后重新核对");
      if (["Ignored", "Outdated"].includes(previous.status)) throw new DispositionError(409, "conflict", "该 finding 的系统状态不能人工修改");
      const latest = await client.query<EventRow>(`SELECT * FROM finding_disposition_events WHERE finding_id=$1 AND version=$2`, [findingId, input.version]);
      const prior = latest.rows[0];
      if (previous.status === input.status && (prior?.reason_category ?? null) === (input.reasonCategory ?? null) &&
        (prior?.explanation ?? null) === (input.explanation ?? null)) {
        await client.query("COMMIT");
        return { ...finding, disposition: disposition({ id: findingId, status: previous.status, disposition_version: input.version,
          actor_id: prior?.actor_id ?? null, actor_name: prior?.actor_name ?? null, created_at: prior?.created_at ?? null,
          reason_category: prior?.reason_category ?? null, explanation: prior?.explanation ?? null }) };
      }
      const version = input.version + 1;
      const inserted = await client.query<EventRow>(`INSERT INTO finding_disposition_events
        (id,review_id,finding_id,actor_id,actor_name,previous_status,status,reason_category,explanation,version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [randomUUID(), reviewId, findingId, actor.userId, actor.name, previous.status, input.status, input.reasonCategory ?? null, input.explanation ?? null, version]);
      await client.query(`UPDATE review_findings SET status=$2,disposition_version=$3,payload=jsonb_set(payload,'{status}',to_jsonb($2::text)) WHERE id=$1`,
        [findingId, input.status, version]);
      await recordRuleFeedback(client, reviewId, finding, input);
      if (visible.every((item) => ["Resolved", "Dismissed"].includes(item.id === findingId ? input.status : item.status))) {
        await client.query(`INSERT INTO review_participants(review_id,user_id,completed_at) VALUES($1,$2,now())
          ON CONFLICT(team_id,review_id,user_id) DO UPDATE SET completed_at=coalesce(review_participants.completed_at,excluded.completed_at)`, [reviewId, actor.userId]);
        await client.query("UPDATE reviews SET viewed_at=coalesce(viewed_at,now()) WHERE id=$1", [reviewId]);
      }
      await client.query("COMMIT");
      const event = inserted.rows[0]!;
      return { ...finding, status: input.status, disposition: { status: input.status, version,
        actor: { id: actor.userId, name: actor.name }, updatedAt: event.created_at.toISOString(),
        reasonCategory: event.reason_category, explanation: event.explanation } };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async history(reviewId: string, findingId: string) {
    requireIdentity();
    const finding = await this.pool.query("SELECT id FROM review_findings WHERE review_id=$1 AND id=$2", [reviewId, findingId]);
    if (!finding.rowCount) throw new DispositionError(404, "not_found", "finding 不存在");
    const { rows } = await this.pool.query<EventRow>("SELECT * FROM finding_disposition_events WHERE review_id=$1 AND finding_id=$2 ORDER BY version", [reviewId, findingId]);
    return { events: rows.map((row) => ({ id: row.id, actor: { id: row.actor_id, name: row.actor_name }, createdAt: row.created_at.toISOString(),
      previousStatus: row.previous_status, status: row.status, reasonCategory: row.reason_category, explanation: row.explanation, version: row.version })) };
  }
}
