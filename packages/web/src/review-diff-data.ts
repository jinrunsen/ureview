import { anchorInPatch } from "./diff-location";
import type { CodeRange, CodeTarget, FilePatch, FileGroup, ReviewFinding } from "./review-api";

export interface DiffLineContent {
  findings: ReviewFinding[];
  location: CodeRange | null;
}
export interface DiffFileGroup { name: string; files: Array<{ file: FilePatch; theme: string }> }

export function groupDiffFiles(files: FilePatch[], groups: FileGroup[]): DiffFileGroup[] {
  const remaining = new Set(files);
  const result: DiffFileGroup[] = [];
  for (const group of groups) {
    const entries: DiffFileGroup["files"] = [];
    for (const entry of group.files) {
      const file = files.find((item) => item.newPath === entry.path || item.oldPath === entry.path);
      if (!file || !remaining.delete(file)) continue;
      entries.push({ file, theme: entry.theme });
    }
    if (entries.length > 0) result.push({ name: group.name, files: entries });
  }
  if (remaining.size > 0) result.push({
    name: result.length === 0 ? "变更文件" : "其他变更",
    files: [...remaining].map((file) => ({ file, theme: "" })),
  });
  return result;
}

/** finding 在代码画布上的位置：有锚用锚，旧数据没有锚时用评审时的位置。 */
export function findingTarget(finding: ReviewFinding): CodeRange {
  return finding.anchor ?? finding.location;
}

/** 未过时、有锚且整段落在同一个平台片段内的 finding 挂在差异行上，其余显示评审时读取的代码。 */
export function placedInPatch(file: FilePatch | undefined, finding: ReviewFinding): boolean {
  return !!file && finding.status !== "Outdated" && !!finding.anchor && anchorInPatch(file, finding.anchor);
}

/** 定位标记放在起始行；finding 卡片放在末行之后，读者先看到它指的整段代码。 */
export function diffLineContent(file: FilePatch, findings: ReviewFinding[], location: CodeRange | null) {
  const newFile: Record<number, { data: DiffLineContent }> = {};
  const at = (line: number) => (newFile[line] ??= { data: { findings: [], location: null } }).data;
  for (const finding of findings) {
    if (placedInPatch(file, finding)) at(finding.anchor!.endLine).findings.push(finding);
  }
  if (location && anchorInPatch(file, location)) at(location.startLine).location = location;
  return { newFile };
}

/** 每个路径上未过时的 finding 数量，以及其中是否有高危。 */
export function findingCountsByPath(findings: ReviewFinding[]): Map<string, { count: number; high: boolean }> {
  const counts = new Map<string, { count: number; high: boolean }>();
  for (const finding of findings) {
    if (finding.status === "Outdated") continue;
    const { path } = findingTarget(finding);
    const current = counts.get(path) ?? { count: 0, high: false };
    counts.set(path, { count: current.count + 1, high: current.high || finding.severity === "high" });
  }
  return counts;
}

/** 证据的页内定位目标。旧评审的证据没有保存代码，落在 finding 位置内时从 finding 代码截取。 */
export function evidenceTarget(finding: ReviewFinding, evidence: ReviewFinding["evidence"][number]): CodeTarget {
  const { path, startLine, endLine, url } = evidence;
  const { location } = finding;
  const code = evidence.code ?? (path === location.path && startLine >= location.startLine && endLine <= location.endLine
    ? finding.code.split("\n").slice(startLine - location.startLine, endLine - location.startLine + 1).join("\n") : undefined);
  return code === undefined ? { path, startLine, endLine, url } : { path, startLine, endLine, url, code };
}
