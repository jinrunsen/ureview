import type { InstanceHealth, ModelFailureCode, OnboardingChecklist } from "../../server/src/instance-health/types";
import { isRecord, request } from "./api";

export type { InstanceHealth, OnboardingChecklist };
export const modelFailureLabels: Record<ModelFailureCode, string> = {
  invalid_config: "配置不完整", authentication_failed: "认证失败", model_not_found: "模型不可用",
  rate_limited: "请求频率受限", timeout: "连接超时", security_plugin_required: "需要安全插件",
  protocol_error: "响应格式错误", connection_failed: "连接失败",
};
const stepIds = ["models", "repository", "webhook", "rules", "review"];
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nonnegative = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every((key) => typeof value[key] === "string");
const phase = (value: unknown) => value === "generator" || value === "grader";

function isChecklist(value: unknown): value is OnboardingChecklist {
  return isRecord(value) && typeof value.completed === "boolean" && typeof value.canManageModels === "boolean"
    && (value.repositoryId === null || typeof value.repositoryId === "string")
    && Array.isArray(value.steps) && value.steps.length === stepIds.length
    && value.steps.every((step: unknown, index) => isRecord(step) && step.id === stepIds[index] && typeof step.completed === "boolean")
    && value.completed === value.steps.every((step: { completed: boolean }) => step.completed);
}

function isModel(value: unknown) {
  return isRecord(value) && phase(value.phase) && typeof value.configured === "boolean" && typeof value.model === "string"
    && ["database", "environment", "none"].includes(String(value.source)) && nullableDate(value.lastSuccessAt)
    && (value.lastFailure === null || isRecord(value.lastFailure) && date(value.lastFailure.at)
      && typeof value.lastFailure.code === "string" && Object.hasOwn(modelFailureLabels, value.lastFailure.code));
}

function isHealth(value: unknown): value is InstanceHealth {
  if (!isRecord(value) || !isRecord(value.period) || !date(value.period.from) || !date(value.period.to)
    || !Array.isArray(value.models) || value.models.length !== 2 || !value.models.every(isModel)
    || new Set(value.models.map((model: { phase: string }) => model.phase)).size !== 2
    || !isRecord(value.queue) || !count(value.queue.queued) || !count(value.queue.running) || !nullableDate(value.queue.oldestQueuedAt)
    || !(value.queue.oldestWaitSeconds === null || nonnegative(value.queue.oldestWaitSeconds))
    || !isRecord(value.versions) || !strings(value.versions, ["ureview", "dsh"])
    || !(value.versions.migration === null || typeof value.versions.migration === "string")) return false;
  return Array.isArray(value.failures) && value.failures.every((group: unknown) => isRecord(group) && typeof group.code === "string" && count(group.count)
    && Array.isArray(group.reviews) && group.reviews.every((review: unknown) => isRecord(review)
      && strings(review, ["id", "title", "repositoryName", "teamId", "teamName"]) && count(review.iid) && count(review.round)
      && date(review.completedAt) && typeof review.canOpen === "boolean"))
    && Array.isArray(value.modelMetrics) && value.modelMetrics.every((metric: unknown) => isRecord(metric) && phase(metric.phase)
      && strings(metric, ["provider", "model"]) && [metric.total, metric.completed, metric.failed].every(count)
      && nonnegative(metric.completionRate) && Number(metric.completionRate) <= 1 && nonnegative(metric.averageRejectedSubmissions));
}

export async function getOnboarding(signal?: AbortSignal) {
  const result = await request("/api/onboarding", (value): value is { onboarding: OnboardingChecklist } => isRecord(value) && isChecklist(value.onboarding), { signal });
  return result.onboarding;
}

export async function getInstanceHealth(signal?: AbortSignal) {
  const result = await request("/api/instance-health", (value): value is { health: InstanceHealth } => isRecord(value) && isHealth(value.health), { signal });
  return result.health;
}
