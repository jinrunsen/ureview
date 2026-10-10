import { randomUUID } from "node:crypto";
import type { AuthService } from "./service.js";
import { normalizeUsername, normalizeEmail, normalizeName } from "./service.js";
import type { SsoConfig } from "./sso-config.js";
import { fieldAt, SsoFailure } from "./sso-protocol.js";

export function ssoUsername(value: string, suffix = 1): string {
  const base = value.split("@")[0]!.replace(/\s/gu, "").toLowerCase() || "employee";
  const tail = suffix > 1 ? `-${suffix}` : "";
  return normalizeUsername(`${base.slice(0, 254 - tail.length)}${tail}`);
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
export async function loginSsoAccount(auth: AuthService, config: SsoConfig, provider: string, subject: string, claims: Record<string, unknown>) {
  const client = await auth.pool.connect();
  try {
    await client.query("BEGIN");
    // 身份绑定与关联选择串行，避免同一个本地账号被两个首次登录同时认领。
    await client.query("SELECT pg_advisory_xact_lock(1937462283)");
    let userId = (await client.query<{ user_id: string }>("SELECT user_id FROM auth_sso_bindings WHERE provider=$1 AND subject=$2", [provider, subject])).rows[0]?.user_id;
    if (!userId) {
      const username = text(fieldAt(claims, config.usernameField));
      let email: string | null = null;
      try { email = normalizeEmail(text(fieldAt(claims, config.emailField))); } catch { /* 身份源的无效邮箱不保存。 */ }
      let normalizedUsername = "";
      try { normalizedUsername = normalizeUsername(username); } catch { /* 无效用户名不能关联已有账号。 */ }
      if ((config.linking === "username" && normalizedUsername) || (config.linking === "email" && email && !(config.protocol === "oidc" && claims.email_verified === false))) {
        const matches = await client.query<{ id: string; service_role: string }>(`SELECT id,service_role FROM auth_users WHERE ${config.linking === "username" ? "username" : "email"}=$1 ORDER BY created_at,id LIMIT 2 FOR UPDATE`, [config.linking === "username" ? normalizedUsername : email]);
        // 邮箱不是唯一列；多个同邮箱账号无法安全地自动选择。
        if (matches.rows.length === 1 && matches.rows[0]!.service_role !== "service_admin" && !(await client.query("SELECT 1 FROM auth_sso_bindings WHERE user_id=$1 AND provider=$2", [matches.rows[0]!.id, provider])).rowCount) userId = matches.rows[0]!.id;
      }
      if (!userId) {
        userId = randomUUID();
        for (let suffix = 1; ; suffix++) {
          const candidate = ssoUsername(username || subject, suffix);
          const name = normalizeName((text(fieldAt(claims, config.nameField)) || candidate).slice(0, 120));
          const inserted = await client.query("INSERT INTO auth_users(id,username,email,name,password_hash) VALUES($1,$2,$3,$4,NULL) ON CONFLICT(username) DO NOTHING", [userId, candidate, email, name]);
          if (inserted.rowCount) break;
        }
        await client.query("INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'member')", [config.defaultTeamId, userId]);
      }
      await client.query("INSERT INTO auth_sso_bindings(user_id,provider,subject) VALUES($1,$2,$3)", [userId, provider, subject]);
    }
    const membership = (await client.query<{ team_id: string }>("SELECT team_id FROM team_members WHERE user_id=$1 ORDER BY team_id LIMIT 1", [userId])).rows[0];
    if (!membership) throw new SsoFailure("no_team");
    await client.query("UPDATE auth_sso_bindings SET last_login_at=now() WHERE provider=$1 AND subject=$2", [provider, subject]);
    const token = await auth.createSession(client, userId, membership.team_id);
    await client.query("COMMIT");
    return token;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
