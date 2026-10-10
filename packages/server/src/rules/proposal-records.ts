import { randomUUID } from "node:crypto";
import type pg from "pg";
import { requireIdentity } from "../auth/context.js";
import type { ReviewFinding } from "../reviews/types.js";
import type { DispositionInput } from "../reviews/dispositions.js";
import { getManagedRuleId, type ManagedRule } from "./managed-types.js";

export async function syncManagedProposal(client: pg.PoolClient, rule: ManagedRule): Promise<void> {
  const actor = requireIdentity();
  if (rule.status === "draft") {
    await client.query(`INSERT INTO rule_proposals(id,source,managed_rule_id,rule_id,name,body)
      VALUES($1,$6,$2,$3,$4,$5)
      ON CONFLICT(team_id,managed_rule_id) WHERE source IN ('generation','library') AND status='pending'
      DO UPDATE SET name=excluded.name,body=excluded.body`, [randomUUID(), rule.id, `managed:${rule.id}`, rule.name, rule.body, rule.librarySource ? "library" : "generation"]);
  } else {
    await client.query(`UPDATE rule_proposals SET name=$2,body=$3,status='accepted',reviewed_by=$4,reviewer_name=$5,reviewed_at=now()
      WHERE managed_rule_id=$1 AND source IN ('generation','library') AND status='pending'`, [rule.id, rule.name, rule.body, actor.userId, actor.name]);
  }
}

export async function syncCandidateProposals(client: pg.PoolClient): Promise<void> {
  await client.query(`INSERT INTO rule_proposals(id,source,candidate_id,repository_id,name,body,created_at)
    SELECT gen_random_uuid(),'mining',id,repository_id,'历史挖掘候选',payload->>'body',created_at FROM rule_candidates
    ON CONFLICT(team_id,candidate_id) WHERE source='mining' DO NOTHING`);
}

/** 待审核反馈随当前处置更新；提案行锁保护审核时的反馈快照。 */
export async function recordRuleFeedback(client: pg.PoolClient, reviewId: string, finding: ReviewFinding, input: DispositionInput): Promise<void> {
  if (!finding.ruleId) return;
  const actor = requireIdentity();
  // 同一规范的理由互换共用一把锁，避免跨评审反向锁住两个提案。
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-feedback:${actor.teamId}:${finding.ruleId}`]);
  const previous = await client.query<{ id: string }>(`SELECT proposal.id FROM rule_proposals proposal
    WHERE proposal.source='feedback' AND proposal.status='pending' AND EXISTS(
      SELECT 1 FROM rule_proposal_feedback feedback WHERE feedback.proposal_id=proposal.id AND feedback.finding_id=$1)
    ORDER BY proposal.id FOR UPDATE`, [finding.id]);
  const previousIds = previous.rows.map((row) => row.id);
  await client.query("DELETE FROM rule_proposal_feedback WHERE proposal_id=ANY($1::uuid[]) AND finding_id=$2", [previousIds, finding.id]);
  if (input.status === "Dismissed" && ["rule_not_applicable", "rule_incorrect"].includes(input.reasonCategory ?? "")) {
    await appendRuleFeedback(client, reviewId, finding, input);
  }
  await client.query(`UPDATE rule_proposals proposal SET status='withdrawn'
    WHERE proposal.id=ANY($1::uuid[]) AND proposal.status='pending'
    AND NOT EXISTS(SELECT 1 FROM rule_proposal_feedback feedback WHERE feedback.proposal_id=proposal.id)`, [previousIds]);
}

async function appendRuleFeedback(client: pg.PoolClient, reviewId: string, finding: ReviewFinding, input: DispositionInput): Promise<void> {
  const { rows } = await client.query<{ repository_id: string; rule: { name?: string; body?: string } | null }>(`SELECT repository_id,
    (SELECT snapshot FROM jsonb_array_elements(rules) snapshot WHERE snapshot->>'id'=$2 LIMIT 1) AS rule FROM reviews WHERE id=$1`, [reviewId, finding.ruleId]);
  const review = rows[0]!;
  const managedId = getManagedRuleId(finding.ruleId!);
  const managed = managedId ? await client.query<{ id: string; name: string; body: string }>("SELECT id,name,body FROM managed_rules WHERE id=$1", [managedId]) : null;
  if (managedId && !managed?.rows[0]) return;
  const repositoryId = managed?.rows[0] ? null : review.repository_id;
  const existing = await client.query<{ id: string }>(`SELECT id FROM rule_proposals WHERE source='feedback' AND status='pending'
    AND rule_id=$1 AND reason_category=$2 AND repository_id IS NOT DISTINCT FROM $3::uuid FOR UPDATE`, [finding.ruleId, input.reasonCategory, repositoryId]);
  let proposalId = existing.rows[0]?.id;
  if (!proposalId) {
    proposalId = randomUUID();
    await client.query(`INSERT INTO rule_proposals(id,source,managed_rule_id,rule_id,repository_id,name,body,reason_category)
      VALUES($1,'feedback',$2,$3,$4,$5,$6,$7)`, [proposalId, managed?.rows[0]?.id ?? null, finding.ruleId, repositoryId,
      managed?.rows[0]?.name ?? review.rule?.name ?? finding.ruleId, managed?.rows[0]?.body ?? review.rule?.body ?? "", input.reasonCategory]);
  }
  await client.query(`INSERT INTO rule_proposal_feedback(proposal_id,review_id,finding_id,disposition_version,title,explanation)
    VALUES($1,$2,$3,$4,$5,$6)`, [proposalId, reviewId, finding.id, input.version + 1, finding.title, input.explanation ?? null]);
}
