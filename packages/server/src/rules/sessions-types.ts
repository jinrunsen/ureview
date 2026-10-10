import type { GeneratedRuleDraft, ManagedRuleInput } from "./managed-types.js";

export interface RuleSessionTurn {
  id: string;
  message: string;
  reply?: string;
  draft?: GeneratedRuleDraft;
  status: "running" | "completed" | "failed";
  error?: string;
  errorCode?: string;
  createdAt: string;
}

export interface RuleSession {
  id: string;
  title: string;
  version: number;
  ruleId: string | null;
  ruleVersion: number | null;
  workingCopy: ManagedRuleInput | null;
  turns: RuleSessionTurn[];
  status: "idle" | "running";
  createdAt: string;
  updatedAt: string;
}

export interface RuleConversationGenerator {
  continue(input: { sessionId: string; ruleSessionId?: string; message: string; draft?: GeneratedRuleDraft; checkpoint?: unknown }): Promise<{
    draft: GeneratedRuleDraft; reply: string; checkpoint: unknown;
  }>;
}
