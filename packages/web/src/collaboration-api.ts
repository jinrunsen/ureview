import { isRecord, request } from "./api";

export interface DiscussionComment { id: string; authorId: string; authorName: string; parentId: string | null; body: string; mentions: string[]; createdAt: string }
export interface DiscussionThread { comments: DiscussionComment[]; unreadIds: string[] }
export interface TeamMember { id: string; name: string }
export interface Participation { currentUserId: string; participants: Array<{ userId: string; name: string; viewedAt: string; completedAt: string | null }> }
export interface PlatformThread { id: string; resolved: boolean; notes: Array<{ id: string; author: string; body: string; createdAt: string; url: string }> }
export interface Unread { count: number; threads: Array<{ reviewId: string; findingId: string; count: number }> }
export interface NotificationConfiguration { endpoint: string | null; deliveries: Record<string, number> }
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const nullableString = (value: unknown) => value === null || typeof value === "string";
function isComment(value: unknown): value is DiscussionComment {
  return isRecord(value) && ["id", "authorId", "authorName", "body", "createdAt"].every((key) => typeof value[key] === "string") && nullableString(value.parentId) && strings(value.mentions);
}
function isParticipation(value: unknown): value is Participation {
  return isRecord(value) && typeof value.currentUserId === "string" && Array.isArray(value.participants)
    && value.participants.every((item: unknown) => isRecord(item) && ["userId", "name", "viewedAt"].every((key) => typeof item[key] === "string") && nullableString(item.completedAt));
}
function isSettings(value: unknown): value is NotificationConfiguration {
  return isRecord(value) && nullableString(value.endpoint) && isRecord(value.deliveries) && Object.values(value.deliveries).every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}
function threadPath(reviewId: string, findingId: string) { return `/api/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/comments`; }
export function getComments(reviewId: string, findingId: string) {
  return request<DiscussionThread>(threadPath(reviewId, findingId), (body): body is DiscussionThread => isRecord(body) && Array.isArray(body.comments) && body.comments.every(isComment) && strings(body.unreadIds));
}
export function addComment(reviewId: string, findingId: string, input: { requestId: string; body: string; parentId?: string; mentions: string[] }) {
  return request<{ comment: DiscussionComment; created: boolean }>(threadPath(reviewId, findingId), (body): body is { comment: DiscussionComment; created: boolean } => isRecord(body) && isComment(body.comment) && typeof body.created === "boolean", { method: "POST", body: JSON.stringify(input) });
}
export function readComments(reviewId: string, findingId: string, ids: string[]) {
  return request(`${threadPath(reviewId, findingId)}/read`, (body): body is { read: boolean } => isRecord(body) && body.read === true, { method: "POST", body: JSON.stringify({ ids }) });
}
export function getMembers() {
  return request<{ members: TeamMember[] }>("/api/collaboration/members", (body): body is { members: TeamMember[] } => isRecord(body) && Array.isArray(body.members) && body.members.every((item: unknown) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string"));
}
export function getUnread() {
  return request<Unread>("/api/collaboration/unread", (body): body is Unread => isRecord(body) && Number.isSafeInteger(body.count) && Number(body.count) >= 0 && Array.isArray(body.threads) && body.threads.every((item: unknown) => isRecord(item) && typeof item.reviewId === "string" && typeof item.findingId === "string" && Number.isSafeInteger(item.count) && Number(item.count) >= 0));
}
export function getParticipation(reviewId: string) { return request<Participation>(`/api/reviews/${encodeURIComponent(reviewId)}/participation`, isParticipation); }
export function finishReview(reviewId: string, completed: boolean) { return request<Participation>(`/api/reviews/${encodeURIComponent(reviewId)}/participation`, isParticipation, { method: "PUT", body: JSON.stringify({ completed }) }); }
export function getPlatformDiscussions(reviewId: string) {
  return request<{ discussions: PlatformThread[]; error: string | null }>(`/api/reviews/${encodeURIComponent(reviewId)}/platform-discussions`, (body): body is { discussions: PlatformThread[]; error: string | null } => {
    if (!isRecord(body) || !nullableString(body.error) || !Array.isArray(body.discussions)) return false;
    return body.discussions.every((item: unknown) => isRecord(item) && typeof item.id === "string" && typeof item.resolved === "boolean" && Array.isArray(item.notes) && item.notes.every((note: unknown) => {
      if (!isRecord(note) || !["id", "author", "body", "createdAt", "url"].every((key) => typeof note[key] === "string")) return false;
      try { const url = new URL(String(note.url)); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
    }));
  });
}
export function getNotificationSettings() { return request<NotificationConfiguration>("/api/notification-settings", isSettings); }
export function setNotificationSettings(endpoint: string | null) { return request<NotificationConfiguration>("/api/notification-settings", isSettings, { method: "PUT", body: JSON.stringify({ endpoint }) }); }
