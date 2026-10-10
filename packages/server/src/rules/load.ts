import { ReviewError, type FilePatch, type ReviewRule } from "../reviews/types.js";
import { matchesRuleLanguage, type RuleRelation } from "./metadata.js";
import { resolveRuleEffects } from "./effect.js";
import { glob } from "./repository.js";
import type { ManagedRule } from "./managed-types.js";

export type ManagedRulesReader = (repositoryId: string) => Promise<ManagedRule[]>;

export class ReviewRulesLoader {
  constructor(private readonly managedRules?: ManagedRulesReader) {}

  async load(repositoryId: string, changes: FilePatch[]): Promise<ReviewRule[]> {
    return (await this.loadWithRelations(repositoryId, changes)).rules;
  }

  async loadWithRelations(repositoryId: string, changes: FilePatch[]): Promise<{ rules: ReviewRule[]; relations: RuleRelation[] }> {
    let managed: ManagedRule[];
    try { managed = await this.managedRules?.(repositoryId) ?? []; }
    catch { throw new ReviewError("rules_unavailable", "无法读取团队数据库规范，请稍后重试", { operation: "managed_rules_read" }); }
    const paths = [...new Set(changes.flatMap((change) => [change.oldPath, change.newPath]))];
    const snapshots: ReviewRule[] = [];
    for (const rule of managed) {
      if (rule.status !== "active") continue;
      const selected = rule.repositories.filter((scope) => scope.repositoryId === repositoryId);
      if (rule.scope !== "global" && !selected.length) continue;
      const matchedPaths = paths.filter((path) => matchesRuleLanguage(rule.languages ?? [], path) && (rule.scope === "global" || selected.some((scope) =>
        !scope.paths.length || scope.paths.some((pattern) => glob(pattern)?.test(path)))));
      if (!matchedPaths.length) continue;
      snapshots.push({ id: `managed:${rule.id}`, name: rule.name, body: rule.body, category: rule.category,
        judgement: rule.judgement ?? false, layer: rule.layer ?? "team", languages: rule.languages ?? [], overrides: rule.overrides ?? [],
        ...(rule.scope === "global" && rule.waivers?.find((waiver) => waiver.repositoryId === repositoryId)
          ? { waiver: rule.waivers.find((waiver) => waiver.repositoryId === repositoryId)! } : {}),
        severity: rule.severity, goodExample: rule.goodExample, badExample: rule.badExample, source: { kind: "generated" },
        file: { kind: "database", ruleId: rule.id, version: rule.version, scope: rule.scope }, matchedPaths });
    }
    return { rules: resolveRuleEffects(snapshots), relations: managed.map((rule) => ({ id: `managed:${rule.id}`, layer: rule.layer ?? "team", overrides: rule.overrides ?? [] })) };
  }
}
