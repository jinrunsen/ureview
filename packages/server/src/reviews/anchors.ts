import { createHash } from "node:crypto";
import type { CodeAnchor, FindingCandidate } from "./types.js";

export function createCodeFingerprint(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

/** 展示的高危与中危锚到新侧代码行；低危不展示，不生成锚。 */
export function createCodeAnchor(finding: Pick<FindingCandidate, "severity" | "location">, code: string): CodeAnchor | null {
  if (finding.severity === "low") return null;
  return { ...finding.location, side: "new", fingerprint: createCodeFingerprint(code) };
}
