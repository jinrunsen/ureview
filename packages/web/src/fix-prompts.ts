import type { ReviewFinding } from "./review-api";

export function repairMarkdown(title: string, findings: ReviewFinding[]): string {
  const ordered = findings.filter((finding) => finding.status !== "Dismissed").sort((left, right) =>
    left.location.path.localeCompare(right.location.path, "en") || left.location.startLine - right.location.startLine || left.location.endLine - right.location.endLine);
  return [`# ${title}`, "请逐条核对以下评审发现，结合现有代码完成修改并验证。", ...ordered.map((finding) => [
    `## ${finding.title}`, `位置：${finding.location.path}:${finding.location.startLine}–${finding.location.endLine}`,
    finding.description, "### 修复提示词", finding.fixPrompt,
  ].join("\n\n"))].join("\n\n");
}
