import { describe, expect, it } from "vitest";
import { validateStagingRecord } from "./verify-staging-records.js";

const filename = "requirements/project/25-import/tickets/01-upload.md";
const header = "Status: completed\n\n## 预发验证（2026-10-09）\n\n";
const passed = "- 版本：abc\n- 流程：上传\n- 截图：截图目录\n- 问题：无\n- 结论：通过\n";

describe("预发验证记录闸门", () => {
  it("完成工单缺少验证节时指出文件", () => {
    expect(validateStagingRecord(filename, "Status: completed")).toEqual([`${filename}：缺少预发验证（YYYY-MM-DD）一节`]);
  });
  it.each(["版本", "流程", "截图", "问题"])("通过记录缺少%s时失败", (label) => {
    const content = (header + passed).replace(new RegExp(`^- ${label}：.*\\n`, "m"), "");
    expect(validateStagingRecord(filename, content)).toEqual([`${filename}：最后一节缺少「- ${label}：」行`]);
  });
  it("缺少结论时失败", () => {
    expect(validateStagingRecord(filename, header + passed.replace("- 结论：通过\n", ""))).toHaveLength(1);
  });
  it("以最后一节为准，最后一次失败不能沿用通过", () => {
    expect(validateStagingRecord(filename, header + passed + "\n## 预发验证（2026-10-10）\n- 结论：未通过")).toHaveLength(1);
  });
  it("不适用只需要结论", () => {
    expect(validateStagingRecord(filename, header + "- 结论：不适用，纯工具脚本")).toEqual([]);
  });
  it("Story 24 及以前不检查", () => {
    expect(validateStagingRecord(filename.replace("25-import", "24-reading"), "Status: completed")).toEqual([]);
  });
  it("未完成工单不检查", () => {
    expect(validateStagingRecord(filename, "Status: in-progress")).toEqual([]);
  });
  it("完整记录通过，下一节不能补齐缺失标签", () => {
    expect(validateStagingRecord(filename, header + passed)).toEqual([]);
    expect(validateStagingRecord(filename, header + "- 结论：通过\n## 其他\n" + passed)).toHaveLength(4);
  });
});
