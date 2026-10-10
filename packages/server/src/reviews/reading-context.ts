import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { isExcludedPath } from "./exclusions.js";
import { ReviewError, type FilePatch } from "./types.js";

export async function discoverArchitectureCandidates(
  cwd: string, files: readonly FilePatch[], excludedDirectories: readonly string[] = [],
): Promise<string[]> {
  const root = await realpath(cwd).catch(() => { throw new ReviewError("workspace_read_failed", "评审工作副本读取失败"); });
  const excluded = (path: string) => path.split("/").includes(".git") || isExcludedPath(path, excludedDirectories);
  const safePath = (path: string) => path.length > 0 && !isAbsolute(path) && !/[\\\x00-\x1f\x7f]/.test(path)
    && !path.split("/").some((part) => !part || part === "." || part === "..");
  const existingPath = async (path: string): Promise<string | null> => {
    if (!safePath(path) || excluded(path)) return null;
    try {
      const target = await realpath(resolve(root, path));
      const inside = relative(root, target).split(sep).join("/");
      return safePath(inside) && !excluded(inside) ? target : null;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && ["ENOENT", "ENOTDIR", "ELOOP"].includes(String(error.code))) return null;
      throw new ReviewError("workspace_read_failed", "架构候选文档读取失败");
    }
  };

  const candidates = new Set(["AGENTS.md", "CLAUDE.md", "README.md", "ARCHITECTURE.md"]);
  const docs = await existingPath("docs");
  if (docs && (await stat(docs)).isDirectory()) {
    for (const name of await readdir(docs)) {
      if (/^architecture.*\.md$/.test(name)) candidates.add(`docs/${name}`);
    }
  }
  for (const file of files) {
    if (!safePath(file.oldPath) || !safePath(file.newPath) || excluded(file.oldPath) || excluded(file.newPath)) continue;
    for (const path of [file.oldPath, file.newPath]) {
      for (let directory = posix.dirname(path); directory !== "."; directory = posix.dirname(directory)) {
        candidates.add(`${directory}/AGENTS.md`);
      }
    }
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const path of [...candidates].sort()) {
    const target = await existingPath(path);
    if (target && !seen.has(target) && (await stat(target)).isFile()) {
      seen.add(target);
      result.push(path);
    }
  }
  return result;
}
