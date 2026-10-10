import { describe, expect, it } from "vitest";
import { makeMockFileGroups } from "../runtime/test-support.js";
import { parseFileGroups } from "./file-groups.js";
import { ReportRejection, type FilePatch } from "./types.js";

const file = (oldPath: string, newPath = oldPath, deletedFile = false): FilePatch => ({
  oldPath, newPath, deletedFile, newFile: false, renamedFile: oldPath !== newPath, patch: "",
});
const files = [file("src/order.ts"), file("src/previous.ts", "src/current.ts"), file("src/deleted.ts", "src/deleted.ts", true)];
const paths = ["src/order.ts", "src/current.ts", "src/deleted.ts"];

describe("文件分组协议", () => {
  it("按新路径与删除前路径覆盖本次变更", () => {
    const fileGroups = makeMockFileGroups(paths);
    expect(parseFileGroups({ fileGroups }, files)).toEqual(fileGroups);
  });

  it.each([
    ["分组不是数组", { fileGroups: "订单" }, "fileGroups", "必须是数组"],
    ["缺少分组", { fileGroups: [] }, "fileGroups", "必须覆盖本次全部变更文件"],
    ["分组为空", { fileGroups: [{ name: "订单", files: [] }] }, "fileGroups[0].files", "必须包含至少一个变更文件"],
    ["混入未改动的文件", { fileGroups: [{ name: "订单", files: [...paths, "unrelated.ts"].map((path) => ({ path, theme: "处理订单" })) }] }, "fileGroups[0].files[3].path", "必须引用本次变更文件"],
    ["遗漏已删除的文件", { fileGroups: [{ name: "订单", files: paths.slice(0, 2).map((path) => ({ path, theme: "处理订单" })) }] }, "fileGroups", "必须覆盖本次全部变更文件，缺少：src/deleted.ts"],
    ["文件被重复分组", { fileGroups: [{ name: "订单", files: [...paths, paths[0]].map((path) => ({ path, theme: "处理订单" })) }] }, "fileGroups[0].files[3].path", "每个变更文件只能出现一次"],
    ["分组名称重复", { fileGroups: paths.map((path) => ({ name: "订单", files: [{ path, theme: "处理订单" }] })) }, "fileGroups[1].name", "分组名称必须唯一"],
    ["分组缺少名称", { fileGroups: [{ name: " ", files: paths.map((path) => ({ path, theme: "处理订单" })) }] }, "fileGroups[0].name", "必须是非空字符串"],
    ["文件主题为空", { fileGroups: [{ name: "订单", files: paths.map((path) => ({ path, theme: " " })) }] }, "fileGroups[0].files[0].theme", "必须是非空字符串"],
  ])("%s时返回可修正的字段要求", (_description, input, field, requirement) => {
    const parse = () => parseFileGroups(input, files);
    expect(parse).toThrow(ReportRejection);
    expect(parse).toThrow(expect.objectContaining({
      code: "invalid_file_groups", message: expect.stringContaining(`${field}：${requirement}`),
    }));
  });

  it("参数不是对象时仍返回可修正的拒绝", () => {
    expect(() => parseFileGroups(null, files)).toThrow(ReportRejection);
    expect(() => parseFileGroups(null, files)).toThrow("report_file_groups：必须是对象");
  });

  it("纠错反馈保留字段位置，不回显被拒绝的任意参数", () => {
    const fileGroups = [{ name: "订单", files: [{ path: "PRIVATE_PARAMETER_SENTINEL", theme: "处理订单" }] }];
    expect(() => parseFileGroups({ fileGroups }, files)).toThrow(expect.objectContaining({
      message: "文件分组 fileGroups[0].files[0].path：必须引用本次变更文件；删除文件使用旧路径，其余文件使用新路径",
    }));
  });

  it("未改动文件的 PR 使用空分组", () => {
    expect(parseFileGroups({ fileGroups: [] }, [])).toEqual([]);
  });
});
