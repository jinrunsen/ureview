import { describe, expect, it } from "vitest";
import { repairMarkdown } from "./fix-prompts";
import type { ReviewFinding } from "./review-api";

function finding(path: string, line: number, title: string, status: ReviewFinding["status"]): ReviewFinding {
  return { id: title, title, description: `${title}的影响`, severity: "high", location: { path, startLine: line, endLine: line + 1 },
    anchor: null, code: "", evidence: [], fixPrompt: `${title}的修复方法`, ruleId: null, score: 90,
    generatorModel: { vendor: "deepseek", provider: "generator", model: "deepseek-chat" },
    graderModel: { vendor: "anthropic", provider: "grader", model: "claude" }, readFiles: [], generatedAt: "2026-10-06T00:00:00Z", status };
}
describe("修复提示词 Markdown", () => {
  it("按文件和数值行号排序，包含标题描述提示词并排除驳回项", () => {
    const output = repairMarkdown("修复库存释放", [
      finding("stock/release.ts", 48, "释放缺少锁", "Resolved"), finding("order/cancel.ts", 12, "取消未检查状态", "Pending"),
      finding("stock/release.ts", 7, "库存可以为负", "Pending"), finding("stock/release.ts", 1, "调用方已校验", "Dismissed"),
    ]);
    expect(output).toContain("# 修复库存释放");
    expect(output).not.toContain("调用方已校验");
    expect(output.indexOf("取消未检查状态")).toBeLessThan(output.indexOf("库存可以为负"));
    expect(output.indexOf("库存可以为负")).toBeLessThan(output.indexOf("释放缺少锁"));
    expect(output).toContain("stock/release.ts:48–49\n\n释放缺少锁的影响\n\n### 修复提示词\n\n释放缺少锁的修复方法");
  });
});
