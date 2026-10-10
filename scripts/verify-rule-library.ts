#!/usr/bin/env tsx
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ruleCategories, ruleSeverities } from "../packages/server/src/rules/managed-types.js";

const layers = ["principle", "general", "language", "team"];
const languages = ["c", "cpp", "go", "java", "python", "javascript", "typescript", "rust", "shell", "sql", "kotlin"];
const licenseTiers = ["original", "open", "internal", "copyrighted", "restricted"];
const inclusionKinds = ["publication", "community", "longevity", "adoption"];
const defaultDirectory = fileURLToPath(new URL("../packages/server/rule-library", import.meta.url));

interface LibraryFile {
  filename: string;
  value: unknown;
}

interface ValidationResult {
  problems: string[];
  setCount: number;
  entryCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateRuleLibrary(files: readonly LibraryFile[]): ValidationResult {
  const problems: string[] = [];
  const ids = new Map<string, string>();
  let entryCount = 0;
  const problem = (path: string, message: string) => { problems.push(`${path}：${message}`); };
  const record = (value: unknown, path: string) => {
    if (isRecord(value)) return value;
    problem(path, "必须是对象");
    return undefined;
  };
  const text = (value: unknown, path: string) => {
    if (typeof value === "string" && value.trim()) return value;
    problem(path, "必须是非空字符串");
    return undefined;
  };
  const choice = (value: unknown, allowed: readonly string[], path: string) => {
    if (typeof value === "string" && allowed.includes(value)) return value;
    problem(path, `取值必须属于 ${allowed.join("、")}`);
    return undefined;
  };
  const list = (value: unknown, path: string): unknown[] => {
    if (Array.isArray(value)) return value;
    problem(path, "必须是数组");
    return [];
  };
  const id = (value: unknown, path: string, registry: Map<string, string>) => {
    const result = text(value, path);
    if (result === undefined) return undefined;
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(result)) problem(path, "必须是小写英文 kebab-case ID");
    const previous = registry.get(result);
    if (previous) problem(path, `ID 重复，与 ${previous} 相同`);
    else registry.set(result, path);
    return result;
  };
  const url = (value: unknown, path: string) => {
    const result = text(value, path);
    if (result === undefined) return;
    try {
      const parsed = new URL(result);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") return;
    } catch { /* 统一报告无法作为来源链接使用的地址。 */ }
    problem(path, "必须是 HTTP 或 HTTPS 链接");
  };

