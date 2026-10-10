import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { isExcludedPath } from "../reviews/exclusions.js";

// dsh 的 read-only 禁写但不限制读取；最终工具 guard 在工具执行前校验真实路径。
export function restrictWorkspaceReads(ctx: Context, cwd: string, excludedDirectories: readonly string[] = []): void {
  const root = realpathSync(cwd);
  const excluded = (part: string) => part.split(sep).includes(".git") || isExcludedPath(part.split(sep).join("/"), excludedDirectories);
  ctx.tools.guard((execution) => {
    if (!["read", "grep", "glob"].includes(execution.name)) return undefined;
    const args = execution.arguments as Record<string, unknown>;
    const path = args[execution.name === "read" ? "file_path" : "path"] ?? ".";
    if (typeof path !== "string" || path.startsWith("~") || path.includes("\0")) {
      return "只能读取本次评审的工作副本";
    }
    try {
      if (excluded(relative(cwd, resolve(cwd, path)))) return "该路径已从本轮评审中排除";
      const target = realpathSync(resolve(cwd, path));
      const part = relative(root, target);
      if (part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part)) {
        return "只能读取本次评审的工作副本";
      }
      if (excluded(part)) return "该路径已从本轮评审中排除";
    } catch {
      return "无法读取该工作副本路径";
    }
    return undefined;
  });
}
