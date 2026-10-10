import type { CodeRange, FilePatch } from "./review-api";

export function anchorInPatch(file: FilePatch, anchor: CodeRange): boolean {
  if (file.deletedFile || file.newPath !== anchor.path) return false;
  // 平台片段以外的行没有渲染位置；不把缺失位置吸附到最近的差异行。
  return [...file.patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].some((match) => {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    return count > 0 && anchor.startLine >= start && anchor.endLine < start + count;
  });
}

export function patchForDiff(file: FilePatch): string {
  if (!file.patch.startsWith("@@")) return file.patch;
  // GitLab 文件 diff 只有 hunks；组件解析器还需要文件头，正文与行号保持原样。
  return `--- ${JSON.stringify(file.newFile ? "/dev/null" : `a/${file.oldPath}`)}\n+++ ${JSON.stringify(file.deletedFile ? "/dev/null" : `b/${file.newPath}`)}\n${file.patch}`;
}
