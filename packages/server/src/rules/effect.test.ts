import { describe, expect, it } from "vitest";
import type { ReviewRule } from "../reviews/types.js";
import { matchesRuleLanguage, validOverrides } from "./metadata.js";
import { effectivePaths, renderRuleGroups, resolveRuleEffects, ruleGuidance } from "./effect.js";

const rule = (id: string, fields: Partial<ReviewRule> = {}): ReviewRule => ({ id, body: `规范 ${id}`, layer: "general",
  file: { kind: "database", ruleId: id, version: 1, scope: "global" }, source: { kind: "manual" }, matchedPaths: ["src/payment.ts", "src/refund.ts"], ...fields });

describe("规范语言与逐文件效力", () => {
  it("固定扩展名表涵盖语言族，未知扩展名仅匹配全部语言", () => {
    for (const [language, path] of [["c", "src/pay.c"], ["cpp", "src/pay.C"], ["cpp", "src/pay.hpp"], ["go", "pay.go"],
      ["java", "Pay.java"], ["python", "pay.pyi"], ["javascript", "pay.mjs"], ["typescript", "pay.tsx"], ["rust", "pay.rs"],
      ["shell", "pay.sh"], ["sql", "pay.sql"], ["kotlin", "pay.kts"]]) expect(matchesRuleLanguage([language!], path!)).toBe(true);
    expect(matchesRuleLanguage(["c"], "pay.C")).toBe(false);
    expect(matchesRuleLanguage(["c"], "pay.h")).toBe(true);
    expect(matchesRuleLanguage(["cpp"], "pay.h")).toBe(true);
    expect(matchesRuleLanguage(["sql"], "pay.c")).toBe(false);
    expect(matchesRuleLanguage(["typescript"], "pay.unknown")).toBe(false);
    expect(matchesRuleLanguage([], "pay.unknown")).toBe(true);
  });

  it("覆盖只消除重叠路径，其他文件保留上层规范", () => {
    const result = resolveRuleEffects([rule("general"), rule("team", { layer: "team", overrides: ["general"], matchedPaths: ["src/payment.ts"] })]);
    expect(result[0]).toMatchObject({ status: "active", effectivePaths: ["src/refund.ts"], overriddenBy: [{ ruleId: "team", paths: ["src/payment.ts"] }] });
    const prompt = renderRuleGroups(result);
    expect(prompt).toContain('"matchedPaths":["src/refund.ts"]');
  });

  it("连续覆盖保留最具体规范，豁免覆盖方后恢复目标", () => {
    const general = rule("general"), language = rule("language", { layer: "language", overrides: ["general"] });
    const team = rule("team", { layer: "team", overrides: ["language"] });
    const result = resolveRuleEffects([general, language, team]);
    expect(result.map((entry) => entry.status)).toEqual(["overridden", "overridden", "active"]);
    expect(renderRuleGroups(result)).not.toContain("规范 general");
    expect(renderRuleGroups(result)).not.toContain("规范 language");
    const waived = resolveRuleEffects([general, { ...language, waiver: { reason: "旧版本单独维护", createdBy: "admin", createdAt: "2026-10-06T00:00:00Z" } }]);
    expect(waived[0]!.status).toBe("active");
    expect(effectivePaths(waived[1]!)).toEqual([]);
    expect(renderRuleGroups(waived)).not.toContain("旧版本单独维护");
  });

  it("原则不参与覆盖，提示词按四层顺序分组", () => {
    const result = resolveRuleEffects([rule("team", { layer: "team", overrides: ["principle"] }), rule("language", { layer: "language" }),
      rule("general"), rule("principle", { layer: "principle" })]);
    expect(result.every((entry) => entry.status === "active")).toBe(true);
    const prompt = renderRuleGroups(result);
    expect(prompt.indexOf("原则层")).toBeLessThan(prompt.indexOf("通用层"));
    expect(prompt.indexOf("通用层")).toBeLessThan(prompt.indexOf("语言层"));
    expect(prompt.indexOf("语言层")).toBeLessThan(prompt.indexOf("团队层"));
  });

  it("每层单列判断题规范并说明表述、严重度和团队规范优先", () => {
    const prompt = renderRuleGroups([rule("ordinary"), rule("smell", { judgement: true })]);
    const [ordinary, judgement] = prompt.split("判断题规范：");
    expect(ordinary).toContain("规范 ordinary");
    expect(ordinary).not.toContain("规范 smell");
    expect(judgement).toContain('"judgement":true');
    expect(judgement).toContain("规范 smell");
    for (const text of ["可能的 X", "依据与例外情形", "最高为中危", "以团队规范为准", "解读引用判断题规范"]) {
      expect(ruleGuidance).toContain(text);
    }
  });

  it("适用于本次全部同语言变更文件时不逐条列路径，只保留模型需要的字段", () => {
    const changed = ["src/payment.ts", "src/refund.ts", "docs/README.md"];
    const prompt = renderRuleGroups(resolveRuleEffects([
      rule("general", { matchedPaths: changed }),
      rule("language", { layer: "language", languages: ["typescript"] }),
      rule("team", { layer: "team", matchedPaths: ["src/payment.ts"] }),
    ]), changed);
    expect(prompt).toContain('"matchedPaths":"本次全部变更文件"');
    expect(prompt).toContain('"matchedPaths":"本次全部 typescript 变更文件"');
    expect(prompt).toContain('"matchedPaths":["src/payment.ts"]');
    for (const field of ["effectivePaths", "overriddenBy", '"file"', '"source"', '"status"']) expect(prompt).not.toContain(field);
  });

  it("Git 覆盖的不存在目标、非法方向和环分别告警", () => {
    const warnings: string[] = [];
    const rules = [rule("team", { layer: "team", overrides: ["general", "absent", "principle"] }),
      rule("general", { overrides: ["team"] }), rule("principle", { layer: "principle" })];
    expect(validOverrides(rules[0]!, rules, (message) => warnings.push(message))).toEqual([]);
    expect(warnings.some((message) => message.includes("成环"))).toBe(true);
    expect(warnings.some((message) => message.includes("不存在"))).toBe(true);
    expect(warnings.some((message) => message.includes("方向"))).toBe(true);
  });
});
