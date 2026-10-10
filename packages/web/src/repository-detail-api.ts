import { isRecord, isRepository, request, type RepositorySummary } from "./api";

export interface RepositoryEvent {
  id: string; receivedAt: string; eventType: string; action: string | null; iid: number | null;
  result: "queued" | "duplicate" | "ignored" | "failed"; reason: string | null;
  reviewId: string | null; reviewRound: number | null;
}
export interface RepositoryEvents {
  webhook: { url: string; tokenConfigured: boolean; lastAuthenticationFailureAt: string | null };
  events: RepositoryEvent[];
}
export interface WebhookCheck {
  status: "configured" | "missing" | "merge_request_events_disabled" | "unreadable" | "unavailable";
  message: string; checkedAt: string;
}
export interface RepositoryDeletionPreview {
  repositoryId: string;
  pathWithNamespace: string;
  counts: {
    reviews: number;
    findings: number;
    discussionComments: number;
    agentSessions: number;
    webhookEvents: number;
    repositoryRules: number;
    historicalCandidates: number;
    managedRules: number;
  };
  runningReviews: number;
}
const nullableText = (value: unknown) => value === null || typeof value === "string";
const nullableNumber = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) > 0);
const repositoryResponse = (value: unknown): value is { repository: RepositorySummary } => isRecord(value) && isRepository(value.repository);
function isEvents(value: unknown): value is RepositoryEvents {
  return isRecord(value) && isRecord(value.webhook) && typeof value.webhook.url === "string" && typeof value.webhook.tokenConfigured === "boolean"
    && nullableText(value.webhook.lastAuthenticationFailureAt) && Array.isArray(value.events) && value.events.every((event) =>
      isRecord(event) && [event.id, event.receivedAt, event.eventType].every((item) => typeof item === "string")
      && nullableText(event.action) && nullableText(event.reason) && nullableText(event.reviewId) && nullableNumber(event.iid) && nullableNumber(event.reviewRound)
      && ["queued", "duplicate", "ignored", "failed"].includes(String(event.result)));
}
const basePath = (repositoryId: string) => `/api/repositories/${encodeURIComponent(repositoryId)}`;
export async function getRepository(repositoryId: string, signal?: AbortSignal) {
  return (await request(basePath(repositoryId), repositoryResponse, { signal })).repository;
}
export async function saveAutomaticReview(repositoryId: string, enabled: boolean, version: number, signal?: AbortSignal) {
  return (await request(`${basePath(repositoryId)}/automatic-review`, repositoryResponse, { method: "PUT", body: JSON.stringify({ enabled, version }), signal })).repository;
}
export const getRepositoryEvents = (repositoryId: string, signal?: AbortSignal) => request(`${basePath(repositoryId)}/events`, isEvents, { signal });
export async function checkRepositoryWebhook(repositoryId: string, signal?: AbortSignal) {
  return (await request(`${basePath(repositoryId)}/webhook-check`, (value): value is { check: WebhookCheck } => isRecord(value) && isRecord(value.check)
    && ["configured", "missing", "merge_request_events_disabled", "unreadable", "unavailable"].includes(String(value.check.status))
    && typeof value.check.message === "string" && typeof value.check.checkedAt === "string", { method: "POST", signal })).check;
}
function isDeletionPreview(value: unknown): value is RepositoryDeletionPreview {
  if (!isRecord(value) || !isRecord(value.counts)) return false;
  const counts = value.counts;
  return typeof value.repositoryId === "string" && typeof value.pathWithNamespace === "string"
    && [value.runningReviews, ...["reviews", "findings", "discussionComments", "agentSessions", "webhookEvents", "repositoryRules", "historicalCandidates", "managedRules"].map((key) => counts[key])]
      .every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}
export async function getRepositoryDeletionPreview(repositoryId: string, signal?: AbortSignal) {
  return (await request(`${basePath(repositoryId)}/deletion-preview`, (value): value is { preview: RepositoryDeletionPreview } => isRecord(value) && isDeletionPreview(value.preview), { signal })).preview;
}
export async function deleteRepository(repositoryId: string, pathWithNamespace: string) {
  return request(basePath(repositoryId), (value): value is { deleted: true; preview: RepositoryDeletionPreview } => isRecord(value) && value.deleted === true && isDeletionPreview(value.preview), {
    method: "DELETE", body: JSON.stringify({ pathWithNamespace }),
  });
}
