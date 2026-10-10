import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAdmin, requireIdentity } from "../auth/context.js";
import { ManagedRuleService } from "./managed.js";
import { ManagedRuleError, type ManagedRule } from "./managed-types.js";
import { managedRuleInput } from "./library.js";
import { lockRuleHierarchy } from "./managed/relations.js";
import { proposalSources, proposalStatuses, type RuleProposal } from "./proposal-types.js";

interface ProposalRow {
  id: string; source: RuleProposal["source"]; status: RuleProposal["status"]; name: string; body: string;
  managed_rule_id: string | null; rule_id: string | null; repository_id: string | null;
  reason_category: RuleProposal["reasonCategory"]; created_at: Date; reviewed_at: Date | null;
  reviewed_by: string | null; reviewer_name: string | null; rejection_reason: string | null;
  feedback: RuleProposal["feedback"]; candidate: RuleProposal["candidate"];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message: string) => new ManagedRuleError(400, "invalid_input", message);
const projection = `proposal.*,
  coalesce((SELECT jsonb_agg(jsonb_build_object('findingId',feedback.finding_id,'reviewId',feedback.review_id,
    'title',feedback.title,'explanation',feedback.explanation,'createdAt',feedback.created_at) ORDER BY feedback.created_at,feedback.finding_id)
    FROM rule_proposal_feedback feedback WHERE feedback.proposal_id=proposal.id),'[]'::jsonb) AS feedback,
  (SELECT candidate.payload || jsonb_build_object('id',candidate.id,'repositoryId',candidate.repository_id,'createdAt',candidate.created_at,
    'active',EXISTS(SELECT 1 FROM rule_catalog catalog WHERE catalog.repository_id=candidate.repository_id
      AND catalog.payload->>'kind' IS DISTINCT FROM 'lint' AND catalog.payload->>'body'=candidate.payload->>'body'
      AND catalog.payload->>'enabled'='true' AND catalog.payload->>'lazy'='false')) FROM rule_candidates candidate WHERE candidate.id=proposal.candidate_id) AS candidate`;
