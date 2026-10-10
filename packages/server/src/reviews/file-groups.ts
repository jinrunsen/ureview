import { ReportRejection, type FilePatch } from "./types.js";

/** 代码文件树用的语义分组：每个 diff 文件恰好出现在一个有名字的分组中，并带一句话主题。 */
export interface FileGroup {
  name: string;
  files: Array<{ path: string; theme: string }>;
}

function invalid(field: string, requirement: string): never {
  throw new ReportRejection("invalid_file_groups", `文件分组 ${field}：${requirement}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field, "必须是对象");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(field, "必须是非空字符串");
  return value.trim();
}

function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field, "必须是数组");
  return value;
}

export function parseFileGroups(value: unknown, files: FilePatch[]): FileGroup[] {
  const input = object(value, "report_file_groups");
  const expected = new Set(files.map((file) => file.deletedFile ? file.oldPath : file.newPath));
  const covered = new Set<string>();
  const names = new Set<string>();
  const groups = list(input.fileGroups, "fileGroups").map((entry, groupIndex) => {
    const field = `fileGroups[${groupIndex}]`;
    const group = object(entry, field);
    const name = text(group.name, `${field}.name`);
    if (names.has(name)) invalid(`${field}.name`, "分组名称必须唯一");
    names.add(name);
    const groupedFiles = list(group.files, `${field}.files`).map((entry, fileIndex) => {
      const fileField = `${field}.files[${fileIndex}]`;
      const file = object(entry, fileField);
      const path = file.path;
      if (typeof path !== "string") invalid(`${fileField}.path`, "必须是本次变更文件的路径字符串");
      if (!expected.has(path)) invalid(`${fileField}.path`, "必须引用本次变更文件；删除文件使用旧路径，其余文件使用新路径");
      if (covered.has(path)) invalid(`${fileField}.path`, "每个变更文件只能出现一次");
      covered.add(path);
      return { path, theme: text(file.theme, `${fileField}.theme`) };
    });
    if (!groupedFiles.length) invalid(`${field}.files`, "必须包含至少一个变更文件");
    return { name, files: groupedFiles };
  });
  if (covered.size !== expected.size) {
    const missing = [...expected].filter((path) => !covered.has(path));
    invalid("fileGroups", `必须覆盖本次全部变更文件，缺少：${missing.join("、")}`);
  }
  return groups;
}
