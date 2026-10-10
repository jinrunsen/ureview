import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverArchitectureCandidates } from "./reading-context.js";
import type { FilePatch } from "./types.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });

async function workspace(paths: string[] = []): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "ureview-reading-context-"));
  directories.push(cwd);
  for (const path of paths) {
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), "架构依据\n");
  }
  return cwd;
}

function file(newPath: string, oldPath = newPath): FilePatch {
  return { newPath, oldPath, patch: "", newFile: false, deletedFile: false, renamedFile: oldPath !== newPath };
}

describe("解读架构依据发现", () => {
  it("按规格发现根目录文档、直属架构文档和改动路径的各级 AGENTS，排序并去重", async () => {
    const expected = ["AGENTS.md", "ARCHITECTURE.md", "CLAUDE.md", "README.md", "docs/architecture-runtime.md", "docs/architecture.md",
      "old/AGENTS.md", "src/AGENTS.md", "src/api/AGENTS.md"];
    const cwd = await workspace([...expected, "docs/ARCHITECTURE.md", "docs/nested/architecture.md", "docs/testing.md",
      "unrelated/AGENTS.md", "src/README.md", "src/api/value.ts"]);
    expect(await discoverArchitectureCandidates(cwd, [file("src/api/value.ts", "old/value.ts"), file("src/api/other.ts")])).toEqual(expected);
  });

  it("没有候选文档时返回空列表，目录不能冒充文档", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, "README.md"));
    await mkdir(join(cwd, "docs/architecture.md"), { recursive: true });
    expect(await discoverArchitectureCandidates(cwd, [file("src/value.ts")])).toEqual([]);
  });

  it("仓内符号链接按真实文件去重，支持工作副本根目录本身是符号链接", async () => {
    const cwd = await workspace(["AGENTS.md"]);
    await symlink("AGENTS.md", join(cwd, "CLAUDE.md"));
    const parent = await workspace();
    await symlink(cwd, join(parent, "checkout"));
    expect(await discoverArchitectureCandidates(join(parent, "checkout"), [])).toEqual(["AGENTS.md"]);
  });

  it("排除目录及其符号链接不提供候选，重命名任意一侧被排除时不扫描两侧上级", async () => {
    const cwd = await workspace(["AGENTS.md", "docs/architecture.md", "private/AGENTS.md", "src/AGENTS.md", "private/spec.md"]);
    await symlink("private/spec.md", join(cwd, "README.md"));
    await symlink("private", join(cwd, "alias"));
    expect(await discoverArchitectureCandidates(cwd, [file("alias/file.ts"), file("src/file.ts", "private/file.ts")], ["private", "docs"]))
      .toEqual(["AGENTS.md"]);
  });

  it("越界、Git 元数据和循环符号链接不能作为候选文档", async () => {
    const outside = await workspace(["architecture.md", "AGENTS.md"]);
    const cwd = await workspace([".git/AGENTS.md"]);
    await symlink(outside, join(cwd, "docs"));
    await symlink(join(outside, "AGENTS.md"), join(cwd, "AGENTS.md"));
    await symlink(".git/AGENTS.md", join(cwd, "CLAUDE.md"));
    await symlink("README.md", join(cwd, "README.md"));
    expect(await discoverArchitectureCandidates(cwd, [file("../outside/file.ts"), file("/outside/file.ts"), file(".git/config")])).toEqual([]);
  });
});
