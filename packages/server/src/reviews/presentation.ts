import type { ReviewConclusion, ReviewFinding, ReviewStatus } from "./types.js";

const severityOrder = { high: 0, medium: 1, low: 2 };

function stableOrder(a: ReviewFinding, b: ReviewFinding): number {
  return severityOrder[a.severity] - severityOrder[b.severity] ||
    a.location.path.localeCompare(b.location.path, "en") || a.location.startLine - b.location.startLine ||
    a.location.endLine - b.location.endLine || a.title.localeCompare(b.title, "zh") || a.id.localeCompare(b.id, "en");
}

export function selectVisibleFindings(findings: ReviewFinding[]) {
  const eligible = findings.filter((finding) => finding.severity !== "low");
  const findingCounts = {
    high: eligible.filter((finding) => finding.severity === "high").length,
    medium: eligible.filter((finding) => finding.severity === "medium").length,
  };
  // 先按质量分取前五，再在展示中把高危组放在中危组前面。
  const visible = eligible.sort((a, b) => b.score - a.score || stableOrder(a, b)).slice(0, 5)
    .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity] || b.score - a.score || stableOrder(a, b));
  return { findings: visible, foldedCount: Math.max(0, eligible.length - visible.length), findingCounts };
}

export function deriveReviewConclusion(status: ReviewStatus, visibleFindings: readonly ReviewFinding[]): ReviewConclusion {
  const findings = status === "completed" ? visibleFindings.filter((finding) => finding.severity !== "low") : [];
  const findingCounts = {
    high: findings.filter((finding) => finding.severity === "high").length,
    medium: findings.filter((finding) => finding.severity === "medium").length,
  };
  return {
    status: status !== "completed" ? status : findingCounts.high > 0 ? "requires_changes"
      : findingCounts.medium > 0 ? "manual_judgment" : "no_major_findings",
    findingCounts,
    disposedCount: findings.filter((finding) => finding.status === "Resolved" || finding.status === "Dismissed").length,
  };
}
