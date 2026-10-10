import { isRecord, request } from "./api";

export const ruleLayerLabels = { principle: "原则层", general: "通用层", language: "语言层", team: "团队层" } as const;
export type RuleLayer = keyof typeof ruleLayerLabels;
export interface RuleMetadata { layers: RuleLayer[]; languages: Array<{ id: string; label: string }> }
export const isRuleLayer = (value: unknown): value is RuleLayer => typeof value === "string" && Object.hasOwn(ruleLayerLabels, value);
export const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
export function getRuleMetadata(signal?: AbortSignal) {
  return request("/api/rule-metadata", (value): value is RuleMetadata => isRecord(value) && Array.isArray(value.layers) && value.layers.every(isRuleLayer) &&
    Array.isArray(value.languages) && value.languages.every((language) => isRecord(language) && typeof language.id === "string" && typeof language.label === "string"), { signal });
}
