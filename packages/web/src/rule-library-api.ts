import { isRecord, request } from "./api";
import { isManagedRule, ruleCategoryLabels, ruleSeverityLabels, type ManagedRule, type RuleCategory, type RuleSeverity } from "./managed-rules-api";
import { isRuleLayer, isStringList, type RuleLayer } from "./rule-metadata";

export interface LibraryEntry {
  id: string; title: string; originalName: string; summary: string; body: string; check: string; why: string; fix: string;
  goodExample: string; badExample: string; exampleLanguage: string;
  category: RuleCategory; severity: RuleSeverity; judgement: boolean; source: { sourceId: string; reference: string };
  appliedRuleId: string | null; appliedVersion: string | null; hasUpdate: boolean;
}
export interface LibrarySet {
  sourceType?: "builtin" | "imported"; sourceFilename?: string; publishedBy?: string; publishedAt?: string;
  id: string; name: string; layer: RuleLayer; languages: string[]; libraryVersion: string;
  sources: Array<{ id: string; title: string; author: string; url: string; license: string; licenseUrl?: string }>;
  inclusionReasons: Array<{ kind: string; explanation: string }>;
  license: { tier: string; attribution: string; notice: string }; entryCount: number; appliedCount: number;
}
const fields = (value: Record<string, unknown>, names: string[]) => names.every((name) => typeof value[name] === "string");
function isEntry(value: unknown): value is LibraryEntry {
  return isRecord(value) && fields(value, ["id", "title", "originalName", "summary", "body", "check", "why", "fix", "goodExample", "badExample", "exampleLanguage"]) && Object.hasOwn(ruleCategoryLabels, String(value.category)) && Object.hasOwn(ruleSeverityLabels, String(value.severity)) &&
    typeof value.judgement === "boolean" && isRecord(value.source) && fields(value.source, ["sourceId", "reference"]) &&
    [value.appliedRuleId, value.appliedVersion].every((entry) => entry === null || typeof entry === "string") && typeof value.hasUpdate === "boolean";
}
function isSet(value: unknown): value is LibrarySet {
  return isRecord(value) && fields(value, ["id", "name", "libraryVersion"]) && isRuleLayer(value.layer) && isStringList(value.languages) &&
    Array.isArray(value.sources) && value.sources.every((entry) => isRecord(entry) && fields(entry, ["id", "title", "author", "url", "license"])) &&
    Array.isArray(value.inclusionReasons) && value.inclusionReasons.every((entry) => isRecord(entry) && fields(entry, ["kind", "explanation"])) &&
    isRecord(value.license) && fields(value.license, ["tier", "attribution", "notice"]) && Number.isSafeInteger(value.entryCount) && Number.isSafeInteger(value.appliedCount);
}
export function getRuleLibrary(layer?: RuleLayer, language?: string, signal?: AbortSignal) {
  const query = new URLSearchParams(); if (layer) query.set("layer", layer); if (language) query.set("language", language);
  return request(`/api/rule-library${query.size ? `?${query}` : ""}`, (value): value is { sets: LibrarySet[] } => isRecord(value) && Array.isArray(value.sets) && value.sets.every(isSet), { signal });
}
export function applyRuleLibrary(setId: string, entryIds?: string[]) {
  return request(`/api/rule-library/${encodeURIComponent(setId)}/apply`, (value): value is { rules: ManagedRule[]; created: number } =>
    isRecord(value) && Array.isArray(value.rules) && value.rules.every(isManagedRule) && Number.isSafeInteger(value.created) && Number(value.created) >= 0,
  { method: "POST", body: JSON.stringify(entryIds ? { entryIds } : {}) });
}

export function deleteImportedLibrarySet(id: string) {
  return request(`/api/rule-library/${encodeURIComponent(id)}`, (value): value is { id: string } => isRecord(value) && typeof value.id === "string", { method: "DELETE" });
}

export function getRuleLibraryEntries(setId: string, signal?: AbortSignal) {
  return request(`/api/rule-library/${encodeURIComponent(setId)}/entries`, (value): value is { entries: LibraryEntry[] } =>
    isRecord(value) && Array.isArray(value.entries) && value.entries.every(isEntry), { signal });
}
