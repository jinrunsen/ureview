import { AsyncLocalStorage } from "node:async_hooks";
import { withTeam } from "../db/tenant.js";

export interface Identity {
  userId: string;
  username: string;
  email: string | null;
  name: string;
  teamId: string;
  teamName: string;
  role: "admin" | "member";
  serviceRole?: "user" | "service_admin";
}

export class AuthError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) { super(message); }
}

const identities = new AsyncLocalStorage<Identity>();
export function currentIdentity(): Identity | undefined { return identities.getStore(); }
export function requireIdentity(): Identity {
  const identity = currentIdentity();
  if (!identity) throw new AuthError(401, "authentication_required", "请先登录");
  return identity;
}
export function requireAdmin(): Identity {
  const identity = requireIdentity();
  if (identity.role !== "admin") throw new AuthError(403, "admin_required", "此操作需要团队管理员权限");
  return identity;
}
export function withIdentity<T>(identity: Identity, run: () => T): T {
  return identities.run(identity, () => withTeam(identity.teamId, run));
}

export function requireServiceAdmin(): Identity {
  const identity = requireIdentity();
  if (identity.serviceRole !== "service_admin") throw new AuthError(403, "service_admin_required", "此操作需要服务管理员权限");
  return identity;
}
