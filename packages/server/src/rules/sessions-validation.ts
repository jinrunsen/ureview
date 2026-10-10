import { ManagedRuleError, ruleCategories, ruleSeverities, validateRuleMetadata, validateRuleOverrides, type ManagedRuleInput } from "./managed-types.js";

export const invalidSession = (message = "请检查规范会话的请求内容") => new ManagedRuleError(400, "invalid_input", message);
export function sessionRecord(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw invalidSession();
  return value as Record<string, unknown>;
}
export function sessionIdentifier(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalidSession("会话或规范标识不正确");
  return value.toLowerCase();
}
export function sessionVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value >= 2_147_483_647) throw invalidSession("版本不正确，请重新读取后重试");
  return value;
}

/** 工作稿保留编辑中的空字段；保存规范时再校验完整正文和有效路径。 */
export function workingCopy(value: unknown): ManagedRuleInput | null {
  if (value === null) return null;
  const input = sessionRecord(value, ["name", "body", "goodExample", "badExample", "category", "severity", "scope", "repositories", "status", "layer", "languages", "overrides", "judgement"]);
  for (const key of ["name", "body", "goodExample", "badExample"] as const) {
    if (typeof input[key] !== "string" || input[key].length > (key === "name" ? 160 : 12000)) throw invalidSession("工作稿字段不完整或内容过长");
  }
  if (!ruleCategories.includes(input.category as ManagedRuleInput["category"]) || !ruleSeverities.includes(input.severity as ManagedRuleInput["severity"])
    || !["global", "repositories"].includes(String(input.scope)) || !["draft", "active"].includes(String(input.status))
    || !Array.isArray(input.repositories) || input.repositories.length > 100) throw invalidSession();
  const seen = new Set<string>();
  const repositories = input.repositories.map((value: unknown) => {
    const row = sessionRecord(value, ["repositoryId", "paths"]);
    const repositoryId = sessionIdentifier(row.repositoryId);
    if (seen.has(repositoryId) || !Array.isArray(row.paths) || row.paths.length > 64
      || row.paths.some((path: unknown) => typeof path !== "string" || path.length > 256)) throw invalidSession("请检查工作稿的仓库和路径");
    seen.add(repositoryId);
    return { repositoryId, paths: row.paths as string[] };
  });
  if (input.scope === "global" && repositories.length) throw invalidSession("全局规范无需选择仓库");
  return { ...validateRuleMetadata(input), overrides: validateRuleOverrides(input.overrides), name: input.name as string, body: input.body as string, goodExample: input.goodExample as string, badExample: input.badExample as string,
    category: input.category as ManagedRuleInput["category"], severity: input.severity as ManagedRuleInput["severity"],
    scope: input.scope as ManagedRuleInput["scope"], status: input.status as ManagedRuleInput["status"], repositories };
}
