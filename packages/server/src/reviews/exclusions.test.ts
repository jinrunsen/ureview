import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filterReviewFiles, isExcludedPath, normalizeExcludedDirectories, pruneReviewWorkspace } from "./exclusions.js";
import type { FilePatch } from "./types.js";

describe("评审排除目录", () => {
  it("规范化相对目录并按完整路径段匹配", () => {
    const paths = normalizeExcludedDirectories([" ./features/steps/ ", "features/steps", ".agents/rules"]);
    expect(paths).toEqual(["features/steps", ".agents/rules"]);
    for (const path of ["features/steps", "features/steps/payment.ts", "features/steps/helper/refund.ts"]) expect(isExcludedPath(path, paths)).toBe(true);
    for (const path of ["features/steps-extra/payment.ts", "src/features/steps/payment.ts", "features"]) expect(isExcludedPath(path, paths)).toBe(false);
    expect(normalizeExcludedDirectories([])).toEqual([]);
  });

  it.each(["", ".", "./", "..", "../steps", "features/../steps", "/features/steps", "C:/steps", "~/.ssh", "features\\steps", "features/**", "!features", "features/[ab]", "features/\nsteps", "features/steps\n", "\tfeatures/steps", "features//steps", "a".repeat(513)])("拒绝非目录输入 %s", (path) => {
    expect(() => normalizeExcludedDirectories([path])).toThrow(expect.objectContaining({ code: "invalid_excluded_directories" }));
  });

  it("限制目录列表类型和数量", () => {
    for (const value of [null, "features/steps", [1], Array.from({ length: 101 }, (_, index) => `tests/${index}`)]) {
      expect(() => normalizeExcludedDirectories(value)).toThrow();
    }
  });

  it("重命名任一侧命中时排除整份差异，保留相邻目录", () => {
    const file = (oldPath: string, newPath = oldPath): FilePatch => ({ oldPath, newPath, patch: "excluded code", newFile: false, deletedFile: false, renamedFile: oldPath !== newPath });
    const allowed = file("features/steps-extra/payment.ts");
    expect(filterReviewFiles([file("features/steps/payment.ts"), file("features/steps/payment.ts", "src/payment.ts"), file("src/refund.ts", "features/steps/refund.ts"), allowed], ["features/steps"])).toEqual([allowed]);
  });

  it("只裁剪临时工作副本的排除子树及 Git 元数据，父目录符号链接不会被跟随", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ureview-exclusions-"));
    try {
      const cwd = join(directory, "checkout");
      await mkdir(join(cwd, "features/steps/helpers"), { recursive: true });
      await mkdir(join(cwd, "features/steps-extra"), { recursive: true });
      await mkdir(join(cwd, ".git/objects"), { recursive: true });
      await mkdir(join(directory, "outside/steps"), { recursive: true });
      await writeFile(join(cwd, "features/steps/helpers/payment.ts"), "excluded");
      await writeFile(join(cwd, "features/steps-extra/payment.ts"), "allowed");
      await writeFile(join(directory, "outside/steps/payment.ts"), "outside");
      await symlink(join(directory, "outside"), join(cwd, "linked"), "dir");
      await pruneReviewWorkspace(cwd, ["features/steps", "linked/steps", "missing"]);
      await expect(readFile(join(cwd, "features/steps/helpers/payment.ts"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(cwd, ".git/objects"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(cwd, "features/steps-extra/payment.ts"), "utf8")).toBe("allowed");
      expect(await readFile(join(directory, "outside/steps/payment.ts"), "utf8")).toBe("outside");
      await expect(pruneReviewWorkspace(cwd, ["../outside"])).rejects.toMatchObject({ code: "invalid_review_scope" });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
