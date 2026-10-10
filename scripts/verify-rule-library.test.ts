import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { validateRuleLibrary, validateRuleLibraryDirectory } from "./verify-rule-library.js";
import { loadRuleLibrary } from "../packages/server/src/rules/library.js";

function makeSet(id = "sample-rules", count = 8) {
  const languages: string[] = [];
  return {
    id,
    name: "示例规范集",
    layer: "general",
    languages,
    sources: [{ id: "sample-source", title: "示例规范", author: "示例作者", url: "https://example.com/rules", license: "CC-BY-4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/" }],
    inclusionReasons: [
      { kind: "publication", explanation: "由示例机构发布。" },
      { kind: "longevity", explanation: "持续维护多年。" },
    ],
    license: { tier: "open", attribution: "示例作者，示例规范。", notice: "正文为改写内容。" },
    libraryVersion: "2026.10.2",
    entries: Array.from({ length: count }, (_, index) => ({
      id: `${id}-entry-${index + 1}`,
      title: "处理返回值",
      originalName: "Errors（错误处理）",
      summary: "忽略失败结果 → 先处理错误，再使用结果",
      body: "调用可能失败的函数后，应检查返回值并处理失败路径。",
      check: "检查调用结果是否包含错误，以及使用结果前是否已处理错误。",
      why: "忽略错误会让无效结果继续流入后续计算。",
      fix: "立即处理错误，成功后再使用结果。",
      goodExample: "if (result < 0) return result;",
      badExample: "read_value();",
      exampleLanguage: "c",
      category: "reliability",
      severity: "warning",
      source: { sourceId: "sample-source", reference: "错误处理" },
    })),
  };
}

function validate(value: unknown, filename = "sample-rules.json") {
  return validateRuleLibrary([{ filename, value }]);
}

