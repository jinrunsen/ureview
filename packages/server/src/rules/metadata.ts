import { extname } from "node:path";

export const ruleLayers = ["principle", "general", "language", "team"] as const;
export type RuleLayer = typeof ruleLayers[number];
export const layerLabels: Record<RuleLayer, string> = { principle: "原则层", general: "通用层", language: "语言层", team: "团队层" };

// 扩展名区分大小写：.C 是 C++，.c 是 C；.h 同时适用于两种语言。
const definitions = [
  { id: "c", label: "C", extensions: [".c", ".h"] },
  { id: "cpp", label: "C++", extensions: [".cpp", ".cc", ".cxx", ".C", ".h", ".hpp", ".hh", ".hxx"] },
  { id: "go", label: "Go", extensions: [".go"] },
  { id: "java", label: "Java", extensions: [".java"] },
  { id: "python", label: "Python", extensions: [".py", ".pyi", ".pyw"] },
  { id: "javascript", label: "JavaScript", extensions: [".js", ".jsx", ".mjs", ".cjs"] },
  { id: "typescript", label: "TypeScript", extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { id: "rust", label: "Rust", extensions: [".rs"] },
  { id: "shell", label: "Shell", extensions: [".sh", ".bash", ".zsh", ".ksh"] },
  { id: "sql", label: "SQL", extensions: [".sql"] },
  { id: "kotlin", label: "Kotlin", extensions: [".kt", ".kts"] },
  { id: "csharp", label: "C#", extensions: [".cs"] },
  { id: "ruby", label: "Ruby", extensions: [".rb", ".rake"] },
  { id: "php", label: "PHP", extensions: [".php"] },
  { id: "swift", label: "Swift", extensions: [".swift"] },
] as const;

export const ruleLanguages: readonly string[] = definitions.map(({ id }) => id);
export const languageOptions = definitions.map(({ id, label }) => ({ id, label }));
export function matchesRuleLanguage(languages: readonly string[], path: string): boolean {
  return !languages.length || definitions.some((entry) => languages.includes(entry.id)
    && (entry.extensions as readonly string[]).includes(extname(path)));
}

export function canOverrideLayer(from: RuleLayer, to: RuleLayer): boolean {
  return from === "team" && (to === "language" || to === "general") || from === "language" && to === "general";
}

export interface RuleRelation { id: string; layer?: RuleLayer; overrides?: string[] }

export function validOverrides(rule: RuleRelation, rules: readonly RuleRelation[], warn: (message: string) => void): string[] {
  return [...new Set(rule.overrides ?? [])].filter((id) => {
    const target = rules.find((entry) => entry.id === id);
    const reaches = (current: string, seen: Set<string>): boolean => {
      if (current === rule.id) return true;
      if (seen.has(current)) return false;
      seen.add(current);
      return (rules.find((entry) => entry.id === current)?.overrides ?? []).some((next) => reaches(next, seen));
    };
    const reason = !target ? "目标不存在" : reaches(id, new Set()) ? "覆盖关系成环"
      : !canOverrideLayer(rule.layer ?? "team", target.layer ?? "team") ? "层级方向无效" : null;
    if (reason) warn(`${rule.id} 覆盖 ${id}：${reason}，已忽略该关系`);
    return !reason;
  });
}