function publicProposal(row: ProposalRow): RuleProposal {
  return { id: row.id, source: row.source, status: row.status, name: row.name, body: row.body,
    managedRuleId: row.managed_rule_id, ruleId: row.rule_id, repositoryId: row.repository_id,
    reasonCategory: row.reason_category, feedbackCount: row.feedback.length, feedback: row.feedback, candidate: row.candidate,
    createdAt: row.created_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null,
    reviewedBy: row.reviewed_by ? { id: row.reviewed_by, name: row.reviewer_name! } : null, rejectionReason: row.rejection_reason };
}
export class RuleProposalService {
  private readonly managed: ManagedRuleService;
  constructor(private readonly pool: pg.Pool) { this.managed = new ManagedRuleService(pool); }
  async list(filters: { repositoryId?: string; status?: string; source?: string } = {}): Promise<RuleProposal[]> {
    requireIdentity();
    if (filters.repositoryId && !uuid.test(filters.repositoryId)
      || filters.status && !proposalStatuses.includes(filters.status as RuleProposal["status"])
      || filters.source && !proposalSources.includes(filters.source as RuleProposal["source"])) throw invalid("提案筛选条件不正确");
    if (filters.repositoryId && !(await this.pool.query("SELECT id FROM repositories WHERE id=$1", [filters.repositoryId])).rowCount) throw new ManagedRuleError(404, "not_found", "仓库不存在");
    const { rows } = await this.pool.query<ProposalRow>(`SELECT ${projection} FROM rule_proposals proposal
      WHERE ($1::uuid IS NULL OR proposal.repository_id=$1 OR EXISTS(SELECT 1 FROM managed_rules rule WHERE rule.id=proposal.managed_rule_id
        AND (rule.scope='global' OR EXISTS(SELECT 1 FROM managed_rule_repositories mapping WHERE mapping.rule_id=rule.id AND mapping.repository_id=$1))))
      AND ($2::text IS NULL OR proposal.status=$2) AND ($3::text IS NULL OR proposal.source=$3)
      ORDER BY proposal.created_at DESC,proposal.id`, [filters.repositoryId ?? null, filters.status ?? null, filters.source ?? null]);
    return rows.map(publicProposal);
  }
  private async get(client: pg.PoolClient, id: string): Promise<RuleProposal> {
    const { rows } = await client.query<ProposalRow>(`SELECT ${projection} FROM rule_proposals proposal WHERE proposal.id=$1`, [id]);
    if (!rows[0]) throw new ManagedRuleError(404, "not_found", "提案不存在");
    return publicProposal(rows[0]);
  }
  async review(id: string, value: unknown): Promise<{ proposal: RuleProposal; rule?: ManagedRule }> {
    const actor = requireAdmin();
    if (!uuid.test(id) || !value || typeof value !== "object" || Array.isArray(value)) throw invalid("提案审核参数不正确");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["status", "reason", "rule"].includes(key)) || !["accepted", "rejected"].includes(String(input.status))) throw invalid("请选择采纳或拒绝提案");
    if (input.reason !== undefined && (typeof input.reason !== "string" || input.reason.trim().length > 4000)) throw invalid("拒绝理由最多 4000 个字符");
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (input.status === "rejected" && !reason) throw invalid("拒绝提案需要填写理由");
    if (input.status === "rejected" && input.rule !== undefined || input.status === "accepted" && input.reason !== undefined) throw invalid("提案审核参数不正确");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRuleHierarchy(client, actor.teamId);
      await client.query("SELECT id FROM rule_proposals WHERE id=$1 FOR UPDATE", [id]);
      const proposal = await this.get(client, id);
      if (proposal.status !== "pending") throw new ManagedRuleError(409, "conflict", "提案状态已更新，请刷新后查看结果");
      let rule: ManagedRule | undefined;
      if (input.status === "accepted" && proposal.managedRuleId) {
        const current = await this.managed.get(proposal.managedRuleId, client);
        if (proposal.source === "feedback") {
          if (!input.rule || typeof input.rule !== "object" || Array.isArray(input.rule)) throw invalid("请编辑规范后保存并采纳提案");
          const { version, ...content } = input.rule as Record<string, unknown>;
          if (typeof version !== "number") throw invalid("请提供编辑前的规范版本");
          rule = await this.managed.saveInTransaction(client, content, { id: current.id, version });
        } else {
          if (input.rule !== undefined) throw invalid("启用草稿提案无需提交编辑稿");
          rule = await this.managed.saveInTransaction(client, { ...managedRuleInput(current), status: "active" }, { id: current.id, version: current.version });
        }
      } else if (input.rule !== undefined) throw invalid("该提案无需提交工作台规范");
      await client.query(`UPDATE rule_proposals SET status=$2,reviewed_at=now(),reviewed_by=$3,reviewer_name=$4,rejection_reason=$5 WHERE id=$1`,
        [id, input.status, actor.userId, actor.name, input.status === "rejected" ? reason : null]);
      const updated = await this.get(client, id);
      await client.query("COMMIT"); return { proposal: updated, ...(rule ? { rule } : {}) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
export function registerRuleProposalRoutes(app: FastifyInstance, dependencies: { pool: pg.Pool; service?: RuleProposalService }): RuleProposalService {
  const service = dependencies.service ?? new RuleProposalService(dependencies.pool);
  void app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ManagedRuleError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.get<{ Querystring: { repositoryId?: string; status?: string; source?: string } }>("/api/rule-proposals", async (request) => ({ proposals: await service.list(request.query) }));
    routes.post<{ Params: { id: string }; Body: unknown }>("/api/rule-proposals/:id/review", { bodyLimit: 2_000_000 }, async (request) => service.review(request.params.id, request.body));
  });
  return service;
}
