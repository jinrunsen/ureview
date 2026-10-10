import type pg from "pg";
import { ManagedRuleError, type ManagedRuleInput } from "../managed-types.js";
import { canOverrideLayer, type RuleLayer } from "../metadata.js";

interface Relation { id: string; layer: RuleLayer; overrides: string[]; repositoryId?: string }

/** 写入规范和同步 Git 目录共用团队锁，防止并发修改破坏覆盖方向。 */
export async function lockRuleHierarchy(client: pg.PoolClient, teamId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-hierarchy:${teamId}`]);
}

export async function checkRuleRelations(client: pg.PoolClient, id: string, input: ManagedRuleInput): Promise<void> {
  const managed = await client.query<{ id: string; layer: RuleLayer; overrides: string[] }>("SELECT id,layer,overrides FROM managed_rules");
  const catalog = await client.query<{ repository_id: string; payload: Relation }>(
    "SELECT repository_id,payload FROM rule_catalog WHERE payload->>'kind' IS DISTINCT FROM 'lint'");
  const ruleId = `managed:${id}`;
  const rules: Relation[] = [
    ...managed.rows.filter((row) => row.id !== id).map((row) => ({ ...row, id: `managed:${row.id}` })),
    ...catalog.rows.map((row) => ({ id: row.payload.id, layer: row.payload.layer ?? "team", overrides: row.payload.overrides ?? [], repositoryId: row.repository_id })),
    { id: ruleId, layer: input.layer, overrides: input.overrides },
  ];
  const applies = (rule: Relation) => !rule.repositoryId || input.scope === "global" || input.repositories.some((entry) => entry.repositoryId === rule.repositoryId);
  for (const targetId of input.overrides) {
    const targets = rules.filter((rule) => rule.id === targetId && applies(rule));
    if (!targets.length) throw new ManagedRuleError(400, "invalid_input", "覆盖目标不存在或不在规范的仓库范围内");
    if (targets.some((target) => !canOverrideLayer(input.layer, target.layer))) {
      throw new ManagedRuleError(400, "invalid_input", "覆盖只能由团队层指向语言层或通用层，或由语言层指向通用层");
    }
  }
  if (rules.some((rule) => rule.overrides.includes(ruleId) && !canOverrideLayer(rule.layer, input.layer))) {
    throw new ManagedRuleError(400, "invalid_input", "该层级会使已有覆盖关系失效，请先调整覆盖方");
  }
  const reaches = (current: string, seen: Set<string>): boolean => {
    if (current === ruleId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    return rules.filter((rule) => rule.id === current && applies(rule)).some((rule) => rule.overrides.some((next) => reaches(next, seen)));
  };
  if (input.overrides.some((target) => reaches(target, new Set()))) throw new ManagedRuleError(400, "invalid_input", "覆盖关系不能成环");
}
