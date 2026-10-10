import { describe, expect, it } from "vitest";
import { createCodeAnchor } from "./anchors.js";
import { deriveReviewConclusion, selectVisibleFindings } from "./presentation.js";
import type { ReviewFinding } from "./types.js";

function finding(id: string, severity: ReviewFinding["severity"], score: number): ReviewFinding {
  return {
    id, title: `金额校验 ${id}`, description: "金额未校验", severity, score,
    location: { path: "internal/payment/settle.go", startLine: 3, endLine: 4 },
    evidence: [], fixPrompt: "校验金额", ruleId: null, generatedAt: "2026-10-03T00:00:00Z", code: "settle(amount)",
    generatorModel: { provider: "generator", model: "generator", vendor: "generator" },
    graderModel: { provider: "grader", model: "grader", vendor: "grader" }, readFiles: [], status: "Pending",
  };
}

describe("finding 展示与代码锚", () => {
  it("先按分数选五条，再按严重度分组；计数保留全部中高危，低危不占名额", () => {
    const output = selectVisibleFindings([
      finding("low", "low", 100), finding("high", "high", 40),
      ...[91, 83, 78, 65, 50].map((score, index) => finding(`medium-${index}`, "medium", score)),
      finding("critical", "high", 85),
    ]);
    expect(output.findings.map((item) => item.id)).toEqual(["critical", "medium-0", "medium-1", "medium-2", "medium-3"]);
    expect(output.findingCounts).toEqual({ high: 2, medium: 5 });
    expect(output.foldedCount).toBe(2);
  });

  it("同分使用严重度和代码位置稳定排序，不依赖数据库返回顺序", () => {
    const items = [finding("b", "medium", 88), finding("a", "high", 88), finding("c", "high", 88)];
    items[2]!.location.startLine = 10;
    expect(selectVisibleFindings(items).findings.map((item) => item.id)).toEqual(["a", "c", "b"]);
    expect(selectVisibleFindings([...items].reverse())).toEqual(selectVisibleFindings(items));
  });

  it("代码锚绑定实际片段指纹，高危与中危提供下钻位置，低危没有", () => {
    const high = finding("high", "high", 88);
    const anchor = createCodeAnchor(high, high.code);
    expect(anchor).toMatchObject({ ...high.location, side: "new" });
    expect(anchor?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createCodeAnchor(high, "different code")?.fingerprint).not.toBe(anchor?.fingerprint);
    expect(createCodeAnchor(finding("medium", "medium", 88), high.code)).toEqual(anchor);
    expect(createCodeAnchor(finding("low", "low", 88), high.code)).toBeNull();
  });
});

describe("评审结论", () => {
  it("展示高危时建议修改，并保留已采纳与已驳回的严重度条数", () => {
    const findings = [
      { ...finding("accepted", "high", 90), status: "Resolved" as const },
      { ...finding("dismissed", "medium", 90), status: "Dismissed" as const },
      { ...finding("outdated", "medium", 90), status: "Outdated" as const },
    ];
    expect(deriveReviewConclusion("completed", findings)).toEqual({
      status: "requires_changes", findingCounts: { high: 1, medium: 2 }, disposedCount: 2,
    });
  });

  it("只按展示项推出结论，折叠的高危不改变中危结论", () => {
    const output = selectVisibleFindings([
      finding("folded", "high", 40),
      ...Array.from({ length: 5 }, (_, index) => finding(`medium-${index}`, "medium", 90)),
    ]);
    expect(output.findingCounts).toEqual({ high: 1, medium: 5 });
    expect(deriveReviewConclusion("completed", output.findings)).toEqual({
      status: "manual_judgment", findingCounts: { high: 0, medium: 5 }, disposedCount: 0,
    });
  });

  it("没有展示高中危时明确为未发现高中危问题", () => {
    expect(deriveReviewConclusion("completed", selectVisibleFindings([finding("low", "low", 99)]).findings)).toEqual({
      status: "no_major_findings", findingCounts: { high: 0, medium: 0 }, disposedCount: 0,
    });
  });

  it.each(["queued", "running", "failed"] as const)("%s 轮次保留评审状态，忽略未完成的 finding", (status) => {
    expect(deriveReviewConclusion(status, [finding("partial", "high", 90)])).toEqual({
      status, findingCounts: { high: 0, medium: 0 }, disposedCount: 0,
    });
  });
});
