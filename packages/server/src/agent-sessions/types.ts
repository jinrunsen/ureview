import type { SessionEvent } from "@deepseek-ai/dsh-session";

export const agentSessionKinds = ["review_reading", "review_generator", "review_grader", "rule_generation"] as const;
export type AgentSessionKind = typeof agentSessionKinds[number];
export type AgentSessionStatus = "running" | "completed" | "failed";

export interface BeginAgentSession {
  id: string;
  dshSessionId: string;
  kind: AgentSessionKind;
  reviewId?: string;
  ruleSessionId?: string;
  model: string;
  provider: string;
}

export interface AgentSessionSummary {
  id: string;
  dshSessionId: string;
  title: string;
  kind: AgentSessionKind;
  status: AgentSessionStatus;
  model: string;
  provider: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  reviewId: string | null;
  ruleSessionId: string | null;
  repositoryName: string | null;
  prNumber: number | null;
  headSha: string | null;
  reviewRound: number | null;
  lastSeq: number;
  errorCode: string | null;
}

export interface AgentSessionListOptions {
  page?: number;
  pageSize?: number;
  kind?: AgentSessionKind;
  status?: AgentSessionStatus;
  reviewId?: string;
  ruleSessionId?: string;
  search?: string;
}
export interface AgentSessionPage {
  items: AgentSessionSummary[];
  total: number;
  page: number;
  pageSize: number;
}
export interface AgentSessionEvents {
  events: SessionEvent[];
  nextAfter: number;
  hasMore: boolean;
  session: AgentSessionSummary;
}

export class AgentSessionError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}
