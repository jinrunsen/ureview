import { isRecord, request } from "./api";

export const overviewDismissalLabels = {
  false_positive: "误报", rule_not_applicable: "规范不适用", rule_incorrect: "规范有误", not_worth_fixing: "不值得修改", other: "其他",
};
export interface TeamOverview {
  period: { from: string; to: string };
  totals: { repositories: number; pullRequests: number; completed: number; queued: number; running: number };
  reviewRounds: number;
  findings: { high: number; medium: number; resolved: number; dismissed: number };
  adoptionRate: number | null;
  dismissalReasons: Array<{ category: keyof typeof overviewDismissalLabels; count: number }>;
  mostDismissedRules: Array<{ id: string; name: string; repositoryId: string | null; repositoryName: string | null; count: number }>;
}

const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableString = (value: unknown) => value === null || typeof value === "string";
const counts = (value: unknown, keys: string[]) => isRecord(value) && keys.every((key) => count(value[key]));
function isOverview(value: unknown): value is TeamOverview {
  if (!isRecord(value) || !isRecord(value.period) || !date(value.period.from) || !date(value.period.to) ||
    !counts(value.totals, ["repositories", "pullRequests", "completed", "queued", "running"]) ||
    !count(value.reviewRounds) || !counts(value.findings, ["high", "medium", "resolved", "dismissed"]) ||
    !(value.adoptionRate === null || typeof value.adoptionRate === "number" && Number.isFinite(value.adoptionRate) && value.adoptionRate >= 0 && value.adoptionRate <= 1)) return false;
  return Array.isArray(value.dismissalReasons) && value.dismissalReasons.length === 5 &&
    new Set(value.dismissalReasons.map((item: unknown) => isRecord(item) ? item.category : undefined)).size === 5 &&
    value.dismissalReasons.every((item: unknown) => isRecord(item) && typeof item.category === "string" && Object.hasOwn(overviewDismissalLabels, item.category) && count(item.count)) &&
    Array.isArray(value.mostDismissedRules) && value.mostDismissedRules.length <= 5 &&
    value.mostDismissedRules.every((item: unknown) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string" &&
      nullableString(item.repositoryId) && nullableString(item.repositoryName) && count(item.count));
}

export function getTeamOverview(signal?: AbortSignal) {
  return request("/api/team-overview", isOverview, signal ? { signal } : undefined);
}
