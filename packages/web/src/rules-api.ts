import { isRecord, request } from "./api";
import { isManagedRule, type ManagedRule } from "./managed-rules-api";
import { isRuleLayer, type RuleLayer } from "./rule-metadata";

export interface CatalogRule {
  id: string; name: string; body: string; scope: "global" | "repository"; inherited: boolean;
  source: { kind: "manual" | "mined"; url?: string };
  file: { repositoryId: string; repositoryName: string; path: string; commitSha: string; url: string };
  paths: string[]; languages: string[]; lazy: boolean; enabled: boolean;
  layer: RuleLayer; overrides: string[]; judgement: boolean;
  counts: { hits: number; adopted: number; dismissed?: number; ignored: number };
}
export interface CatalogManagedRule extends ManagedRule { counts?: CatalogRule["counts"] }
export interface Candidate {
  id: string; key: string; repositoryId: string; body: string; suggestedPath: string; markdown: string; active: boolean; createdAt: string;
  evidence: Array<{ iid: number; pullRequestUrl: string; commentUrl: string; author: string; path: string;
    before: string; after: string; beforeSha: string; afterSha: string; commitUrl: string }>;
}
export interface CatalogLint {
  kind: "lint"; id: string; name: string; description: string; body: string;
  paths: string[]; script: string; args: string[]; checkerRoot: string;
  file: CatalogRule["file"];
}
export interface SyncState {
  repositoryId: string; syncedAt: string | null; syncError: string | null; warnings: string[];
  minedAt: string | null; miningError: string | null;
  miningSummary: { scanned: number; skippedNoAdoption: number } | null;
}
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const fields = (value: Record<string, unknown>, names: string[]) => names.every((name) => typeof value[name] === "string");
const numbers = (value: unknown, names: string[]) => isRecord(value) && names.every((name) => typeof value[name] === "number");
function isCatalogManagedRule(value: unknown): value is CatalogManagedRule {
  return isManagedRule(value) && isRecord(value) && (value.counts === undefined || (isRecord(value.counts)
    && (value.counts.dismissed === undefined || Number.isSafeInteger(value.counts.dismissed) && Number(value.counts.dismissed) >= 0)
    && [value.counts.hits, value.counts.adopted, value.counts.ignored].every((count) => Number.isSafeInteger(count) && Number(count) >= 0)));
}
function isRule(value: unknown): value is CatalogRule {
  return isRecord(value) && fields(value, ["id", "name", "body"]) && ["global", "repository"].includes(String(value.scope)) &&
    isRuleLayer(value.layer) && strings(value.overrides) && typeof value.judgement === "boolean" &&
    typeof value.inherited === "boolean" && typeof value.lazy === "boolean" && typeof value.enabled === "boolean" &&
    strings(value.paths) && strings(value.languages) && isRecord(value.file) && fields(value.file, ["repositoryId", "repositoryName", "path", "commitSha", "url"]) &&
    isRecord(value.source) && ["manual", "mined"].includes(String(value.source.kind)) && numbers(value.counts, ["hits", "adopted", "ignored"]) && isRecord(value.counts) && (value.counts.dismissed === undefined || Number.isSafeInteger(value.counts.dismissed) && Number(value.counts.dismissed) >= 0);
}
function isLint(value: unknown): value is CatalogLint {
  return isRecord(value) && value.kind === "lint" && fields(value, ["id", "name", "description", "body", "script", "checkerRoot"]) &&
    strings(value.paths) && strings(value.args) && isRecord(value.file) &&
    fields(value.file, ["repositoryId", "repositoryName", "path", "commitSha", "url"]);
}
export function isCandidate(value: unknown): value is Candidate {
  return isRecord(value) && fields(value, ["id", "key", "repositoryId", "body", "suggestedPath", "markdown", "createdAt"]) &&
    typeof value.active === "boolean" && Array.isArray(value.evidence) && value.evidence.every((entry) => isRecord(entry) &&
      typeof entry.iid === "number" && fields(entry, ["pullRequestUrl", "commentUrl", "author", "path", "before", "after", "beforeSha", "afterSha", "commitUrl"]));
}
function states(value: unknown): value is SyncState[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry) && typeof entry.repositoryId === "string" && strings(entry.warnings) &&
    ["syncedAt", "syncError", "minedAt", "miningError"].every((key) => entry[key] === null || typeof entry[key] === "string") &&
    (entry.miningSummary === null || numbers(entry.miningSummary, ["scanned", "skippedNoAdoption"])));
}
const query = (repositoryId?: string) => repositoryId ? `?repositoryId=${encodeURIComponent(repositoryId)}` : "";
export const getRules = (repositoryId?: string, signal?: AbortSignal) => request(`/api/rules${query(repositoryId)}`, (value): value is { rules: CatalogRule[]; lints: CatalogLint[]; managedRules: CatalogManagedRule[]; sync: SyncState[] } =>
  isRecord(value) && Array.isArray(value.rules) && value.rules.every(isRule) && Array.isArray(value.lints) && value.lints.every(isLint) &&
  Array.isArray(value.managedRules) && value.managedRules.every(isCatalogManagedRule) && states(value.sync), { signal });
export const getCandidates = (repositoryId?: string, signal?: AbortSignal) => request(`/api/rule-candidates${query(repositoryId)}`, (value): value is { candidates: Candidate[]; sync: SyncState[] } =>
  isRecord(value) && Array.isArray(value.candidates) && value.candidates.every(isCandidate) && states(value.sync), { signal });
export const updateRules = (repositoryId: string, operation: "sync" | "mine") => request(`/api/rules/repositories/${encodeURIComponent(repositoryId)}/${operation}`,
  (value): value is { ok: boolean; added?: number; nextAt?: string } => isRecord(value) && value.ok === true, { method: "POST", body: "{}" });
