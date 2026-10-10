import { ruleLayers, ruleLanguages, type RuleLayer } from "./metadata.js";
import type { LibrarySource } from "./library-types.js";

export const ruleCategories = ["security", "correctness", "quality", "reliability", "performance", "testability", "compliance", "accessibility", "observability", "architecture"] as const;
export const ruleSeverities = ["error", "warning", "recommendation"] as const;
export type RuleCategory = typeof ruleCategories[number];
export type RuleSeverity = typeof ruleSeverities[number];
export interface GeneratedRuleDraft {
  name: string;
  body: string;
  goodExample: string;
  badExample: string;
  category: RuleCategory;
  severity: RuleSeverity;
  judgement: boolean;
  layer: RuleLayer;
  languages: string[];
}
export interface ManagedRuleInput extends GeneratedRuleDraft {
  overrides: string[];
  scope: "global" | "repositories";
  repositories: Array<{ repositoryId: string; paths: string[] }>;
  status: "draft" | "active";
}
export interface RuleWaiver {
  id: string;
  repositoryId: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}
export interface ManagedRule extends ManagedRuleInput {
  librarySource?: LibrarySource;
  waivers: RuleWaiver[];
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}
export type RuleDraftGenerator = (intent: string) => Promise<GeneratedRuleDraft>;
export class ManagedRuleError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

export function getManagedRuleId(ruleId: string): string | null {
  return /^managed:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(ruleId)?.[1] ?? null;
}

export function validateGeneratedRuleDraft(value: unknown): GeneratedRuleDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ManagedRuleError(400, "invalid_input", "规范草稿字段不完整");
  const draft = value as Record<string, unknown>;
  const keys = ["name", "body", "goodExample", "badExample", "category", "severity"];
  if (Object.keys(draft).some((key) => ![...keys, "layer", "languages", "judgement"].includes(key)) || keys.some((key) => typeof draft[key] !== "string")) {
    throw new ManagedRuleError(400, "invalid_input", "规范草稿字段不完整");
  }
  const name = String(draft.name).trim(), body = String(draft.body).trim();
  if (!name || name.length > 160 || !body || body.length > 12000 || String(draft.goodExample).length > 12000 || String(draft.badExample).length > 12000
    || !ruleCategories.includes(draft.category as RuleCategory) || !ruleSeverities.includes(draft.severity as RuleSeverity)) {
    throw new ManagedRuleError(400, "invalid_input", "请检查规范名称、正文、示例、类别和严重程度");
  }
  const metadata = validateRuleMetadata(draft);
  return { ...metadata, name, body, goodExample: String(draft.goodExample), badExample: String(draft.badExample), category: draft.category as RuleCategory, severity: draft.severity as RuleSeverity };
}

export function validateRuleMetadata(value: Record<string, unknown>): { layer: RuleLayer; languages: string[]; judgement: boolean } {
  const layer = value.layer === undefined ? "team" : value.layer, languages = value.languages === undefined ? [] : value.languages;
  if (!ruleLayers.includes(layer as RuleLayer) || !Array.isArray(languages) || languages.length > ruleLanguages.length
    || languages.some((language: unknown) => typeof language !== "string" || !ruleLanguages.includes(language as typeof ruleLanguages[number]))
    || new Set(languages).size !== languages.length) {
    throw new ManagedRuleError(400, "invalid_input", "请选择有效的规范层级和适用语言");
  }
  if (value.judgement !== undefined && typeof value.judgement !== "boolean") {
    throw new ManagedRuleError(400, "invalid_input", "判断题属性必须为是或否");
  }
  return { layer: layer as RuleLayer, languages: languages as string[], judgement: value.judgement ?? false };
}

export function validateRuleOverrides(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100 || value.some((id: unknown) => typeof id !== "string" || id.length > 1024
    || !/^(managed:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|repository:[^\s]+)$/.test(id))
    || new Set(value).size !== value.length) throw new ManagedRuleError(400, "invalid_input", "请选择有效且不重复的覆盖目标");
  return value as string[];
}
