import { isRecord, request } from "./api";
import { isManagedRule, isDraft, type GeneratedRuleDraft, type ManagedRule, type ManagedRuleInput } from "./managed-rules-api";
import { isStringList } from "./rule-metadata";

export interface RuleSessionTurn {
  id: string; message: string; reply?: string; draft?: GeneratedRuleDraft; status: "running" | "completed" | "failed"; error?: string; createdAt: string;
}
export interface RuleSession {
  id: string; title: string; version: number; ruleId: string | null; ruleVersion: number | null;
  workingCopy: ManagedRuleInput | null; turns: RuleSessionTurn[]; status: "idle" | "running"; createdAt: string; updatedAt: string;
}
function isWorkingCopy(value: unknown): value is ManagedRuleInput {
  return isRecord(value) && isDraft(value) && ["global", "repositories"].includes(String(value.scope)) && ["draft", "active"].includes(String(value.status)) &&
    isStringList(value.overrides) &&
    Array.isArray(value.repositories) && value.repositories.every((entry: unknown) => isRecord(entry) && typeof entry.repositoryId === "string" &&
      Array.isArray(entry.paths) && entry.paths.every((path: unknown) => typeof path === "string"));
}
function isTurn(value: unknown): value is RuleSessionTurn {
  return isRecord(value) && ["id", "message", "createdAt"].every((field) => typeof value[field] === "string") &&
    ["running", "completed", "failed"].includes(String(value.status)) && (value.reply === undefined || typeof value.reply === "string") &&
    (value.error === undefined || typeof value.error === "string") && (value.draft === undefined || isDraft(value.draft));
}
function isSession(value: unknown): value is RuleSession {
  return isRecord(value) && ["id", "title", "createdAt", "updatedAt"].every((field) => typeof value[field] === "string") &&
    Number.isSafeInteger(value.version) && Number(value.version) > 0 && (value.ruleId === null || typeof value.ruleId === "string") &&
    (value.ruleVersion === null || (Number.isSafeInteger(value.ruleVersion) && Number(value.ruleVersion) > 0)) &&
    (value.workingCopy === null || isWorkingCopy(value.workingCopy)) && Array.isArray(value.turns) && value.turns.every(isTurn) &&
    ["idle", "running"].includes(String(value.status));
}
const sessionResult = (value: unknown): value is { session: RuleSession } => isRecord(value) && isSession(value.session);
const sessionPath = (id: string) => `/api/rule-sessions/${encodeURIComponent(id)}`;
export function listRuleSessions(ruleId?: string, signal?: AbortSignal) {
  return request(`/api/rule-sessions${ruleId ? `?ruleId=${encodeURIComponent(ruleId)}` : ""}`,
    (value): value is { sessions: RuleSession[] } => isRecord(value) && Array.isArray(value.sessions) && value.sessions.every(isSession), { signal });
}
export function createRuleSession(ruleId?: string) {
  return request("/api/rule-sessions", sessionResult, { method: "POST", body: JSON.stringify(ruleId ? { ruleId } : {}) });
}
export function getRuleSession(id: string, signal?: AbortSignal) { return request(sessionPath(id), sessionResult, { signal }); }
export function updateRuleSession(id: string, version: number, workingCopy: ManagedRuleInput) {
  return request(sessionPath(id), sessionResult, { method: "PUT", body: JSON.stringify({ version, workingCopy }) });
}
export function sendRuleSessionTurn(id: string, version: number, message: string, workingCopy?: ManagedRuleInput) {
  return request(`${sessionPath(id)}/turns`, sessionResult, { method: "POST", body: JSON.stringify({ version, message, workingCopy }) });
}
export function saveRuleSession(id: string, version: number, workingCopy: ManagedRuleInput, ruleVersion?: number) {
  return request(`${sessionPath(id)}/save-rule`, (value): value is { session: RuleSession; rule: ManagedRule } => isRecord(value) && isManagedRule(value.rule) && sessionResult(value),
    { method: "POST", body: JSON.stringify({ version, workingCopy, ruleVersion }) });
}
