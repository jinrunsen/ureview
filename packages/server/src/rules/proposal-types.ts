import type { CandidateEntry } from "./catalog.js";

export const proposalSources = ["generation", "library", "mining", "feedback"] as const;
export const proposalStatuses = ["pending", "accepted", "rejected", "withdrawn"] as const;
export interface RuleProposal {
  id: string; source: typeof proposalSources[number]; status: typeof proposalStatuses[number];
  name: string; body: string; managedRuleId: string | null; ruleId: string | null; repositoryId: string | null;
  reasonCategory: "rule_not_applicable" | "rule_incorrect" | null;
  feedbackCount: number;
  feedback: Array<{ findingId: string; reviewId: string; title: string; explanation: string | null; createdAt: string }>;
  candidate: CandidateEntry | null; createdAt: string; reviewedAt: string | null;
  reviewedBy: { id: string; name: string } | null; rejectionReason: string | null;
}
