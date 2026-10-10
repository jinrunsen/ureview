import { describe, expect, it } from "vitest";
import { diffLineContent, evidenceTarget, findingCountsByPath, groupDiffFiles } from "./review-diff-data";
import type { FilePatch, ReviewFinding } from "./review-api";

const file: FilePatch = {
  oldPath: "inventory/release.ts", newPath: "inventory/release.ts", newFile: false, deletedFile: false, renamedFile: false,
  patch: "@@ -3,3 +3,3 @@\n function release() {\n-  restoreStock()\n+  restoreStockOnce()\n }\n",
};
const range = { path: file.newPath, startLine: 4, endLine: 4 };
const model = { vendor: "fixture", provider: "fixture", model: "fixture" };
const finding: ReviewFinding = {
  id: "finding-one", title: "释放缺少锁", description: "并发更新可能覆盖库存", severity: "high",
  location: range, anchor: { ...range, side: "new", fingerprint: "a".repeat(64) }, code: "restoreStockOnce()",
  evidence: [], fixPrompt: "释放前获取锁", ruleId: null, score: 88, generatorModel: model, graderModel: model,
  readFiles: [], generatedAt: "2026-10-06T00:00:00Z", status: "Pending",
};

describe("代码画布的文件分组与行内内容", () => {
  it("语义分组去掉重复和不存在的文件，并保留未分组的真实变更", () => {
    const extra = { ...file, oldPath: "inventory/check.ts", newPath: "inventory/check.ts" };
    const groups = groupDiffFiles([file, extra], [
      { name: "库存操作", files: [{ path: file.newPath, theme: "释放库存" }, { path: "missing.ts", theme: "不存在" }] },
      { name: "重复分组", files: [{ path: file.newPath, theme: "重复" }] },
    ]);
    expect(groups).toEqual([
      { name: "库存操作", files: [{ file, theme: "释放库存" }] },
      { name: "其他变更", files: [{ file: extra, theme: "" }] },
    ]);
  });
  it("重命名前的分组路径仍选中当前变更文件，无综述时展示全部文件", () => {
    const renamed = { ...file, newPath: "stock/release.ts", renamedFile: true };
    expect(groupDiffFiles([renamed], [{ name: "库存", files: [{ path: file.oldPath, theme: "移动释放逻辑" }] }])[0]?.files[0]?.file.newPath)
      .toBe("stock/release.ts");
    expect(groupDiffFiles([file], [])).toEqual([{ name: "变更文件", files: [{ file, theme: "" }] }]);
  });
  it("同一新侧代码行可以同时展示高危和引用定位", () => {
    const lines = diffLineContent(file, [finding], range);
    expect(lines.newFile[4]?.data).toEqual({ findings: [finding], location: range });
    expect(Object.keys(lines.newFile)).toEqual(["4"]);
  });
  it("中危与高危一样挂在锚定代码的末行之后，定位标记留在起始行", () => {
    const medium: ReviewFinding = { ...finding, id: "medium", severity: "medium", anchor: { ...finding.anchor!, startLine: 3, endLine: 4 } };
    const lines = diffLineContent(file, [medium], { ...range, startLine: 3, endLine: 4 });
    expect(lines.newFile[4]?.data.findings).toEqual([medium]);
    expect(lines.newFile[3]?.data).toEqual({ findings: [], location: { ...range, startLine: 3, endLine: 4 } });
  });
  it("过时、没有锚与平台片段以外的 finding 不挂在差异行上", () => {
    const outside = { ...finding, id: "outside", anchor: { ...finding.anchor!, startLine: 30, endLine: 30 } };
    expect(diffLineContent(file, [
      { ...finding, severity: "medium", anchor: null },
      { ...finding, id: "outdated", status: "Outdated" }, outside,
    ], null).newFile).toEqual({});
  });
  it("文件树按路径统计未过时的问题，并标出含高危的文件", () => {
    const counts = findingCountsByPath([
      finding, { ...finding, id: "medium", severity: "medium" },
      { ...finding, id: "elsewhere", severity: "medium", anchor: null, location: { path: "inventory/check.ts", startLine: 8, endLine: 9 } },
      { ...finding, id: "outdated", status: "Outdated", location: { path: "inventory/old.ts", startLine: 1, endLine: 1 }, anchor: null },
    ]);
    expect([...counts]).toEqual([[file.newPath, { count: 2, high: true }], ["inventory/check.ts", { count: 1, high: false }]]);
  });
  it("证据优先使用保存的代码，旧评审落在 finding 位置内的证据从 finding 代码截取", () => {
    const url = "https://gitlab.example.test/inventory/-/blob/a/inventory/release.ts#L4";
    const base = { ...finding, location: { ...range, startLine: 3, endLine: 5 }, code: "function release() {\n  restoreStockOnce()\n}" };
    expect(evidenceTarget(base, { ...range, description: "释放入口", url, code: "restoreStockOnce()" }))
      .toEqual({ ...range, url, code: "restoreStockOnce()" });
    expect(evidenceTarget(base, { ...range, description: "释放入口", url })).toEqual({ ...range, url, code: "  restoreStockOnce()" });
    expect(evidenceTarget(base, { path: "inventory/lock.ts", startLine: 2, endLine: 2, description: "锁实现", url }))
      .toEqual({ path: "inventory/lock.ts", startLine: 2, endLine: 2, url });
  });
  it("其他路径和缺失 hunk 的引用不吸附到相邻行", () => {
    expect(diffLineContent(file, [], { ...range, path: "elsewhere.ts" }).newFile).toEqual({});
    expect(diffLineContent(file, [], { ...range, startLine: 20, endLine: 20 }).newFile).toEqual({});
    expect(diffLineContent({ ...file, deletedFile: true }, [finding], range).newFile).toEqual({});
  });
});
