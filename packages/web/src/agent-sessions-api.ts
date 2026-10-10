import { isRecord, request } from "./api";

export type AgentSessionKind = "review_reading" | "review_generator" | "review_grader" | "rule_generation";
export type AgentSessionStatus = "running" | "completed" | "failed";
export interface AgentSessionSummary {
  id: string; title: string; kind: AgentSessionKind; status: AgentSessionStatus; model: string; provider: string;
  createdAt: string; updatedAt: string; completedAt: string | null;
  reviewId: string | null; ruleSessionId: string | null; repositoryName: string | null;
  prNumber: number | null; headSha: string | null; reviewRound: number | null; lastSeq: number; errorCode: string | null;
}
export interface AgentSessionList { items: AgentSessionSummary[]; total: number; page: number; pageSize: number }
export interface AgentSessionFilters {
  reviewId?: string; ruleSessionId?: string; kind?: AgentSessionKind; status?: AgentSessionStatus; search?: string; page?: number; pageSize?: number;
}
export const agentSessionKindLabels: Record<AgentSessionKind, string> = { review_reading: "生成解读", review_generator: "生成评审", review_grader: "评分核验", rule_generation: "规范生成" };
export const agentSessionStatusLabels: Record<AgentSessionStatus, string> = { running: "进行中", completed: "已完成", failed: "失败" };
function isSession(value: unknown): value is AgentSessionSummary {
  return isRecord(value) && ["id", "title", "model", "provider", "createdAt", "updatedAt"].every((key) => typeof value[key] === "string") &&
    typeof value.kind === "string" && Object.hasOwn(agentSessionKindLabels, value.kind) &&
    typeof value.status === "string" && Object.hasOwn(agentSessionStatusLabels, value.status) &&
    ["completedAt", "reviewId", "ruleSessionId", "repositoryName", "headSha", "errorCode"].every((key) => value[key] === null || typeof value[key] === "string") &&
    ["prNumber", "reviewRound"].every((key) => value[key] === null || (Number.isSafeInteger(value[key]) && Number(value[key]) > 0)) &&
    Number.isSafeInteger(value.lastSeq) && Number(value.lastSeq) >= -1;
}
export function listAgentSessions(filters: AgentSessionFilters, signal?: AbortSignal) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined && value !== "") params.set(key, String(value));
  return request(`/api/agent-sessions?${params}`, (value): value is AgentSessionList => isRecord(value) &&
    Array.isArray(value.items) && value.items.every(isSession) && Number.isSafeInteger(value.total) && Number(value.total) >= 0 &&
    Number.isSafeInteger(value.page) && Number(value.page) > 0 && Number.isSafeInteger(value.pageSize) && Number(value.pageSize) > 0, { signal });
}
export function getAgentSession(id: string, signal?: AbortSignal) {
  return request(`/api/agent-sessions/${encodeURIComponent(id)}`, (value): value is { session: AgentSessionSummary } => isRecord(value) && isSession(value.session), { signal });
}
export function agentSessionSource(session: AgentSessionSummary): string {
  return session.reviewId ? `/?review=${encodeURIComponent(session.reviewId)}` : `/?rules=1&session=${encodeURIComponent(session.ruleSessionId ?? "")}`;
}
export function preferredAgentSession(sessions: AgentSessionSummary[]): AgentSessionSummary | undefined {
  return sessions.find((session) => session.status === "failed") ?? sessions.find((session) => session.kind === "review_generator") ?? sessions[0];
}

export function agentSessionPageUrl(id: string, view: "chat" | "trajectory" = "chat"): string {
  return `/?${new URLSearchParams({ "session-viewer": id, view })}`;
}
