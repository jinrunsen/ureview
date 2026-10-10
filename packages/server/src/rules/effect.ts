import type { ReviewRule } from "../reviews/types.js";
import { canOverrideLayer, layerLabels, matchesRuleLanguage, ruleLayers } from "./metadata.js";

export const judgementGuidance = "判断题规范是启发式判断。命中时以「可能的 X」表述，写明代码依据与例外情形；严重度最高为中危（medium），高危提交会被拒绝，修正为中危后可重试。与团队规范冲突时以团队规范为准。解读引用判断题规范时，同样以「可能的 X」表述并写明依据与例外情形，遵循团队规范。";
export const ruleGuidance = `规范按原则、通用、语言、团队分组。原则用于指导判断，不能作为 finding 的命中规范；原则不可违反。同一主题以更具体的层级为准，显式覆盖只对双方同时适用的文件生效。${judgementGuidance}`;

export function effectivePaths(rule: ReviewRule): string[] {
  return rule.status === "waived" || rule.status === "overridden" ? [] : rule.effectivePaths ?? rule.matchedPaths;
}

export function resolveRuleEffects<T extends ReviewRule>(rules: T[]): T[] {
  return rules.map((rule) => {
    if (rule.waiver || rule.status === "waived") return { ...rule, status: "waived", effectivePaths: [], overriddenBy: [] };
    const overriddenBy = rules.flatMap((source) => {
      if (source.waiver || source.status === "waived" || !source.overrides?.includes(rule.id)
        || !canOverrideLayer(source.layer ?? "team", rule.layer ?? "team")) return [];
      const paths = rule.matchedPaths.filter((path) => source.matchedPaths.includes(path));
      return paths.length ? [{ ruleId: source.id, paths }] : [];
    });
    const paths = rule.matchedPaths.filter((path) => !overriddenBy.some((entry) => entry.paths.includes(path)));
    return { ...rule, status: paths.length ? "active" : "overridden", effectivePaths: paths, overriddenBy };
  });
}

/**
 * 渲染注入提示词的团队规范。适用路径覆盖本次全部同语言变更文件时只写一句说明，
 * 否则列出生效路径；路径清单、来源和覆盖关系的完整数据只留在宿主快照里。
 */
/** 本次变更涉及的全部路径，与数据库规范匹配时使用同一口径（新旧路径都算）。 */
export function changedPaths(files: ReadonlyArray<{ oldPath: string; newPath: string }>): string[] {
  return [...new Set(files.flatMap((file) => [file.oldPath, file.newPath]))];
}

export function renderRuleGroups(rules: ReviewRule[], changedPaths: string[] = []): string {
  const changed = [...new Set(changedPaths)];
  const promptRule = (rule: ReviewRule) => {
    const paths = effectivePaths(rule);
    const languages = rule.languages ?? [];
    const scope = changed.filter((path) => matchesRuleLanguage(languages, path));
    const all = scope.length > 0 && scope.every((path) => paths.includes(path));
    return { id: rule.id, ...(rule.name ? { name: rule.name } : {}), body: rule.body,
      ...(rule.category ? { category: rule.category } : {}), ...(rule.severity ? { severity: rule.severity } : {}),
      ...(rule.judgement ? { judgement: true } : {}), ...(languages.length ? { languages } : {}),
      ...(rule.goodExample ? { goodExample: rule.goodExample } : {}), ...(rule.badExample ? { badExample: rule.badExample } : {}),
      matchedPaths: all ? (languages.length ? `本次全部 ${languages.join("/")} 变更文件` : "本次全部变更文件") : paths };
  };
  return ruleLayers.map((layer) => {
    const active = rules.filter((rule) => (rule.layer ?? "team") === layer && effectivePaths(rule).length).map(promptRule);
    if (!active.length) return "";
    const ordinary = active.filter((rule) => !rule.judgement);
    const judgement = active.filter((rule) => rule.judgement);
    return [`${layerLabels[layer]}：`, ordinary.length ? JSON.stringify(ordinary) : "",
      judgement.length ? `判断题规范：\n${JSON.stringify(judgement)}` : ""].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n");
}
