#!/usr/bin/env tsx
// 校验 Agent Notes 的路径编码与文件头。
//
// 路径本身承载了生命周期与类别两个维度，走错目录就等于状态记错了，
// 而这件事没有任何东西会报错——笔记照样能读，只是分类是假的。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NOTE_CLASSES, NOTE_LIFECYCLES } from "./agent-note-tree.js";

const NOTES_DIR = ".agents/notes";
const FILENAME = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

const problems: string[] = [];

for (const lifecycle of await readdir(NOTES_DIR, { withFileTypes: true })) {
  if (!lifecycle.isDirectory()) continue;
  if (!(NOTE_LIFECYCLES as readonly string[]).includes(lifecycle.name)) {
    problems.push(`${lifecycle.name}/ 不是合法的生命周期目录`);
    continue;
  }
  const lifecycleDir = join(NOTES_DIR, lifecycle.name);

  for (const cls of await readdir(lifecycleDir, { withFileTypes: true })) {
    if (!cls.isDirectory()) continue;
    if (!(NOTE_CLASSES as readonly string[]).includes(cls.name)) {
      problems.push(`${lifecycle.name}/${cls.name}/ 不是合法的类别`);
      continue;
    }

    for (const file of await readdir(join(lifecycleDir, cls.name))) {
      const where = `${lifecycle.name}/${cls.name}/${file}`;
      if (!FILENAME.test(file)) {
        problems.push(`${where} 的文件名不是 yyyy-mm-dd-英文小写短横线.md`);
        continue;
      }
      const body = await readFile(join(lifecycleDir, cls.name, file), "utf8");
      if (!body.startsWith("# Agent Note: ")) {
        problems.push(`${where} 的第一行不是 "# Agent Note: 标题"`);
      }
      const status = /^Status: (\w+)$/m.exec(body)?.[1];
      if (status !== lifecycle.name) {
        problems.push(`${where} 的 Status 是 ${status ?? "（缺）"}，与所在目录 ${lifecycle.name} 不一致`);
      }
      if (lifecycle.name === "archived" && !/^Archived: \d{4}-\d{2}-\d{2}$/m.test(body)) {
        problems.push(`${where} 在冻结树里但没有 Archived: 日期`);
      }
    }
  }
}

const counts = new Map<string, number>();
for (const lifecycle of NOTE_LIFECYCLES) {
  let n = 0;
  for (const cls of NOTE_CLASSES) {
    n += await readdir(join(NOTES_DIR, lifecycle, cls)).then((f) => f.length).catch(() => 0);
  }
  if (n > 0) counts.set(lifecycle, n);
}
console.log(`  Agent Notes：${[...counts].map(([k, v]) => `${k} ${v}`).join("、")}`);

if (problems.length > 0) {
  console.error("\nAgent Note 校验不通过：");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log("  Agent Note 校验通过：路径编码与文件头一致");
