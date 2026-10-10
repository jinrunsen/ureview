import { defaultSsoConfig, type SsoConfig } from "./sso-config.js";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type pg from "pg";
import { DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import { AuthError, requireAdmin, requireIdentity, type Identity } from "./context.js";
import { hashPassword, verifyPassword } from "./password.js";

export interface TeamSummary { id: string; name: string; role: "admin" | "member" }
export interface SessionView { user: Identity | null; teams: TeamSummary[]; setupRequired: boolean; hasPassword?: boolean; sso?: { enabled: boolean; buttonLabel: string; passwordLogin: "all" | "service_admin" } }
export interface NewMember { username: string; email?: string | null; name: string; password: string; role: "admin" | "member" }
interface IdentityRow { user_id: string; username: string; email: string | null; name: string; team_id: string; team_name: string; role: "admin" | "member"; service_role: "user" | "service_admin" }

function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function normalizeUsername(username: string): string {
  const normalized = username.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || /[\s@]/u.test(normalized)) {
    throw new AuthError(400, "invalid_username", "用户名需为 1 至 254 个字符，不能包含空白或 @");
  }
  return normalized;
}
export function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new AuthError(400, "invalid_email", "请填写有效的邮箱地址");
  return normalized;
}
export function normalizeName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 120) throw new AuthError(400, "invalid_name", "名称需为 1 至 120 个字符");
  return normalized;
}
function identity(row: IdentityRow): Identity {
  return { userId: row.user_id, username: row.username, email: row.email, name: row.name, teamId: row.team_id, teamName: row.team_name, role: row.role, serviceRole: row.service_role };
}

export class AuthService {
  constructor(readonly pool: pg.Pool, private readonly setupToken: string) {}

