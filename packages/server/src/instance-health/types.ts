export type ModelPhase = "generator" | "grader";
export type ModelFailureCode = "invalid_config" | "authentication_failed" | "model_not_found" | "rate_limited" | "timeout" | "security_plugin_required" | "protocol_error" | "connection_failed";

export interface OnboardingChecklist {
  completed: boolean;
  canManageModels: boolean;
  repositoryId: string | null;
  steps: Array<{ id: "models" | "repository" | "webhook" | "rules" | "review"; completed: boolean }>;
}

export interface InstanceHealth {
  period: { from: string; to: string };
  models: Array<{
    phase: ModelPhase;
    configured: boolean;
    source: "database" | "environment" | "none";
    model: string;
    lastSuccessAt: string | null;
    lastFailure: { at: string; code: ModelFailureCode } | null;
  }>;
  queue: { queued: number; running: number; oldestQueuedAt: string | null; oldestWaitSeconds: number | null };
  failures: Array<{ code: string; count: number; reviews: Array<{
    id: string; title: string; repositoryName: string; iid: number; round: number; completedAt: string;
    teamId: string; teamName: string; canOpen: boolean;
  }> }>;
  modelMetrics: Array<{
    phase: ModelPhase; provider: string; model: string; total: number; completed: number; failed: number;
    completionRate: number; averageRejectedSubmissions: number;
  }>;
  versions: { ureview: string; dsh: string; migration: string | null };
}
