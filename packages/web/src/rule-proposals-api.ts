import { isRecord, request } from "./api";
import { isManagedRule, type ManagedRule, type ManagedRuleInput } from "./managed-rules-api";
import { isCandidate, type Candidate } from "./rules-api";
import { dispositionReasonLabels, type DispositionReason } from "./review-api";

export const proposalSourceLabels = { generation: "规则生成", library: "规范库", mining: "历史挖掘", feedback: "驳回反馈" } as const;
export const proposalStatusLabels = { pending: "待审核", accepted: "已采纳", rejected: "已拒绝", withdrawn: "已撤回" } as const;
export type ProposalSource = keyof typeof proposalSourceLabels;
export type ProposalStatus = keyof typeof proposalStatusLabels;
export interface RuleProposal {
  id: string; source: ProposalSource; status: ProposalStatus; name: string; body: string;
  managedRuleId: string | null; ruleId: string | null; repositoryId: string | null; reasonCategory: DispositionReason | null;
  feedbackCount: number; feedback: Array<{ findingId: string; reviewId: string; title: string; explanation: string | null; createdAt: string }>;
  candidate: Candidate | null; createdAt: string; reviewedAt: string | null; reviewedBy: { id: string; name: string } | null; rejectionReason: string | null;
}
function isProposal(value: unknown): value is RuleProposal {
  return isRecord(value) && ["id", "name", "body", "createdAt"].every((name) => typeof value[name] === "string") && Object.hasOwn(proposalSourceLabels, String(value.source)) && Object.hasOwn(proposalStatusLabels, String(value.status)) &&
    [value.managedRuleId, value.ruleId, value.repositoryId, value.reviewedAt, value.rejectionReason].every((entry) => entry === null || typeof entry === "string") &&
    (value.reasonCategory === null || Object.hasOwn(dispositionReasonLabels, String(value.reasonCategory))) && Number.isSafeInteger(value.feedbackCount) && Number(value.feedbackCount) >= 0 &&
    Array.isArray(value.feedback) && value.feedback.every((entry) => isRecord(entry) && ["findingId", "reviewId", "title", "createdAt"].every((key) => typeof entry[key] === "string") && (entry.explanation === null || typeof entry.explanation === "string")) &&
    (value.candidate === null || isCandidate(value.candidate)) && (value.reviewedBy === null || isRecord(value.reviewedBy) && typeof value.reviewedBy.id === "string" && typeof value.reviewedBy.name === "string");
}
export function getRuleProposals(filters: { repositoryId?: string; status?: ProposalStatus; source?: ProposalSource } = {}, signal?: AbortSignal) {
  const query = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  return request(`/api/rule-proposals${query.size ? `?${query}` : ""}`, (value): value is { proposals: RuleProposal[] } => isRecord(value) && Array.isArray(value.proposals) && value.proposals.every(isProposal), { signal });
}
export function reviewRuleProposal(id: string, input: { status: "accepted" | "rejected"; reason?: string; rule?: ManagedRuleInput & { version: number } }, signal?: AbortSignal) {
  return request(`/api/rule-proposals/${encodeURIComponent(id)}/review`, (value): value is { proposal: RuleProposal; rule?: ManagedRule } => isRecord(value) && isProposal(value.proposal) && (value.rule === undefined || isManagedRule(value.rule)),
    { method: "POST", body: JSON.stringify(input), signal });
}

export type ProposalReviewStatus = "accepted" | "rejected";
export type ProposalBatchResult = { id: string; name: string } & ({ proposal: RuleProposal } | { error: string });
export const proposalNeedsEditing = (proposal: RuleProposal) => proposal.source === "feedback" && proposal.managedRuleId !== null;
export function batchReviewTargets(proposals: readonly RuleProposal[], status: ProposalReviewStatus): RuleProposal[] {
  return proposals.filter((proposal) => proposal.status === "pending" && (status === "rejected" || !proposalNeedsEditing(proposal)));
}

export async function reviewRuleProposalBatch(proposals: readonly RuleProposal[], input: { status: ProposalReviewStatus; reason?: string },
  onResult: (result: ProposalBatchResult) => void, signal: AbortSignal): Promise<void> {
  const reason = input.reason?.trim() ?? "";
  if (input.status === "rejected" && (!reason || reason.length > 2000)) throw new Error("拒绝理由需为 1 至 2000 个字符");
  for (const proposal of batchReviewTargets(proposals, input.status)) {
    if (signal.aborted) break;
    let result: ProposalBatchResult;
    try {
      const response = await reviewRuleProposal(proposal.id, { status: input.status, ...(input.status === "rejected" ? { reason } : {}) }, signal);
      result = { id: proposal.id, name: proposal.name, proposal: response.proposal };
    } catch (cause) {
      result = { id: proposal.id, name: proposal.name, error: cause instanceof Error ? cause.message : "提案审核失败" };
    }
    if (signal.aborted) break;
    onResult(result);
  }
}