  static async create(pool: pg.Pool, tokenPath: string): Promise<AuthService> {
    let token: string;
    try { token = await readFile(tokenPath, "utf8"); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      token = randomBytes(32).toString("base64url");
      try { await writeFile(tokenPath, token, { flag: "wx", mode: 0o600 }); }
      catch (writeError) {
        if (!(writeError instanceof Error && "code" in writeError && writeError.code === "EEXIST")) throw writeError;
        token = await readFile(tokenPath, "utf8");
      }
    }
    await chmod(tokenPath, 0o600);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token.trim())) throw new Error("管理员初始化码文件不正确");
    return new AuthService(pool, token.trim());
  }

  async setupRequired(): Promise<boolean> {
    const { rows } = await this.pool.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM auth_users)");
    return !rows[0]?.exists;
  }

  async getIdentity(token: string | undefined): Promise<Identity | undefined> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const { rows } = await this.pool.query<IdentityRow>(
      `SELECT u.id AS user_id,u.username,u.email,u.name,m.team_id,t.name AS team_name,m.role,u.service_role
       FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
       JOIN team_members m ON m.user_id=s.user_id AND m.team_id=s.team_id
       JOIN teams t ON t.id=m.team_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [digest(token)],
    );
    return rows[0] ? identity(rows[0]) : undefined;
  }

  async sessionView(user?: Identity): Promise<SessionView> {
    if (!user) {
      const row = (await this.pool.query<{ configuration: Partial<SsoConfig> }>("SELECT configuration FROM service_sso WHERE singleton")).rows[0];
      const config = { ...defaultSsoConfig, ...row?.configuration };
      return { user: null, teams: [], setupRequired: await this.setupRequired(),
        sso: { enabled: config.enabled, buttonLabel: config.buttonLabel, passwordLogin: config.passwordLogin } };
    }
    const { rows } = await this.pool.query<TeamSummary>(
      "SELECT t.id,t.name,m.role FROM teams t JOIN team_members m ON m.team_id=t.id WHERE m.user_id=$1 ORDER BY t.created_at,t.id", [user.userId],
    );
    const account = (await this.pool.query<{ has_password: boolean }>("SELECT password_hash IS NOT NULL AS has_password FROM auth_users WHERE id=$1", [user.userId])).rows[0];
    return { user, teams: rows, setupRequired: false, hasPassword: account?.has_password ?? false };
  }

  async rateLimit(key: string, limit: number): Promise<void> {
    const { rows } = await this.pool.query<{ attempts: number }>(
      `INSERT INTO auth_attempts (key_hash,attempts) VALUES ($1,1)
       ON CONFLICT (key_hash) DO UPDATE SET
         attempts=CASE WHEN auth_attempts.window_start<now()-interval '10 minutes' THEN 1 ELSE auth_attempts.attempts+1 END,
         window_start=CASE WHEN auth_attempts.window_start<now()-interval '10 minutes' THEN now() ELSE auth_attempts.window_start END
       RETURNING attempts`, [digest(key)],
    );
    if ((rows[0]?.attempts ?? limit + 1) > limit) throw new AuthError(429, "too_many_attempts", "尝试次数过多，请十分钟后重试");
  }

  async setup(input: { token: string; username: string; email?: string | null; name: string; password: string }): Promise<string> {
    if (!timingSafeEqual(Buffer.from(digest(input.token)), Buffer.from(digest(this.setupToken)))) {
      throw new AuthError(403, "invalid_setup_token", "管理员初始化码不正确");
    }
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const passwordHash = await hashPassword(input.password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1937462281)");
      const { rows } = await client.query<{ exists: boolean }>("SELECT EXISTS(SELECT 1 FROM auth_users)");
      if (rows[0]?.exists) throw new AuthError(409, "already_initialized", "管理员已创建，请登录");
      const userId = randomUUID();
      await client.query("INSERT INTO auth_users (id,username,email,name,password_hash,service_role) VALUES ($1,$2,$3,$4,$5,'service_admin')", [userId,username,email,name,passwordHash]);
      await client.query("INSERT INTO team_members (team_id,user_id,role) VALUES ($1,$2,'admin')", [DEFAULT_TEAM_ID,userId]);
      const token = await this.createSession(client, userId, DEFAULT_TEAM_ID);
      await client.query("COMMIT");
      return token;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async login(username: string, password: string): Promise<string> {
    const normalized = normalizeUsername(username);
    await this.rateLimit(`username:${normalized}`, 10);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ id: string; password_hash: string | null; service_role: string }>("SELECT id,password_hash,service_role FROM auth_users WHERE username=$1 FOR UPDATE", [normalized]);
      const user = rows[0];
      const validPassword = await verifyPassword(password, user?.password_hash);
      if (user?.password_hash === null) throw new AuthError(401, "enterprise_account", "该账号使用企业账号登录");
      if (!validPassword || !user) throw new AuthError(401, "invalid_credentials", "用户名或密码不正确");
      if (user.service_role !== "service_admin") {
        const settings = (await client.query<{ restricted: boolean }>("SELECT configuration->>'passwordLogin'='service_admin' AS restricted FROM service_sso WHERE singleton")).rows[0];
        if (settings?.restricted) throw new AuthError(401, "enterprise_login_required", "请使用企业账号登录");
      }
      const { rows: memberships } = await client.query<{ team_id: string }>("SELECT team_id FROM team_members WHERE user_id=$1 ORDER BY team_id LIMIT 1", [user.id]);
      const membership = memberships[0];
      if (!membership) throw new AuthError(403, "no_team", "账号尚未加入团队，请联系管理员");
      await client.query("DELETE FROM auth_attempts WHERE key_hash=$1 OR window_start<now()-interval '1 day'", [digest(`username:${normalized}`)]);
      await client.query("DELETE FROM auth_sessions WHERE expires_at<=now()");
      const token = await this.createSession(client, user.id, membership.team_id);
      await client.query("COMMIT");
      return token;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async createSession(database: Pick<pg.Pool, "query">, userId: string, teamId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    await database.query("INSERT INTO auth_sessions (token_hash,user_id,team_id,expires_at) VALUES ($1,$2,$3,now()+interval '7 days')", [digest(token),userId,teamId]);
    return token;
  }

  async logout(token: string): Promise<void> { await this.pool.query("DELETE FROM auth_sessions WHERE token_hash=$1", [digest(token)]); }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = requireIdentity();
    await this.rateLimit(`password:${user.userId}`, 10);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ password_hash: string | null }>(
        "SELECT password_hash FROM auth_users WHERE id=$1 FOR UPDATE", [user.userId],
      );
      const session = await client.query(
        "SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() FOR UPDATE", [digest(token),user.userId],
      );
      if (!session.rowCount) throw new AuthError(401, "authentication_required", "请先登录");
      const validPassword = await verifyPassword(currentPassword, rows[0]?.password_hash);
      if (rows[0]?.password_hash === null) throw new AuthError(403, "password_unavailable", "该账号使用企业账号登录，不能修改密码");
      if (!validPassword) {
        throw new AuthError(400, "invalid_current_password", "当前密码不正确");
      }
      const passwordHash = await hashPassword(newPassword);
      await client.query("UPDATE auth_users SET password_hash=$2 WHERE id=$1", [user.userId,passwordHash]);
      await client.query("DELETE FROM auth_sessions WHERE user_id=$1 AND token_hash<>$2", [user.userId,digest(token)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async switchTeam(token: string, user: Identity, teamId: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE auth_sessions SET team_id=$3 WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()
       AND EXISTS(SELECT 1 FROM team_members WHERE user_id=$2 AND team_id=$3)`, [digest(token),user.userId,teamId],
    );
    if (!result.rowCount) throw new AuthError(403, "team_access_denied", "你不是该团队的成员");
  }

  async members(teamId: string): Promise<Array<{ id: string; username: string; email: string | null; name: string; role: "admin" | "member" }>> {
    return (await this.pool.query<{ id: string; username: string; email: string | null; name: string; role: "admin" | "member" }>(
      "SELECT u.id,u.username,u.email,u.name,m.role FROM auth_users u JOIN team_members m ON m.user_id=u.id WHERE m.team_id=$1 ORDER BY u.name,u.id", [teamId],
    )).rows;
  }

  async createMember(input: NewMember): Promise<void> {
    const admin = requireAdmin();
    const username = normalizeUsername(input.username);
    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const passwordHash = await hashPassword(input.password);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const userId = randomUUID();
      const inserted = await client.query("INSERT INTO auth_users (id,username,email,name,password_hash) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (username) DO NOTHING", [userId,username,email,name,passwordHash]);
      if (!inserted.rowCount) throw new AuthError(409, "user_exists", "用户名已存在，请通过用户名添加已有成员");
      await client.query("INSERT INTO team_members (team_id,user_id,role) VALUES ($1,$2,$3)", [admin.teamId,userId,input.role]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async addMember(username: string, role: "admin" | "member"): Promise<void> {
    const admin = requireAdmin();
    const result = await this.pool.query(
      `INSERT INTO team_members (team_id,user_id,role) SELECT $1,id,$3 FROM auth_users WHERE username=$2
       ON CONFLICT (team_id,user_id) DO NOTHING`, [admin.teamId,normalizeUsername(username),role],
    );
    if (!result.rowCount) throw new AuthError(409, "member_not_added", "账号不存在或已经在此团队中");
  }

  async createTeam(name: string): Promise<TeamSummary> {
    const admin = requireAdmin();
    const team = { id: randomUUID(), name: normalizeName(name), role: "admin" as const };
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO teams (id,name) VALUES ($1,$2)", [team.id,team.name]);
      await client.query("INSERT INTO team_members (team_id,user_id,role) VALUES ($1,$2,'admin')", [team.id,admin.userId]);
      await client.query("COMMIT");
      return team;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async allTeamIds(): Promise<string[]> { return (await this.pool.query<{ id: string }>("SELECT id FROM teams ORDER BY created_at,id")).rows.map((row) => row.id); }

  async repositoryTeam(repositoryId: string): Promise<string | undefined> {
    for (const teamId of await this.allTeamIds()) {
      const result = await withTeam(teamId, () => this.pool.query("SELECT 1 FROM repositories WHERE id=$1", [repositoryId]));
      if (result.rowCount) return teamId;
    }
    return undefined;
  }
}
