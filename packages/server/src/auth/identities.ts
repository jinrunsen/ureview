import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { AuthError, requireAdmin, requireIdentity } from "./context.js";

export interface LinkedIdentities {
  gitlab: Array<{ instanceUrl: string; username: string }>;
  mobile: string | null;
  feishuOpenId: string | null;
  feishuUserId: string | null;
}
export interface IdentitySettings extends LinkedIdentities { instances: string[] }

export class IdentityService {
  constructor(private readonly pool: pg.Pool) {}

  private async authorize(userId: string): Promise<void> {
    const actor = requireIdentity();
    if (actor.userId !== userId) requireAdmin();
    const member = await this.pool.query("SELECT 1 FROM team_members WHERE team_id=$1 AND user_id=$2", [actor.teamId, userId]);
    if (!member.rowCount) throw new AuthError(404, "member_not_found", "成员不存在");
  }

  async get(userId = requireIdentity().userId): Promise<IdentitySettings> {
    await this.authorize(userId);
    const instances = (await this.pool.query<{ instance_url: string }>("SELECT DISTINCT instance_url FROM repositories ORDER BY instance_url")).rows.map((row) => row.instance_url);
    const { rows } = await this.pool.query<{ im_mobile: string | null; feishu_open_id: string | null; feishu_user_id: string | null }>(
      "SELECT im_mobile,feishu_open_id,feishu_user_id FROM auth_users WHERE id=$1", [userId]);
    const user = rows[0]!;
    const gitlab = (await this.pool.query<{ instanceUrl: string; username: string }>(
      'SELECT instance_url AS "instanceUrl",username FROM auth_gitlab_identities WHERE user_id=$1 AND instance_url=ANY($2::text[]) ORDER BY instance_url', [userId, instances])).rows;
    return { instances, gitlab, mobile: user.im_mobile, feishuOpenId: user.feishu_open_id, feishuUserId: user.feishu_user_id };
  }

  async save(input: LinkedIdentities, userId = requireIdentity().userId): Promise<IdentitySettings> {
    const current = await this.get(userId);
    const gitlab = input.gitlab.map((item) => ({ instanceUrl: item.instanceUrl, username: item.username.trim() }));
    if (new Set(gitlab.map((item) => item.instanceUrl)).size !== gitlab.length || gitlab.some((item) =>
      !current.instances.includes(item.instanceUrl) || !/^[A-Za-z0-9_.-]{1,255}$/.test(item.username))) {
      throw new AuthError(400, "invalid_gitlab_identity", "请选择已接入的 GitLab 实例并填写有效用户名");
    }
    const mobile = input.mobile?.trim() || null;
    const feishuOpenId = input.feishuOpenId?.trim() || null;
    const feishuUserId = input.feishuUserId?.trim() || null;
    if (mobile && !/^\+?[0-9]{6,20}$/.test(mobile)) throw new AuthError(400, "invalid_mobile", "请填写有效手机号");
    if ([feishuOpenId, feishuUserId].some((id) => id?.toLowerCase() === "all") || (feishuOpenId && !/^[A-Za-z0-9_-]{1,128}$/.test(feishuOpenId)) || (feishuUserId && !/^[A-Za-z0-9_-]{1,128}$/.test(feishuUserId)) || (feishuOpenId && feishuUserId)) {
      throw new AuthError(400, "invalid_feishu_identity", "飞书 open_id 与 user_id 请选择一项填写");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT id FROM auth_users WHERE id=$1 FOR UPDATE", [userId]);
      await client.query("DELETE FROM auth_gitlab_identities WHERE user_id=$1 AND instance_url=ANY($2::text[])", [userId, current.instances]);
      for (const item of gitlab) await client.query("INSERT INTO auth_gitlab_identities(user_id,instance_url,username) VALUES($1,$2,$3)", [userId, item.instanceUrl, item.username]);
      await client.query("UPDATE auth_users SET im_mobile=$2,feishu_open_id=$3,feishu_user_id=$4 WHERE id=$1", [userId, mobile, feishuOpenId, feishuUserId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && "code" in error && error.code === "23505") throw new AuthError(409, "gitlab_identity_taken", "此 GitLab 用户名已被其他账号关联");
      throw error;
    } finally { client.release(); }
    return this.get(userId);
  }
}

export function registerIdentityRoutes(app: FastifyInstance, identities: IdentityService): void {
  const nullableText = { anyOf: [{ type: "string", maxLength: 255 }, { type: "null" }] };
  const body = { type: "object", additionalProperties: false, required: ["gitlab", "mobile", "feishuOpenId", "feishuUserId"], properties: {
    gitlab: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["instanceUrl", "username"], properties: {
      instanceUrl: { type: "string", maxLength: 2048 }, username: { type: "string", minLength: 1, maxLength: 255 },
    } } }, mobile: nullableText, feishuOpenId: nullableText, feishuUserId: nullableText,
  } };
  const params = { type: "object", required: ["userId"], properties: { userId: { type: "string", format: "uuid" } } };
  app.get("/api/account/identities", async () => identities.get());
  app.put<{ Body: LinkedIdentities }>("/api/account/identities", { schema: { body } }, async (request) => identities.save(request.body));
  app.get<{ Params: { userId: string } }>("/api/admin/members/:userId/identities", { schema: { params } }, async (request) => {
    requireAdmin(); return identities.get(request.params.userId);
  });
  app.put<{ Params: { userId: string }; Body: LinkedIdentities }>("/api/admin/members/:userId/identities", { schema: { params, body } }, async (request) => {
    requireAdmin(); return identities.save(request.body, request.params.userId);
  });
}
