import { randomUUID } from "node:crypto";
import type pg from "pg";
import { requireAdmin, requireIdentity } from "../../auth/context.js";
import { ManagedRuleError, type RuleWaiver } from "../managed-types.js";
import { lockRuleHierarchy } from "./relations.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message: string) => new ManagedRuleError(400, "invalid_input", message);
interface WaiverRow {
  id: string; repository_id: string; reason: string; created_by: string; created_at: Date; revoked_by: string | null; revoked_at: Date | null;
}

export async function listRuleWaivers(pool: pg.Pool, ruleId: string): Promise<RuleWaiver[]> {
  requireIdentity();
  if (!uuid.test(ruleId)) throw invalid("规范标识不正确");
  if (!(await pool.query("SELECT id FROM managed_rules WHERE id=$1", [ruleId])).rowCount) throw new ManagedRuleError(404, "not_found", "规范不存在");
  const result = await pool.query<WaiverRow>("SELECT * FROM managed_rule_waivers WHERE rule_id=$1 ORDER BY created_at,id", [ruleId]);
  return result.rows.map((row) => ({ id: row.id, repositoryId: row.repository_id, reason: row.reason, createdBy: row.created_by,
    createdAt: row.created_at.toISOString(), revokedBy: row.revoked_by, revokedAt: row.revoked_at?.toISOString() ?? null }));
}

export async function updateRuleWaiver(pool: pg.Pool, ruleId: string, repositoryId: string, value?: unknown): Promise<void> {
  const actor = requireAdmin();
  if (!uuid.test(ruleId) || !uuid.test(repositoryId)) throw invalid("规范或仓库标识不正确");
  let reason: string | undefined;
  if (value !== undefined) {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "reason")) throw invalid("请填写豁免理由");
    const content = value as Record<string, unknown>;
    if (typeof content.reason !== "string" || !content.reason.trim() || content.reason.trim().length > 2000) throw invalid("豁免理由需要 1–2000 个字符");
    reason = content.reason.trim();
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockRuleHierarchy(client, actor.teamId);
    const rule = await client.query<{ scope: string }>("SELECT scope FROM managed_rules WHERE id=$1 FOR UPDATE", [ruleId]);
    if (!rule.rows[0]) throw new ManagedRuleError(404, "not_found", "规范不存在");
    if (!(await client.query("SELECT id FROM repositories WHERE id=$1 FOR KEY SHARE", [repositoryId])).rowCount) throw new ManagedRuleError(404, "not_found", "仓库不存在");
    if (reason && rule.rows[0].scope !== "global") throw invalid("只有团队全局规范可以设置仓库豁免");
    await client.query("UPDATE managed_rule_waivers SET revoked_by=$3,revoked_at=now() WHERE rule_id=$1 AND repository_id=$2 AND revoked_at IS NULL", [ruleId, repositoryId, actor.userId]);
    if (reason) await client.query("INSERT INTO managed_rule_waivers(id,rule_id,repository_id,reason,created_by) VALUES($1,$2,$3,$4,$5)", [randomUUID(), ruleId, repositoryId, reason, actor.userId]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
