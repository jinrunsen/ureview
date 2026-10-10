import { selectVisibleFindings } from "./presentation.js";
import type { ReviewFinding, RoundComparison } from "./types.js";

interface PreviousRound { id: string; round: number; findings: ReviewFinding[] }

function matchRank(current: ReviewFinding, previous: ReviewFinding): number | null {
  if (current.location.path !== previous.location.path) return null;
  const sameFingerprint = Boolean(current.fingerprint && current.fingerprint === previous.fingerprint);
  const sameRuleAndTitle = Boolean(current.ruleId && current.ruleId === previous.ruleId && current.title === previous.title);
  if (sameFingerprint) return sameRuleAndTitle ? 0 : 1;
  return sameRuleAndTitle ? 2 : null;
}

export function compareReviewRounds(findings: ReviewFinding[], previous: PreviousRound | null): {
  findings: ReviewFinding[]; comparison: RoundComparison;
} {
  const matchedPrevious = new Set<string>();
  const compared = findings.map((finding): ReviewFinding => {
    const matches = (previous?.findings ?? []).flatMap((candidate) => {
      const rank = matchRank(finding, candidate);
      if (rank === null) return [];
      matchedPrevious.add(candidate.id);
      return [{ candidate, rank }];
    }).sort((a, b) => a.rank - b.rank || a.candidate.id.localeCompare(b.candidate.id, "en"));
    const match = matches[0]?.candidate;
    return { ...finding, comparison: match && previous ? {
      kind: "recurring",
      previousFinding: { reviewId: previous.id, round: previous.round, findingId: match.id,
        status: match.status, disposition: match.disposition ?? null },
    } : { kind: "new", previousFinding: null } };
  });
  return {
    findings: compared,
    comparison: {
      previousReview: previous ? { id: previous.id, round: previous.round } : null,
      absentFindings: previous ? selectVisibleFindings(previous.findings).findings.filter((finding) => !matchedPrevious.has(finding.id)) : [],
    },
  };
}
