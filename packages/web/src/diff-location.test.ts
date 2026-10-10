import { describe, expect, it } from "vitest";
import { DiffFile, SplitSide } from "@git-diff-view/react";
import { anchorInPatch, patchForDiff } from "./diff-location";
import type { FilePatch, FindingAnchor } from "./review-api";

const patch = "@@ -3,3 +3,3 @@\n func ReleaseInventory(orderID string) {\n-  lockInventory(orderID)\n+  restoreStock(orderID)\n }\n";
const file: FilePatch = { oldPath: "internal/inventory/release.go", newPath: "internal/inventory/release.go", patch, newFile: false, renamedFile: false, deletedFile: false };
const anchor: FindingAnchor = { path: file.newPath, side: "new", startLine: 4, endLine: 4, fingerprint: "a".repeat(64) };

describe("平台差异中的代码位置", () => {
  it("成熟组件从平台 hunk 读取新侧行号和代码，不使用文件全文重算差异", () => {
    const diff = new DiffFile(file.oldPath, "", file.newPath, "", [patchForDiff(file)]);
    try {
      diff.initRaw(); diff.buildSplitDiffLines(); diff.buildUnifiedDiffLines();
      expect(diff.getUnifiedLineByLineNumber(4, SplitSide.new).newLineNumber).toBe(4);
      expect(diff.getNewPlainLine(4).value).toBe("  restoreStock(orderID)\n");
    } finally { diff.clear(); }
  });
  it("锚范围必须完整落在平台新侧的同一片段中", () => {
    expect(anchorInPatch(file, anchor)).toBe(true);
    expect(anchorInPatch(file, { ...anchor, startLine: 2 })).toBe(false);
    expect(anchorInPatch(file, { ...anchor, endLine: 6 })).toBe(false);
    expect(anchorInPatch(file, { ...anchor, startLine: 40, endLine: 40 })).toBe(false);
  });
  it("删除、纯删行和重命名前的路径不能被当成新侧锚点", () => {
    expect(anchorInPatch({ ...file, deletedFile: true }, anchor)).toBe(false);
    expect(anchorInPatch({ ...file, patch: "@@ -4 +4,0 @@\n-old\n" }, anchor)).toBe(false);
    expect(anchorInPatch({ ...file, newPath: "internal/stock/release.go", renamedFile: true }, anchor)).toBe(false);
    expect(anchorInPatch({ ...file, patch: "@@ -4 +4 @@\n-old\n+new\n" }, anchor)).toBe(true);
  });
});
