import { isRecord, request } from "./api";
import { isRuleLayer, isStringList, type RuleLayer } from "./rule-metadata";

export const ruleCategoryLabels = {
  security: "安全", correctness: "正确性", quality: "代码质量", reliability: "可靠性", performance: "性能",
  testability: "可测试性", compliance: "合规", accessibility: "无障碍", observability: "可观测性", architecture: "架构",
} as const;
export const ruleSeverityLabels = { error: "错误 · 需修复", warning: "警告 · 建议处理", recommendation: "建议 · 按场景参考" } as const;
export type RuleCategory = keyof typeof ruleCategoryLabels;
export type RuleSeverity = keyof typeof ruleSeverityLabels;
export interface GeneratedRuleDraft {
  name: string; body: string; goodExample: string; badExample: string; category: RuleCategory; severity: RuleSeverity;
  layer: RuleLayer; languages: string[]; judgement: boolean;
}
export interface ManagedRuleInput extends GeneratedRuleDraft {
  overrides: string[];
  scope: "global" | "repositories";
  repositories: Array<{ repositoryId: string; paths: string[] }>;
  status: "draft" | "active";
}
export interface ManagedRule extends ManagedRuleInput {
  id: string; version: number; createdAt: string; updatedAt: string; createdBy: string; updatedBy: string;
  waivers: RuleWaiver[];
  librarySource?: { setId: string; entryId: string; version: string; body: string; judgement?: boolean; exampleLanguage?: string };
}
export interface RuleWaiver { repositoryId: string; reason: string; createdBy: string; createdAt: string; revokedBy?: string | null; revokedAt?: string | null }
export function isDraft(value: unknown): value is GeneratedRuleDraft {
  return isRecord(value) && ["name", "body", "goodExample", "badExample"].every((field) => typeof value[field] === "string") &&
    isRuleLayer(value.layer) && isStringList(value.languages) && typeof value.judgement === "boolean" &&
    typeof value.category === "string" && Object.hasOwn(ruleCategoryLabels, value.category) &&
    typeof value.severity === "string" && Object.hasOwn(ruleSeverityLabels, value.severity);
}
export function isManagedRule(value: unknown): value is ManagedRule {
  return isRecord(value) && isDraft(value) && ["id", "createdAt", "updatedAt", "createdBy", "updatedBy"].every((field) => typeof value[field] === "string") &&
    Number.isSafeInteger(value.version) && Number(value.version) > 0 && ["global", "repositories"].includes(String(value.scope)) &&
    ["draft", "active"].includes(String(value.status)) && Array.isArray(value.repositories) &&
    (value.librarySource === undefined || isRecord(value.librarySource) && [value.librarySource.setId, value.librarySource.entryId, value.librarySource.version, value.librarySource.body].every((field) => typeof field === "string") &&
      (value.librarySource.exampleLanguage === undefined || typeof value.librarySource.exampleLanguage === "string") &&
      (value.librarySource.judgement === undefined || typeof value.librarySource.judgement === "boolean")) &&
    isStringList(value.overrides) && Array.isArray(value.waivers) && value.waivers.every(isWaiver) &&
    value.repositories.every((entry: unknown) => isRecord(entry) && typeof entry.repositoryId === "string" &&
      Array.isArray(entry.paths) && entry.paths.every((path: unknown) => typeof path === "string")) &&
    (value.scope === "global" ? value.repositories.length === 0 : value.repositories.length > 0);
}
function isWaiver(value: unknown): value is RuleWaiver {
  return isRecord(value) && ["repositoryId", "reason", "createdBy", "createdAt"].every((field) => typeof value[field] === "string") &&
    [value.revokedBy, value.revokedAt].every((field) => field === undefined || field === null || typeof field === "string");
}
export function getRuleWaivers(ruleId: string, signal?: AbortSignal) {
  return request(`/api/managed-rules/${encodeURIComponent(ruleId)}/waivers`,
    (value): value is { waivers: RuleWaiver[] } => isRecord(value) && Array.isArray(value.waivers) && value.waivers.every(isWaiver), { signal });
}
export function setRuleWaiver(ruleId: string, repositoryId: string, reason?: string) {
  return request(`/api/managed-rules/${encodeURIComponent(ruleId)}/waivers/${encodeURIComponent(repositoryId)}`,
    (value): value is { rule: ManagedRule } => isRecord(value) && isManagedRule(value.rule),
    reason === undefined ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify({ reason }) });
}
export function getManagedRules(repositoryId?: string, signal?: AbortSignal) {
  return request(`/api/managed-rules${repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : ""}`,
    (value): value is { rules: ManagedRule[] } => isRecord(value) && Array.isArray(value.rules) && value.rules.every(isManagedRule), { signal });
}
export function generateRule(intent: string, signal: AbortSignal) {
  return request("/api/managed-rules/generate", (value): value is { draft: GeneratedRuleDraft } => isRecord(value) && isDraft(value.draft),
    { method: "POST", body: JSON.stringify({ intent }), signal });
}
export function saveManagedRule(input: ManagedRuleInput, existing: { id: string; version: number } | undefined, signal: AbortSignal) {
  return request(existing ? `/api/managed-rules/${encodeURIComponent(existing.id)}` : "/api/managed-rules",
    (value): value is { rule: ManagedRule } => isRecord(value) && isManagedRule(value.rule),
    { method: existing ? "PUT" : "POST", body: JSON.stringify(existing ? { ...input, version: existing.version } : input), signal });
}
export function deleteManagedRule(ruleId: string, version: number) {
  return request(`/api/managed-rules/${encodeURIComponent(ruleId)}`,
    (value): value is { deleted: true } => isRecord(value) && value.deleted === true,
    { method: "DELETE", body: JSON.stringify({ version }) });
}
