import type pg from "pg";
import { randomUUID } from "node:crypto";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { assertContiguous, assertVersion, materializeCreateHeader, validateStoredEvents } from "@deepseek-ai/dsh-session-persistence";
import { requireIdentity } from "../auth/context.js";
import { currentTeamId } from "../db/tenant.js";
import { logEvent } from "../logging.js";
import { projectSessionEvent, redactSessionText } from "./projection.js";
import { AgentSessionError, agentSessionKinds, type AgentSessionEvents, type AgentSessionListOptions,
  type AgentSessionPage, type AgentSessionStatus, type AgentSessionSummary, type BeginAgentSession } from "./types.js";

interface SessionRow {
  id: string; dsh_session_id: string; kind: AgentSessionSummary["kind"]; status: AgentSessionStatus;
  model: string; provider: string; review_id: string | null; rule_session_id: string | null;
  last_seq: number; error_code: string | null; created_at: Date; updated_at: Date; completed_at: Date | null;
  title: string; repository_name: string | null; pr_number: string | null; head_sha: string | null; review_round: number | null;
}
const projection = `SELECT session.*,coalesce(review.title,rule.title) title,
  repository.path_with_namespace repository_name,review.iid pr_number,review.head_sha,review.round review_round
  FROM agent_sessions session LEFT JOIN reviews review ON review.id=session.review_id
  LEFT JOIN repositories repository ON repository.id=review.repository_id
  LEFT JOIN managed_rule_sessions rule ON rule.id=session.rule_session_id`;
const missing = () => new AgentSessionError(404, "not_found", "Agent 会话不存在或无权查看");
const invalid = () => new AgentSessionError(400, "invalid_input", "会话查询参数不正确");
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function identifier(id: string): string { if (!uuid.test(id)) throw invalid(); return id.toLowerCase(); }
function summary(row: SessionRow): AgentSessionSummary {
  return { id: row.id, dshSessionId: row.dsh_session_id, title: redactSessionText(row.title), kind: row.kind, status: row.status,
    model: row.model, provider: row.provider, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null, reviewId: row.review_id, ruleSessionId: row.rule_session_id,
    repositoryName: row.repository_name, prNumber: row.pr_number === null ? null : Number(row.pr_number), headSha: row.head_sha,
    reviewRound: row.review_round, lastSeq: row.last_seq, errorCode: row.error_code };
}

