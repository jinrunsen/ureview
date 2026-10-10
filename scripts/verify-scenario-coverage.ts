#!/usr/bin/env tsx
// 校验每条场景恰好被一张实现工单认领：不缺、不重、不错名。
//
// 场景没有票认领就永远不会被实现，而这件事不会有任何东西报错——
// 它只是静悄悄地不存在。工单里写错一个字，实现阶段那条选择表达式
// 就选不中，同样静悄悄。所以这条要机械校验。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const FEATURES_DIR = "features";
const TICKETS_DIR = ".scratch/ureview/tickets";
const TESTING_DOC = "docs/testing.md";

async function requirementTickets(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const child = join(directory, entry.name);
    if (entry.name === "tickets") {
      files.push(...(await readdir(child)).filter((name) => /^\d\d-.*\.md$/.test(name)).map((name) => join(child, name)));
    } else {
      files.push(...await requirementTickets(child));
    }
  }
  return files;
}

/** 读出每个 .feature 里的场景名，以及哪些是 bvt+main。 */
async function readScenarios() {
  const byFeature = new Map();
  for (const file of (await readdir(FEATURES_DIR)).filter((n) => n.endsWith(".feature"))) {
    const scenarios = [];
    let tags = "";
    for (const line of (await readFile(join(FEATURES_DIR, file), "utf8")).split("\n")) {
      if (line.includes("@level:")) tags = line;
      const match = /^\s*Scenario:\s*(.+?)\s*$/.exec(line);
      if (match) {
        scenarios.push({
          name: match[1],
          isMainline: tags.includes("bvt") && tags.includes("spec:main"),
        });
      }
    }
    byFeature.set(file, scenarios);
  }
  return byFeature;
}

/** 解析一张工单的 Scenarios 段，返回它认领了哪些场景名。 */
function resolveSelection(line, scenarios) {
  const quoted = [...line.matchAll(/「(.+?)」/g)].map((m) => m[1]);
  if (quoted.length > 0) return quoted;
  if (line.includes("除 `@level:bvt and @spec:main` 外")) {
    return scenarios.filter((s) => !s.isMainline).map((s) => s.name);
  }
  if (line.includes("`@level:bvt and @spec:main`")) {
    return scenarios.filter((s) => s.isMainline).map((s) => s.name);
  }
  return scenarios.map((s) => s.name); // 全部场景
}

async function readClaims(byFeature) {
  const claims = new Map(); // feature -> [{ name, ticket }]
  const tickets = [
    ...(await readdir(TICKETS_DIR)).filter((name) => /^\d\d-/.test(name)).map((name) => join(TICKETS_DIR, name)),
    ...await requirementTickets("requirements"),
  ];
  for (const file of tickets) {
    const body = await readFile(file, "utf8");
    for (const section of body.matchAll(/^\*\*Scenarios:\*\* (.+)$/gm)) {
      const featureName = /features\/([\w-]+\.feature)/.exec(section[1]);
      if (!featureName) {
        throw new Error(`工单 ${file} 的 Scenarios 段没有指向任何 .feature`);
      }
      const feature = featureName[1];
      const scenarios = byFeature.get(feature);
      if (!scenarios) throw new Error(`工单 ${file} 指向了不存在的 ${feature}`);
      const list = claims.get(feature) ?? [];
      for (const name of resolveSelection(section[1], scenarios)) {
        list.push({ name, ticket: file });
      }
      claims.set(feature, list);
    }
  }
  return claims;
}

/**
 * 读规格里声明的每个 feature 的场景数。
 *
 * 认领本身挡不住往「全部场景」的 feature 里偷偷加一条——那个选择器会
 * 自动把新场景吸收进去。所以再要一个显式声明的数：加了场景就得同时改
 * 规格的场景路径表，改了就会被看见。
 */
async function readDeclaredCounts() {
  const counts = new Map();
  for (const line of (await readFile(TESTING_DOC, "utf8")).split("\n")) {
    const row = /\|\s*`features\/([\w-]+\.feature)`\s*\|[^|]*\|\s*(\d+)\s*\|/.exec(line);
    if (row) counts.set(row[1], (counts.get(row[1]) ?? 0) + Number(row[2]));
  }
  return counts;
}

const byFeature = await readScenarios();
const declared = await readDeclaredCounts();
const claims = await readClaims(byFeature);
const problems = [];

for (const [feature, scenarios] of [...byFeature].sort()) {
  const claimed = claims.get(feature) ?? [];
  const real = new Set(scenarios.map((s) => s.name));

  for (const { name, ticket } of claimed) {
    if (!real.has(name)) problems.push(`票 ${ticket} 点名的场景不存在于 ${feature}：${name}`);
  }
  const counts = new Map();
  for (const { name } of claimed) counts.set(name, (counts.get(name) ?? 0) + 1);
  for (const [name, count] of counts) {
    if (count > 1) problems.push(`场景被 ${count} 张票重复认领：${feature} / ${name}`);
  }
  for (const name of real) {
    if (!claimed.some((c) => c.name === name)) {
      problems.push(`场景无票认领：${feature} / ${name}`);
    }
  }
  console.log(`  ${feature.padEnd(34)} ${String(scenarios.length).padStart(2)} 条，认领 ${String(claimed.length).padStart(2)} 条`);
}

for (const [feature, scenarios] of byFeature) {
  const expected = declared.get(feature);
  if (expected === undefined) {
    problems.push(`${feature} 没有出现在 ${TESTING_DOC} 的场景路径表里`);
  } else if (expected !== scenarios.length) {
    problems.push(
      `${feature} 实际 ${scenarios.length} 条场景，规格声明 ${expected} 条——` +
        `加减场景要同时改工单与 docs/testing.md 的场景路径表`,
    );
  }
}

const total = [...byFeature.values()].reduce((n, s) => n + s.length, 0);
console.log(`\n场景总数 ${total}，被认领 ${[...claims.values()].reduce((n, c) => n + c.length, 0)}`);

if (problems.length > 0) {
  console.error("\n场景认领校验不通过：");
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  process.exit(1);
}
console.log("场景认领校验通过：无缺漏、无重复、无错名");