  if (files.length === 0) problem("规范库", "没有 JSON 规范集文件");
  for (const file of files) {
    const path = file.filename;
    const set = record(file.value, path);
    if (!set) continue;
    const setId = id(set.id, `${path}.id`, ids);
    if (setId && basename(path) !== `${setId}.json`) problem(path, "文件名必须与规范集 ID 一致");
    text(set.name, `${path}.name`);
    choice(set.layer, layers, `${path}.layer`);
    text(set.libraryVersion, `${path}.libraryVersion`);
    if (set.judgement !== undefined && typeof set.judgement !== "boolean") problem(`${path}.judgement`, "必须是布尔值");
    const setLanguages = list(set.languages, `${path}.languages`);
    for (const [index, language] of setLanguages.entries()) choice(language, languages, `${path}.languages[${index}]`);
    if (new Set(setLanguages).size !== setLanguages.length) problem(`${path}.languages`, "语言不能重复");

    const license = record(set.license, `${path}.license`);
    const tier = license && choice(license.tier, licenseTiers, `${path}.license.tier`);
    if (license) {
      text(license.attribution, `${path}.license.attribution`);
      text(license.notice, `${path}.license.notice`);
    }
    if (tier === "restricted") problem(`${path}.license.tier`, "需授权的来源不得进入规范库");
    if ([set.id, set.name].some((value) => typeof value === "string" && /misra/i.test(value))) {
      problem(path, "MISRA 不得进入规范库");
    }

    const sources = list(set.sources, `${path}.sources`);
    if (sources.length === 0) problem(`${path}.sources`, "至少提供一个来源");
    const sourceIds = new Map<string, string>();
    for (const [index, value] of sources.entries()) {
      const sourcePath = `${path}.sources[${index}]`;
      const source = record(value, sourcePath);
      if (!source) continue;
      id(source.id, `${sourcePath}.id`, sourceIds);
      text(source.title, `${sourcePath}.title`);
      text(source.author, `${sourcePath}.author`);
      text(source.license, `${sourcePath}.license`);
      url(source.url, `${sourcePath}.url`);
      if (tier === "open" || source.licenseUrl !== undefined) url(source.licenseUrl, `${sourcePath}.licenseUrl`);
      if ([source.id, source.title, source.author, source.url].some((field) => typeof field === "string" && /misra/i.test(field))) {
        problem(sourcePath, "MISRA 不得进入规范库");
      }
    }

    const reasons = list(set.inclusionReasons, `${path}.inclusionReasons`);
    const reasonKinds = new Set<string>();
    for (const [index, value] of reasons.entries()) {
      const reasonPath = `${path}.inclusionReasons[${index}]`;
      const reason = record(value, reasonPath);
      if (!reason) continue;
      const kind = choice(reason.kind, inclusionKinds, `${reasonPath}.kind`);
      if (kind) reasonKinds.add(kind);
      text(reason.explanation, `${reasonPath}.explanation`);
    }
    if (reasonKinds.size < 2) problem(`${path}.inclusionReasons`, "至少提供两种收录理由");

    const entries = list(set.entries, `${path}.entries`);
    entryCount += entries.length;
    if (entries.length < 8 || entries.length > 25) problem(`${path}.entries`, "每个规范集必须有 8 到 25 条条目");
    for (const [index, value] of entries.entries()) {
      const entryPath = `${path}.entries[${index}]`;
      const entry = record(value, entryPath);
      if (!entry) continue;
      id(entry.id, `${entryPath}.id`, ids);
      const title = text(entry.title, `${entryPath}.title`);
      if (title && (title.match(/\p{Script=Han}/gu)?.length ?? 0) > 25) problem(`${entryPath}.title`, "标题中文部分不得超过 25 个字");
      for (const field of ["originalName", "summary", "body", "check", "why", "fix", "goodExample", "badExample", "exampleLanguage"]) {
        text(entry[field], `${entryPath}.${field}`);
      }
      choice(entry.category, ruleCategories, `${entryPath}.category`);
      choice(entry.severity, ruleSeverities, `${entryPath}.severity`);
      if (entry.judgement !== undefined && typeof entry.judgement !== "boolean") problem(`${entryPath}.judgement`, "必须是布尔值");
      if ((entry.judgement ?? set.judgement ?? false) === true && entry.severity === "error") {
        problem(`${entryPath}.severity`, "判断题条目的默认严重级别应为建议或警告");
      }
      const source = record(entry.source, `${entryPath}.source`);
      if (!source) continue;
      const sourceId = text(source.sourceId, `${entryPath}.source.sourceId`);
      if (sourceId && !sourceIds.has(sourceId)) problem(`${entryPath}.source.sourceId`, "必须指向本规范集的来源 ID");
      text(source.reference, `${entryPath}.source.reference`);
    }
  }
  return { problems, setCount: files.length, entryCount };
}

export async function validateRuleLibraryDirectory(directory = defaultDirectory): Promise<ValidationResult> {
  const files: LibraryFile[] = [];
  const problems: string[] = [];
  try {
    for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".json")).sort()) {
      try {
        const value: unknown = JSON.parse(await readFile(join(directory, filename), "utf8"));
        files.push({ filename, value });
      } catch (error) {
        problems.push(`${filename}：无法读取 JSON 文件（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
  } catch (error) {
    problems.push(`${directory}：无法读取规范库目录（${error instanceof Error ? error.message : String(error)}）`);
  }
  const result = validateRuleLibrary(files);
  return { ...result, problems: [...problems, ...result.problems] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await validateRuleLibraryDirectory(process.argv[2]);
  if (result.problems.length > 0) {
    console.error("规范库校验不通过：");
    for (const problem of result.problems) console.error(`  ✗ ${problem}`);
    process.exitCode = 1;
  } else {
    console.log(`规范库校验通过：${result.setCount} 个规范集，${result.entryCount} 条条目`);
  }
}
