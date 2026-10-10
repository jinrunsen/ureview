import { isRecord, request } from "./api";

export interface InboxReview {
  id: string; title: string; repositoryName: string; iid: number;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  conclusion: { status: "queued" | "running" | "failed" | "requires_changes" | "manual_judgment" | "no_major_findings"; findingCounts: { high: number; medium: number }; disposedCount: number };
  readingSummary: string | null; pendingCount: number;
}
export interface InboxNotification {
  id: string; reviewId: string; findingId: string; reviewTitle: string; repositoryName: string;
  findingTitle: string; body: string; kind: "mention" | "reply"; createdAt: string;
  readAt: string | null; authorName: string; review: InboxReview;
}
export interface Inbox { linked: boolean; toReview: InboxReview[]; submitted: InboxReview[]; notifications: InboxNotification[] }
function isReview(value: unknown): value is InboxReview {
  if (!isRecord(value) || !["id", "title", "repositoryName", "createdAt"].every((key) => typeof value[key] === "string") || typeof value.iid !== "number"
    || !["queued", "running", "completed", "failed"].includes(String(value.status)) || typeof value.pendingCount !== "number"
    || !(value.readingSummary === null || typeof value.readingSummary === "string") || !isRecord(value.conclusion)) return false;
  const conclusion = value.conclusion;
  return ["queued", "running", "failed", "requires_changes", "manual_judgment", "no_major_findings"].includes(String(conclusion.status))
    && typeof conclusion.disposedCount === "number" && isRecord(conclusion.findingCounts)
    && typeof conclusion.findingCounts.high === "number" && typeof conclusion.findingCounts.medium === "number";
}
function isNotification(value: unknown): value is InboxNotification {
  return isRecord(value) && ["id", "reviewId", "findingId", "reviewTitle", "repositoryName", "findingTitle", "body", "createdAt", "authorName"].every((key) => typeof value[key] === "string")
    && (value.kind === "mention" || value.kind === "reply") && (value.readAt === null || typeof value.readAt === "string") && isReview(value.review);
}
export const getInbox = () => request("/api/inbox", (value): value is Inbox => isRecord(value) && typeof value.linked === "boolean"
  && Array.isArray(value.toReview) && value.toReview.every(isReview) && Array.isArray(value.submitted) && value.submitted.every(isReview)
  && Array.isArray(value.notifications) && value.notifications.every(isNotification));
export const readNotification = (id: string) => request(`/api/notifications/${encodeURIComponent(id)}/read`, isRecord, { method: "POST", body: "{}" });
