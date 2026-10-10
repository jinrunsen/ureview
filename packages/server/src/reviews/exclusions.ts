import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { ReviewError, type FilePatch } from "./types.js";

function invalid(): never {
  throw new ReviewError("invalid_excluded_directories", "请填写仓库根目录下的相对目录，每项不超过 512 个字符，最多 100 项；不支持通配符或上级路径");
}

export function normalizeExcludedDirectories(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 100) invalid();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || /[\x00-\x1f\x7f]/.test(entry)) invalid();
    let path = entry.trim();
    if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path) || /[\\\x00-\x1f\x7f*?{}\[\]!]/.test(path)) invalid();
    while (path.startsWith("./")) path = path.slice(2);
    path = path.replace(/\/+$/, "");
    if (!path || path.length > 512 || path.split("/").some((part) => !part || part === "." || part === "..")) invalid();
    result.push(path);
  }
  return [...new Set(result)];
}

export function isExcludedPath(path: string, excludedDirectories: readonly string[]): boolean {
  return excludedDirectories.some((directory) => path === directory || path.startsWith(`${directory}/`));
}

export function filterReviewFiles(files: FilePatch[], excludedDirectories: readonly string[]): FilePatch[] {
  return files.filter((file) => !isExcludedPath(file.oldPath, excludedDirectories) && !isExcludedPath(file.newPath, excludedDirectories));
}

// 只用于每轮独立的临时 checkout；搜索工具直接读盘，因此排除内容必须在启动 agent 前移走。
export async function pruneReviewWorkspace(cwd: string, excludedPaths: readonly string[]): Promise<void> {
  const root = await realpath(cwd);
  for (const path of new Set([".git", ...excludedPaths])) {
    if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new ReviewError("invalid_review_scope", "评审排除路径无效");
    }
    const parts = path.split("/");
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") break;
        throw error;
      }
      if (index < parts.length - 1) {
        if (info.isSymbolicLink() || !info.isDirectory()) break;
        continue;
      }
      const inside = relative(root, current);
      if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new ReviewError("invalid_review_scope", "评审排除路径无效");
      await rm(current, { recursive: true, force: true });
    }
  }
}