describe("规范库结构校验", () => {
  it("接受完整规范集与正反例，并统计规范集和条目", () => {
    const value = makeSet();
    Object.assign(value.entries[0]!, { goodExample: "if (result < 0) return result;", badExample: "read_value();" });
    expect(validate(value)).toEqual({ problems: [], setCount: 1, entryCount: 8 });
    expect(validate(makeSet("sample-rules", 25)).problems).toEqual([]);
  });

  it("判断题声明校验布尔值、集级继承与条目覆盖", () => {
    const value = makeSet();
    Object.assign(value, { judgement: true });
    expect(validate(value).problems).toEqual([]);
    value.entries[0]!.severity = "error";
    expect(validate(value).problems).toEqual(["sample-rules.json.entries[0].severity：判断题条目的默认严重级别应为建议或警告"]);
    Object.assign(value.entries[0]!, { judgement: false });
    expect(validate(value).problems).toEqual([]);
    Object.assign(value, { judgement: "true" });
    Object.assign(value.entries[0]!, { judgement: 1 });
    expect(validate(value).problems).toEqual([
      "sample-rules.json.judgement：必须是布尔值", "sample-rules.json.entries[0].judgement：必须是布尔值",
    ]);
  });

  it("接受四个层级、Story 15 语言标识和全部语言", () => {
    const value = makeSet();
    for (const layer of ["principle", "general", "language", "team"]) {
      value.layer = layer;
      expect(validate(value).problems).toEqual([]);
    }
    value.languages = ["c", "cpp", "go", "java", "python", "javascript", "typescript", "rust", "shell", "sql", "kotlin"];
    expect(validate(value).problems).toEqual([]);
  });

  it.each(["original", "open", "internal", "copyrighted"])("接受许可分档 %s", (tier) => {
    const value = makeSet();
    value.license.tier = tier;
    expect(validate(value).problems).toEqual([]);
  });

  it.each([null, [], true, 42, "错误结构"])("拒绝非对象的规范集：%j", (value) => {
    expect(validate(value).problems).toEqual(["sample-rules.json：必须是对象"]);
  });

  it("缺少任一必填字段时报告字段路径", () => {
    const fields = ["id", "name", "layer", "languages", "sources", "inclusionReasons", "license", "libraryVersion", "entries"];
    for (const field of fields) {
      const value: Record<string, unknown> = makeSet();
      delete value[field];
      expect(validate(value).problems.some((problem) => problem.includes(`sample-rules.json.${field}`))).toBe(true);
    }
  });

  it("必填文本拒绝空白和错误类型", () => {
    const value = makeSet();
    value.name = "  ";
    value.libraryVersion = "\n";
    value.entries[0]!.body = "\t";
    Object.assign(value.entries[0]!, { title: 17 });
    const problems = validate(value).problems;
    for (const field of ["name", "libraryVersion", "entries[0].body", "entries[0].title"]) {
      expect(problems).toContain(`sample-rules.json.${field}：必须是非空字符串`);
    }
  });

  it.each(["originalName", "summary", "check", "why", "fix", "goodExample", "badExample", "exampleLanguage"])("条目缺少 %s 时报告字段路径", (field) => {
    const value = makeSet();
    const entry: Record<string, unknown> = value.entries[0]!;
    delete entry[field];
    expect(validate(value).problems).toEqual([`sample-rules.json.entries[0].${field}：必须是非空字符串`]);
  });

  it.each(["goodExample", "badExample"])("%s 拒绝空白示例", (field) => {
    const value = makeSet();
    Object.assign(value.entries[0]!, { [field]: " \n\t " });
    expect(validate(value).problems).toEqual([`sample-rules.json.entries[0].${field}：必须是非空字符串`]);
  });

  it("标题中文部分按 Unicode 字符计数，最多 25 个字", () => {
    const value = makeSet();
    value.entries[0]!.title = "检".repeat(25);
    expect(validate(value).problems).toEqual([]);
    value.entries[0]!.title += "查";
    expect(validate(value).problems).toEqual(["sample-rules.json.entries[0].title：标题中文部分不得超过 25 个字"]);
    value.entries[0]!.title = "Feature Envy：" + "𠮷".repeat(25);
    expect(validate(value).problems).toEqual([]);
  });

  it("拒绝错误的数组和嵌套对象类型", () => {
    const value = makeSet();
    Object.assign(value, { languages: "c", sources: [null], inclusionReasons: ["publication"], license: [], entries: [true] });
    const problems = validate(value).problems;
    for (const field of ["languages", "sources[0]", "inclusionReasons[0]", "license", "entries[0]"]) {
      expect(problems.some((problem) => problem.startsWith(`sample-rules.json.${field}：`))).toBe(true);
    }
  });

  it("拒绝非法层级、语言、分类、严重级别与许可分档", () => {
    const value = makeSet();
    value.layer = "global";
    value.languages = ["C++"];
    value.license.tier = "unknown";
    value.entries[0]!.category = "formatting";
    value.entries[0]!.severity = "high";
    const problems = validate(value).problems;
    for (const field of ["layer", "languages[0]", "license.tier", "entries[0].category", "entries[0].severity"]) {
      expect(problems.some((problem) => problem.startsWith(`sample-rules.json.${field}：取值必须属于`))).toBe(true);
    }
  });

  it("拒绝重复的适用语言", () => {
    const value = makeSet();
    value.languages = ["c", "c"];
    expect(validate(value).problems).toContain("sample-rules.json.languages：语言不能重复");
  });

  it("ID 必须稳定且文件名必须匹配规范集 ID", () => {
    const value = makeSet();
    value.entries[0]!.id = "Rule 1";
    expect(validate(value, "other.json").problems).toEqual([
      "other.json：文件名必须与规范集 ID 一致",
      "other.json.entries[0].id：必须是小写英文 kebab-case ID",
    ]);
  });

  it("拒绝规范集、条目及跨规范集条目的重复 ID", () => {
    const first = makeSet();
    const second = makeSet("second-rules");
    second.entries[0]!.id = first.entries[0]!.id;
    second.entries[1]!.id = first.id;
    const result = validateRuleLibrary([
      { filename: "sample-rules.json", value: first },
      { filename: "second-rules.json", value: second },
      { filename: "sample-rules.json", value: makeSet() },
    ]);
    expect(result.problems).toContain("second-rules.json.entries[0].id：ID 重复，与 sample-rules.json.entries[0].id 相同");
    expect(result.problems).toContain("second-rules.json.entries[1].id：ID 重复，与 sample-rules.json.id 相同");
    expect(result.problems).toContain("sample-rules.json.id：ID 重复，与 sample-rules.json.id 相同");
  });

  it("来源 ID 可在不同规范集中复用，集内不能重复", () => {
    const first = makeSet();
    const second = makeSet("second-rules");
    expect(validateRuleLibrary([{ filename: "sample-rules.json", value: first }, { filename: "second-rules.json", value: second }]).problems).toEqual([]);
    first.sources.push({ ...first.sources[0]! });
    expect(validate(first).problems).toContain("sample-rules.json.sources[1].id：ID 重复，与 sample-rules.json.sources[0].id 相同");
  });

  it.each([0, 7, 26])("拒绝 %i 条条目的规范集", (count) => {
    expect(validate(makeSet("sample-rules", count)).problems).toContain("sample-rules.json.entries：每个规范集必须有 8 到 25 条条目");
  });

  it("每条条目都需要可解析的来源和具体出处", () => {
    const value = makeSet();
    Object.assign(value.entries[0]!, { source: undefined });
    value.entries[1]!.source.sourceId = "missing-source";
    value.entries[2]!.source.reference = " ";
    const problems = validate(value).problems;
    expect(problems).toContain("sample-rules.json.entries[0].source：必须是对象");
    expect(problems).toContain("sample-rules.json.entries[1].source.sourceId：必须指向本规范集的来源 ID");
    expect(problems).toContain("sample-rules.json.entries[2].source.reference：必须是非空字符串");
  });

  it("来源需要作者、标题、许可与有效链接", () => {
    const value = makeSet();
    value.sources[0]!.author = "";
    value.sources[0]!.title = "";
    value.sources[0]!.license = "";
    value.sources[0]!.url = "javascript:alert(1)";
    const problems = validate(value).problems;
    for (const field of ["author", "title", "license", "url"]) {
      expect(problems.some((problem) => problem.startsWith(`sample-rules.json.sources[0].${field}：`))).toBe(true);
    }
    value.sources = [];
    expect(validate(value).problems).toContain("sample-rules.json.sources：至少提供一个来源");
  });

  it("开放来源必须有许可链接、署名与改写声明", () => {
    const value = makeSet();
    value.sources[0]!.licenseUrl = "";
    value.license.attribution = "";
    value.license.notice = "";
    const problems = validate(value).problems;
    expect(problems).toContain("sample-rules.json.sources[0].licenseUrl：必须是非空字符串");
    expect(problems).toContain("sample-rules.json.license.attribution：必须是非空字符串");
    expect(problems).toContain("sample-rules.json.license.notice：必须是非空字符串");
  });

  it.each([0, 8])("需授权来源即使有 %i 条条目也不能入库", (count) => {
    const value = makeSet("sample-rules", count);
    value.license.tier = "restricted";
    expect(validate(value).problems).toContain("sample-rules.json.license.tier：需授权的来源不得进入规范库");
  });

  it("内部可用来源可以注明复制原文需授权", () => {
    const value = makeSet();
    value.license.tier = "internal";
    value.sources[0]!.license = "复制原文需授权；本规范集仅收录自写要点。";
    expect(validate(value).problems).toEqual([]);
  });

  it("MISRA 来源不能通过更改许可分档收录", () => {
    const value = makeSet();
    value.sources[0]!.title = "MISRA C:2025";
    expect(validate(value).problems).toContain("sample-rules.json.sources[0]：MISRA 不得进入规范库");
    value.sources[0]!.title = "示例规范";
    value.sources[0]!.url = "https://misra.org.uk/";
    expect(validate(value).problems).toContain("sample-rules.json.sources[0]：MISRA 不得进入规范库");
  });

  it("收录理由需要至少两种合法类型和说明", () => {
    const value = makeSet();
    value.inclusionReasons = [{ kind: "community", explanation: "多人使用。" }, { kind: "community", explanation: "" }, { kind: "popularity", explanation: "社区使用。" }];
    const problems = validate(value).problems;
    expect(problems).toContain("sample-rules.json.inclusionReasons：至少提供两种收录理由");
    expect(problems).toContain("sample-rules.json.inclusionReasons[1].explanation：必须是非空字符串");
    expect(problems.some((problem) => problem.startsWith("sample-rules.json.inclusionReasons[2].kind："))).toBe(true);
  });

  it("正反例拒绝错误类型", () => {
    const value = makeSet();
    Object.assign(value.entries[0]!, { goodExample: null, badExample: {} });
    expect(validate(value).problems).toEqual([
      "sample-rules.json.entries[0].goodExample：必须是非空字符串",
      "sample-rules.json.entries[0].badExample：必须是非空字符串",
    ]);
  });
});

