import { isRecord, request } from "./api";

export type TeamRole = "admin" | "member";
export interface Team { id: string; name: string; role: TeamRole }
export interface Identity { userId: string; username: string; email: string | null; name: string; teamId: string; teamName: string; role: TeamRole; serviceRole?: "user" | "service_admin" }
export interface Session { user: Identity | null; teams: Team[]; setupRequired: boolean; hasPassword?: boolean; sso?: { enabled: boolean; buttonLabel: string; passwordLogin: "all" | "service_admin" } }
export interface Member { id: string; username: string; email: string | null; name: string; role: TeamRole }
const role = (value: unknown): value is TeamRole => value === "admin" || value === "member";
const isTeam = (value: unknown): value is Team => isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && role(value.role);
const isMember = (value: unknown): value is Member => isRecord(value) && ["id", "username", "name"].every((key) => typeof value[key] === "string") && (value.email === null || typeof value.email === "string") && role(value.role);
function isSession(value: unknown): value is Session {
  if (!isRecord(value)) return false;
  if (value.hasPassword !== undefined && typeof value.hasPassword !== "boolean") return false;
  const user = value.user;
  const sso = value.sso;
  if (sso !== undefined && (!isRecord(sso) || typeof sso.enabled !== "boolean" || typeof sso.buttonLabel !== "string" || !["all", "service_admin"].includes(String(sso.passwordLogin)))) return false;
  return typeof value.setupRequired === "boolean" && Array.isArray(value.teams) && value.teams.every(isTeam)
    && (user === null || (isRecord(user) && ["userId", "username", "name", "teamId", "teamName"].every((key) => typeof user[key] === "string") && (user.email === null || typeof user.email === "string") && role(user.role)));
}
export const getSession = () => request("/api/auth/session", isSession);
export const login = (input: { username: string; password: string }) => request("/api/auth/login", isSession, { method: "POST", body: JSON.stringify(input) });
export const setup = (input: { token: string; username: string; email?: string | null; name: string; password: string }) => request("/api/auth/setup", isSession, { method: "POST", body: JSON.stringify(input) });
export const switchTeam = (teamId: string) => request("/api/auth/team", isSession, { method: "POST", body: JSON.stringify({ teamId }) });
export const logout = () => request("/api/auth/logout", (value): value is Record<string, unknown> => isRecord(value), { method: "POST", body: "{}" });
export const changePassword = (input: { currentPassword: string; newPassword: string }) => request("/api/auth/password", isSession, { method: "POST", body: JSON.stringify(input) });
export const getMembers = () => request("/api/team/members", (value): value is { members: Member[] } => isRecord(value) && Array.isArray(value.members) && value.members.every(isMember));
export const createMember = (input: { username: string; email?: string | null; name: string; password: string; role: TeamRole }) => request("/api/admin/members", isRecord, { method: "POST", body: JSON.stringify(input) });
export const addMembership = (input: { username: string; role: TeamRole }) => request("/api/admin/memberships", isRecord, { method: "POST", body: JSON.stringify(input) });
export const createTeam = (name: string) => request("/api/admin/teams", isTeam, { method: "POST", body: JSON.stringify({ name }) });

export interface LinkedIdentities {
  gitlab: Array<{ instanceUrl: string; username: string }>;
  mobile: string | null; feishuOpenId: string | null; feishuUserId: string | null;
}
export interface IdentitySettings extends LinkedIdentities { instances: string[] }
function isIdentitySettings(value: unknown): value is IdentitySettings {
  return isRecord(value) && Array.isArray(value.instances) && value.instances.every((item) => typeof item === "string")
    && Array.isArray(value.gitlab) && value.gitlab.every((item) => isRecord(item) && typeof item.instanceUrl === "string" && typeof item.username === "string")
    && ["mobile", "feishuOpenId", "feishuUserId"].every((key) => value[key] === null || typeof value[key] === "string");
}
const identityPath = (userId?: string) => userId ? `/api/admin/members/${encodeURIComponent(userId)}/identities` : "/api/account/identities";
export const getIdentities = (userId?: string) => request(identityPath(userId), isIdentitySettings);
export const saveIdentities = (input: LinkedIdentities, userId?: string) => request(identityPath(userId), isIdentitySettings, { method: "PUT", body: JSON.stringify(input) });
