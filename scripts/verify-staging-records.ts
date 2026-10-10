#!/usr/bin/env tsx
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateStagingRecord(filename: string, content: string): string[] {
  const story = filename.replaceAll("\\", "/").match(/\/(\d+)-[^/]+\/tickets\/[^/]+\.md$/);
  if (!story || Number(story[1]) < 25 || !/^Status: completed\s*$/m.test(content)) return [];
  const sections = [...content.matchAll(/^## 预发验证（\d{4}-\d{2}-\d{2}）\s*$/gm)];
  const last = sections.at(-1);
  if (!last) return [`${filename}：缺少预发验证（YYYY-MM-DD）一节`];
  const section = content.slice(last.index! + last[0].length).split(/^## /m)[0]!;
  const verdict = section.match(/^- 结论：[ \t]*(.*)$/m)?.[1]?.trim();
  if (!verdict || !/^(通过|不适用)/.test(verdict)) return [`${filename}：最后一节缺少有效的结论（通过或不适用）`];
  if (verdict.startsWith("不适用")) return [];
  return ["版本", "流程", "截图", "问题"].filter((label) => !new RegExp(`^- ${label}：`, "m").test(section))
    .map((label) => `${filename}：最后一节缺少「- ${label}：」行`);
}

export async function validateStagingDirectory(directory: string): Promise<string[]> {
  const problems: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) problems.push(...await validateStagingDirectory(filename));
    else if (entry.name.endsWith(".md")) problems.push(...validateStagingRecord(filename, await readFile(filename, "utf8")));
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const problems = await validateStagingDirectory(resolve(process.argv[2] ?? "requirements"));
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    process.exitCode = 1;
  } else console.log("预发验证记录检查通过。");
}