export class AgentSessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async recoverInterrupted(): Promise<void> {
    if (!currentTeamId()) throw invalid();
    await this.pool.query(`UPDATE agent_sessions SET status='failed',error_code='service_restarted',completed_at=now(),updated_at=now() WHERE status='running'`);
  }

  /** 只导入领域层已经保存的成功检查点，不补造旧失败轮或旧评审。 */
  async importRuleHistory(): Promise<void> {
    if (!currentTeamId()) throw invalid();
    const candidates = await this.pool.query<{ id: string; checkpoint: unknown; created_at: Date; updated_at: Date }>(
      `SELECT id,checkpoint,created_at,updated_at FROM managed_rule_sessions rule WHERE checkpoint IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM agent_sessions session WHERE session.rule_session_id=rule.id)`);
    for (const row of candidates.rows) {
      let events: SessionEvent[], header: SessionHeader;
      try {
        if (!row.checkpoint || typeof row.checkpoint !== "object") throw new Error("无效检查点");
        const checkpoint = row.checkpoint as { header?: SessionHeader; events?: SessionEvent[] };
        if (!checkpoint.header || !Array.isArray(checkpoint.events)) throw new Error("无效检查点");
        header = materializeCreateHeader(checkpoint.header);
        assertVersion(header);
        events = validateStoredEvents(header, structuredClone(checkpoint.events));
        assertContiguous(header.id, events, 0);
        events = events.map(projectSessionEvent);
      } catch {
        logEvent("agent.history.skipped", { ruleSessionId: row.id, reason: "invalid_checkpoint" });
        continue;
      }
      const request = events.findLast((event) => event.type === "request/header");
      const model = request?.type === "request/header" ? request.data.header.config.model : "unknown";
      const provider = request?.type === "request/header" ? request.data.header.config.provider : "unknown";
      const id = randomUUID(), client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT id FROM managed_rule_sessions WHERE id=$1 FOR UPDATE", [row.id]);
        if ((await client.query("SELECT id FROM agent_sessions WHERE rule_session_id=$1 LIMIT 1", [row.id])).rowCount) { await client.query("COMMIT"); continue; }
        await client.query(`INSERT INTO agent_sessions(id,dsh_session_id,kind,rule_session_id,model,provider,status,last_seq,created_at,updated_at,completed_at)
          VALUES($1,$2,'rule_generation',$3,$4,$5,'completed',$6,$7,$8,$8)`,
        [id, header.id, row.id, model, provider, events.length - 1, row.created_at, row.updated_at]);
        for (const event of events) await client.query("INSERT INTO agent_session_events(session_id,seq,event) VALUES($1,$2,$3)", [id, event.seq, JSON.stringify(event)]);
        await client.query("COMMIT");
      } catch (cause) { await client.query("ROLLBACK"); throw cause; }
      finally { client.release(); }
    }
  }

  async begin(input: BeginAgentSession): Promise<void> {
    identifier(input.id);
    if (!currentTeamId() || !agentSessionKinds.includes(input.kind) || !input.dshSessionId || input.dshSessionId.length > 512 ||
      !input.model || !input.provider || (input.kind === "rule_generation" ? !input.ruleSessionId || input.reviewId : !input.reviewId || input.ruleSessionId)) throw invalid();
    if (input.reviewId) identifier(input.reviewId);
    if (input.ruleSessionId) identifier(input.ruleSessionId);
    const source = input.reviewId ? "reviews" : "managed_rule_sessions";
    const result = await this.pool.query(`INSERT INTO agent_sessions(id,dsh_session_id,kind,review_id,rule_session_id,model,provider)
      SELECT $1,$2,$3,$4,$5,$6,$7 FROM ${source} WHERE id=$8`,
    [input.id, input.dshSessionId, input.kind, input.reviewId ?? null, input.ruleSessionId ?? null,
      redactSessionText(input.model), redactSessionText(input.provider), input.reviewId ?? input.ruleSessionId]);
    if (!result.rowCount) throw missing();
  }

  async append(id: string, event: SessionEvent): Promise<void> {
    identifier(id);
    if (!Number.isSafeInteger(event.seq) || event.seq < 0 || !Number.isSafeInteger(event.time) || event.time < 0) throw invalid();
    const safe = projectSessionEvent(event);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query<{ last_seq: number; status: AgentSessionStatus }>("SELECT last_seq,status FROM agent_sessions WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!row) throw missing();
      if (event.seq <= row.last_seq) { await client.query("COMMIT"); return; }
      if (row.status !== "running" || event.seq !== row.last_seq + 1) throw new AgentSessionError(409, "session_event_order", "会话事件顺序不连续或会话已结束");
      await client.query("INSERT INTO agent_session_events(session_id,seq,event) VALUES($1,$2,$3)", [id, event.seq, JSON.stringify(safe)]);
      await client.query("UPDATE agent_sessions SET last_seq=$2,updated_at=now() WHERE id=$1", [id, event.seq]);
      await client.query("COMMIT");
    } catch (cause) { await client.query("ROLLBACK"); throw cause; }
    finally { client.release(); }
  }

  async finish(id: string, status: "completed" | "failed", errorCode?: string): Promise<void> {
    identifier(id);
    if (status !== "completed" && status !== "failed") throw invalid();
    const safeCode = errorCode && /^[a-z][a-z0-9_]{0,80}$/.test(errorCode) ? errorCode : status === "failed" ? "operation_failed" : null;
    const result = await this.pool.query(`UPDATE agent_sessions SET status=$2,error_code=$3,completed_at=now(),updated_at=now()
      WHERE id=$1 AND status='running'`, [id, status, safeCode]);
    if (!result.rowCount && !(await this.pool.query("SELECT id FROM agent_sessions WHERE id=$1", [id])).rowCount) throw missing();
  }

  async list(options: AgentSessionListOptions = {}): Promise<AgentSessionPage> {
    requireIdentity();
    const page = options.page ?? 1, pageSize = options.pageSize ?? 25;
    if (!Number.isInteger(page) || page < 1 || page > 1_000_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      (options.kind && !agentSessionKinds.includes(options.kind)) || (options.status && !["running", "completed", "failed"].includes(options.status)) ||
      (options.search !== undefined && (typeof options.search !== "string" || options.search.length > 200))) throw invalid();
    if (options.reviewId) identifier(options.reviewId);
    if (options.ruleSessionId) identifier(options.ruleSessionId);
    const filters = ` WHERE ($1::text IS NULL OR session.kind=$1) AND ($2::text IS NULL OR session.status=$2)
      AND ($3::uuid IS NULL OR session.review_id=$3) AND ($4::uuid IS NULL OR session.rule_session_id=$4)
      AND ($5::text IS NULL OR position(lower($5) in lower(concat_ws(' ',review.title,rule.title,repository.path_with_namespace,review.iid::text,session.dsh_session_id))) > 0)`;
    const values = [options.kind ?? null, options.status ?? null, options.reviewId ?? null, options.ruleSessionId ?? null, options.search?.trim() || null];
    const count = await this.pool.query<{ total: string }>(`SELECT count(*) total FROM (${projection}${filters}) visible`, values);
    const rows = await this.pool.query<SessionRow>(`${projection}${filters} ORDER BY session.updated_at DESC,session.id LIMIT $6 OFFSET $7`,
      [...values, pageSize, (page - 1) * pageSize]);
    return { items: rows.rows.map(summary), total: Number(count.rows[0]!.total), page, pageSize };
  }

  async get(id: string): Promise<AgentSessionSummary> {
    requireIdentity(); identifier(id);
    const row = (await this.pool.query<SessionRow>(`${projection} WHERE session.id=$1`, [id])).rows[0];
    if (!row) throw missing();
    return summary(row);
  }

  async events(id: string, after = -1, limit = 200): Promise<AgentSessionEvents> {
    if (!Number.isSafeInteger(after) || after < -1 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid();
    const session = await this.get(id);
    const rows = await this.pool.query<{ event: SessionEvent }>("SELECT event FROM agent_session_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT $3", [id, after, limit + 1]);
    const events = rows.rows.slice(0, limit).map((row) => row.event);
    return { events, nextAfter: events.at(-1)?.seq ?? after, hasMore: rows.rows.length > limit, session };
  }
}