describe("规范库文件校验", () => {
  const directories: string[] = [];
  async function directory() {
    const path = await mkdtemp(join(tmpdir(), "ureview-rule-library-"));
    directories.push(path);
    return path;
  }
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("发布目录包含首批八个规范集且全部通过校验", async () => {
    const path = fileURLToPath(new URL("../packages/server/rule-library", import.meta.url));
    expect((await readdir(path)).filter((name) => name.endsWith(".json")).sort()).toEqual([
      "alibaba-java.json", "c-traps-and-pitfalls.json", "design-principles.json", "dpdk-data-plane.json",
      "go-guidelines.json", "google-code-review.json", "power-of-ten.json", "refactoring-smells.json",
    ]);
    const result = await validateRuleLibraryDirectory(path);
    expect(result.problems).toEqual([]);
    expect(result.setCount).toBe(8);
  });

  it("发布条目保留三条权威样板和十二个固定坏味道", async () => {
    const sets = await loadRuleLibrary();
    const readme = await readFile(new URL("../packages/server/rule-library/README.md", import.meta.url), "utf8");
    const samples = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]!));
    expect(samples).toHaveLength(3);
    for (const sample of samples) {
      expect(sets.flatMap((set) => set.entries).find((entry) => entry.id === sample.id)).toMatchObject(sample);
    }
    expect(sets.every((set) => set.libraryVersion === "2026.10.4")).toBe(true);
    expect(sets.find((set) => set.id === "power-of-ten")!.entries).toHaveLength(10);
    expect(sets.find((set) => set.id === "design-principles")!.layer).toBe("principle");
    const smells = sets.find((set) => set.id === "refactoring-smells")!.entries;
    expect(smells.length).toBeGreaterThanOrEqual(15);
    for (const name of ["Mysterious Name", "Duplicated Code", "Feature Envy", "Data Clumps", "Primitive Obsession", "Repeated Switches", "Shotgun Surgery", "Divergent Change", "Speculative Generality", "Message Chains", "Middle Man", "Refused Bequest"]) {
      expect(smells.some((entry) => entry.originalName.split("（")[0] === name), name).toBe(true);
    }
    expect(smells.every((entry) => ["recommendation", "warning"].includes(entry.severity))).toBe(true);
  });

  it("读取数据文件，拒绝空目录、缺失目录与坏 JSON", async () => {
    const path = await directory();
    expect((await validateRuleLibraryDirectory(path)).problems).toContain("规范库：没有 JSON 规范集文件");
    expect((await validateRuleLibraryDirectory(join(path, "missing"))).problems.some((problem) => problem.includes("无法读取规范库目录"))).toBe(true);
    await writeFile(join(path, "sample-rules.json"), JSON.stringify(makeSet()));
    expect(await validateRuleLibraryDirectory(path)).toEqual({ problems: [], setCount: 1, entryCount: 8 });
    await writeFile(join(path, "broken.json"), "{broken");
    expect((await validateRuleLibraryDirectory(path)).problems.some((problem) => problem.startsWith("broken.json：无法读取 JSON 文件"))).toBe(true);
  });

  it("tsx 命令对有效数据返回成功，对无效数据返回失败", async () => {
    const path = await directory();
    const script = fileURLToPath(new URL("./verify-rule-library.ts", import.meta.url));
    const invalid = spawnSync(process.execPath, ["--import", "tsx", script, path], { encoding: "utf8" });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("规范库校验不通过");
    await writeFile(join(path, "sample-rules.json"), JSON.stringify(makeSet()));
    const valid = spawnSync(process.execPath, ["--import", "tsx", script, path], { encoding: "utf8" });
    expect(valid.status).toBe(0);
    expect(valid.stdout).toContain("规范库校验通过：1 个规范集，8 条条目");
  });
});
