import { isRecord, request } from "./api";

export type NotificationKind = "wecom" | "feishu" | "dingtalk" | "webhook";
export interface NotificationEndpoint { id: string; name: string; kind: NotificationKind; endpoint: string; secret: string | null; deliveries: Record<string, number> }
export interface EndpointInput { name: string; kind: NotificationKind; endpoint: string; secret?: string | null }
function isEndpoint(value: unknown): value is NotificationEndpoint {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.endpoint === "string"
    && ["wecom", "feishu", "dingtalk", "webhook"].includes(String(value.kind)) && (value.secret === null || typeof value.secret === "string")
    && isRecord(value.deliveries) && Object.values(value.deliveries).every((count) => Number.isSafeInteger(count) && Number(count) >= 0);
}
export const getNotificationEndpoints = () => request<{ endpoints: NotificationEndpoint[] }>("/api/notification-endpoints", (body): body is { endpoints: NotificationEndpoint[] } => isRecord(body) && Array.isArray(body.endpoints) && body.endpoints.every(isEndpoint));
export const createNotificationEndpoint = (input: EndpointInput) => request<NotificationEndpoint>("/api/notification-endpoints", isEndpoint, { method: "POST", body: JSON.stringify(input) });
export const updateNotificationEndpoint = (id: string, input: Partial<Pick<EndpointInput, "name" | "endpoint" | "secret">>) => request<NotificationEndpoint>(`/api/notification-endpoints/${encodeURIComponent(id)}`, isEndpoint, { method: "PATCH", body: JSON.stringify(input) });
export const deleteNotificationEndpoint = (id: string) => request<{ deleted: true }>(`/api/notification-endpoints/${encodeURIComponent(id)}`, (body): body is { deleted: true } => isRecord(body) && body.deleted === true, { method: "DELETE" });
