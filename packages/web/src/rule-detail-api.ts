import { isRecord, request } from "./api";
import { isManagedRule, type ManagedRule, type RuleWaiver } from "./managed-rules-api";
import { isRuleLayer, isStringList, type RuleLayer } from "./rule-metadata";
import { dispositionReasonLabels, type DispositionReason, type FindingDisposition, type FindingStatus, type ReviewRule } from "./review-api";
import type { CatalogRule } from "./rules-api";

export interface RuleExecution {
  reviewId: string; repositoryId: string; repositoryName: string; iid: number; title: string; round: number;
  completedAt: string | null; pullRequestUrl: string | null; findingId: string; findingTitle: string;
  severity: "high" | "medium"; status: FindingStatus; disposition: FindingDisposition; ruleVersion: number | string;
}
export interface RuleDetail {
  rule: {
    id: string; name: string; body: string; goodExample: string; badExample: string; layer: RuleLayer; languages: string[]; overrides: string[]; judgement: boolean;
    overriddenBy: Array<{ id: string; name: string; repositoryId?: string }>;
    scope: "global" | "repositories" | "repository"; repositories: Array<{ repositoryId: string; paths: string[] }>; waivers: RuleWaiver[];
    source: { kind: "managed" } | { kind: "git"; file: CatalogRule["file"] } | { kind: "library"; setId: string; entryId: string; setName: string; sourceFilename: string; libraryVersion: string };
    version: number | string; status: "active" | "draft" | "disabled" | "lazy" | "snapshot"; managedRule?: ManagedRule;
  };
  records: RuleExecution[];
  summary: { hits: number; adopted: number; dismissed: number; ignored: number; dismissalReasons: Partial<Record<DispositionReason, number>> };
}
const fields = (value: Record<string, unknown>, names: string[]) => names.every((name) => typeof value[name] === "string");
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableString = (value: unknown) => value === null || typeof value === "string";
function isRecordEntry(value: unknown): value is RuleExecution {
  if (!isRecord(value) || !fields(value, ["reviewId", "repositoryId", "repositoryName", "title", "findingId", "findingTitle"]) || !count(value.iid) || !count(value.round) || !nullableString(value.completedAt) || !nullableString(value.pullRequestUrl) || !["high", "medium"].includes(String(value.severity)) || !["Pending", "Resolved", "Dismissed", "Ignored", "Outdated"].includes(String(value.status)) || !(typeof value.ruleVersion === "string" || count(value.ruleVersion))) return false;
  const disposition = value.disposition;
  return isRecord(disposition) && count(disposition.version) && nullableString(disposition.updatedAt) && nullableString(disposition.explanation) && (disposition.reasonCategory === null || Object.hasOwn(dispositionReasonLabels, String(disposition.reasonCategory))) && (disposition.actor === null || isRecord(disposition.actor) && fields(disposition.actor, ["id", "name"]));
}
function isRuleDetail(value: unknown): value is RuleDetail {
  if (!isRecord(value) || !isRecord(value.rule) || !isRecord(value.summary) || !Array.isArray(value.records) || !value.records.every(isRecordEntry)) return false;
  const rule = value.rule; const source = rule.source;
  return fields(rule, ["id", "name", "body", "goodExample", "badExample"]) && isRuleLayer(rule.layer) && isStringList(rule.languages) && isStringList(rule.overrides) && typeof rule.judgement === "boolean" &&
    ["global", "repositories", "repository"].includes(String(rule.scope)) && ["active", "draft", "disabled", "lazy", "snapshot"].includes(String(rule.status)) && (typeof rule.version === "string" || count(rule.version)) &&
    Array.isArray(rule.repositories) && rule.repositories.every((entry) => isRecord(entry) && typeof entry.repositoryId === "string" && isStringList(entry.paths)) &&
    Array.isArray(rule.overriddenBy) && rule.overriddenBy.every((entry) => isRecord(entry) && fields(entry, ["id", "name"]) && (entry.repositoryId === undefined || typeof entry.repositoryId === "string")) &&
    Array.isArray(rule.waivers) && rule.waivers.every((entry) => isRecord(entry) && fields(entry, ["repositoryId", "reason", "createdBy", "createdAt"]) && [entry.revokedAt, entry.revokedBy].every((field) => field === undefined || nullableString(field))) &&
    (rule.managedRule === undefined || isManagedRule(rule.managedRule)) && isRecord(source) && (source.kind === "managed" || source.kind === "library" && fields(source, ["setId", "entryId", "setName", "sourceFilename", "libraryVersion"]) || source.kind === "git" && isRecord(source.file) && fields(source.file, ["repositoryId", "repositoryName", "path", "commitSha", "url"])) &&
    [value.summary.hits, value.summary.adopted, value.summary.dismissed, value.summary.ignored].every(count) && isRecord(value.summary.dismissalReasons) && Object.entries(value.summary.dismissalReasons).every(([reason, total]) => Object.hasOwn(dispositionReasonLabels, reason) && count(total));
}
export function getRuleDetail(ruleId: string, repositoryId?: string, signal?: AbortSignal) {
  return request(`/api/rules/${encodeURIComponent(ruleId)}/detail${repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : ""}`, isRuleDetail, { signal });
}
export function ruleDetailUrl(ruleId: string, repositoryId?: string) {
  const query = new URLSearchParams({ rules: "1", rule: ruleId }); if (repositoryId) query.set("ruleRepository", repositoryId);
  return `/?${query}`;
}
export function isManagedRuleId(ruleId: string): boolean {
  return /^managed:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ruleId);
}
export function reviewRuleDetailUrl(rule: ReviewRule): string | null {
  if (rule.file.kind === "database" && !isManagedRuleId(rule.id)) return null;
  return ruleDetailUrl(rule.id, rule.file.kind === "database" ? undefined : rule.file.repositoryId);
}
