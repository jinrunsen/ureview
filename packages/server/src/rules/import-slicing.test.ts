import { describe, expect, it } from "vitest";
import { sliceImportFile } from "./import-slicing.js";
import { importAssignmentBoundaries, validateImportPlan } from "./import-plan.js";
import { validateImportFiles } from "./imports.js";

describe("企业规范切片", () => {
  it("建立标题树并保留文件和标题路径", () => {
    const result = sliceImportFile("安全规范.md", "# 安全编码\n## Java\n#### 输入检查\n必须检查输入。\n");
    expect(result.sections.map((item) => [item.level, item.parentId])).toEqual([[0, null], [1, "section-0"], [2, "section-1"], [4, "section-2"]]);
    expect(result.sections[3]!.path).toBe("安全规范.md › 安全编码 › Java › 输入检查");
    expect(result).toEqual(sliceImportFile("安全规范.md", "# 安全编码\n## Java\n#### 输入检查\n必须检查输入。\n"));
  });
  it.each(["```", "~~~"])("忽略 %s 代码围栏内的标题", (fence) => {
    const result = sliceImportFile("规范.md", `# Python\n${fence}python\n# 检查输入\n${fence}\n## 错误处理\n不得忽略异常。`);
    expect(result.sections).toHaveLength(3);
    expect(result.chunks[0]!.text).toContain("# 检查输入");
  });
  it("超长章节逐级按子标题拆分", () => {
    const result = sliceImportFile("规范.md", `# 安全\n## Java\n### 输入\n${"必须校验。".repeat(900)}\n### 输出\n${"必须编码。".repeat(900)}`);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((chunk) => chunk.path)).toEqual(["规范.md › 安全 › Java › 输入", "规范.md › 安全 › Java › 输出"]);
  });
  it("章节正文和相邻小章节按顺序合并，合并片段保留上级路径与下级标题", () => {
    const body = "必须检查调用边界。".repeat(300);
    const text = `# 安全\n说明调用约束。\n${["输入", "错误", "资源", "输出"].map((title) => `## ${title}\n${body}\n`).join("")}`;
    const chunks = sliceImportFile("规范.md", text).chunks;
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.text.length <= 8000 && chunk.path === "规范.md › 安全")).toBe(true);
    expect(chunks[0]!.text).toBe(`说明调用约束。\n## 输入\n${body}\n## 错误\n${body}\n`);
    expect(chunks[1]!.text).toBe(`## 资源\n${body}\n## 输出\n${body}\n`);
  });
  it("单个下级章节超限时递归合并其相邻小章节", () => {
    const body = "必须检查输入。".repeat(350);
    const parts = Array.from({ length: 6 }, (_, index) => `### 条款 ${index + 1}\n${body}\n`);
    const chunks = sliceImportFile("规范.md", `# 安全\n## Java\n${parts.join("")}`).chunks;
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.path)).toEqual(["规范.md › 安全 › Java", "规范.md › 安全 › Java"]);
    expect(chunks.map((chunk) => chunk.text)).toEqual([parts.slice(0, 3).join(""), parts.slice(3).join("")]);
  });
  it("分配与跳过边界隔离相邻章节，祖先不能吞并深层分配", () => {
    const text = "# 安全\n## 通用\n说明。\n### 输入\n检查输入。\n### Java\n处理异常。\n### 修订记录\n维护日期。\n### 输出\n检查输出。\n## Go\n处理错误。";
    const original = sliceImportFile("规范.md", text);
    const assigned = original.sections.find((section) => section.title === "Java")!;
    const skipped = original.sections.find((section) => section.title === "修订记录")!;
    const sliced = sliceImportFile("规范.md", text, "section", new Set([assigned.id, skipped.id]));
    expect(sliced.sections).toEqual(original.sections);
    expect(sliced.chunks.map((chunk) => chunk.path)).toEqual(["规范.md › 安全 › 通用", assigned.path, skipped.path, "规范.md › 安全 › 通用 › 输出", "规范.md › 安全 › Go"]);
    expect(sliced.chunks[1]!.text).toBe("处理异常。\n");
    expect(sliced.chunks[2]!.text).toBe("维护日期。\n");
    expect(validateImportPlan({ sets: [{ name: "通用", layer: "general", languages: [], sectionIds: ["section-0"] }, { name: "Java", layer: "language", languages: ["java"], sectionIds: [assigned.id] }], skipped: [{ sectionId: skipped.id, reason: "文档修订记录" }] }, sliced)).toBeDefined();
  });
  it("四万六千字的一百一十六个小章节合并为六片，条款顺序完整", () => {
    const text = '# 编码实践\n本章说明调用边界的检查要求。\n' + Array.from({ length: 116 }, (_, index) => `## ${index + 1}. 输入与错误处理\n${'必须校验输入长度和范围，禁止忽略外部调用的错误。'.repeat(16)}\n`).join('');
    const chunks = sliceImportFile("编码实践.md", text).chunks;
    expect(text.length).toBe(46430);
    expect(chunks).toHaveLength(6);
    expect(chunks.every((chunk) => chunk.text.length <= 8000)).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text.slice(text.indexOf("\n") + 1));
  });
  it("无子标题的长章节按段落拆分", () => {
    const text = `${"检查输入。".repeat(900)}\n\n${"检查输出。".repeat(900)}`;
    const result = sliceImportFile("规范.md", `# 安全\n${text}`);
    expect(result.chunks).toHaveLength(2); expect(result.chunks.map((item) => item.text).join("")).toBe(text);
  });
  it("普通超长段落按行拆分", () => {
    const text = `${"检查".repeat(2000)}\n`.repeat(3);
    const chunks = sliceImportFile("规范.txt", text).chunks;
    expect(chunks).toHaveLength(3); expect(chunks.map((item) => item.text).join("")).toBe(text);
  });
  it("不拆开代码块和列表条款", () => {
    const code = `\`\`\`go\n${"// 检查输入\n".repeat(1200)}\`\`\`\n`;
    const list = `- 必须检查输入\n${"  校验长度。\n".repeat(1200)}`;
    expect(sliceImportFile("规范.md", code).chunks[0]!.text).toBe(code);
    expect(sliceImportFile("规范.md", list).chunks[0]!.text).toBe(list);
  });
  it.each(["目录", "Contents", "Table of Contents"])("跳过只有链接列表的 %s", (title) => {
    const result = sliceImportFile("规范.md", `# ${title}\n- [安全](#安全)\n# 安全\n必须检查输入。`);
    expect(result.sections[1]!.omitted).toBe(true); expect(result.chunks.map((item) => item.text).join("")).not.toContain("[安全]");
    expect(sliceImportFile("规范.md", `# ${title}\n必须检查输入。`).sections[1]!.omitted).toBe(false);
  });
  it("嵌套列表属于同一条款，不在子列表边界切开", () => {
    const text = `- 必须校验输入\n${"  - 检查长度与范围。\n".repeat(1000)}`;
    expect(sliceImportFile("规范.md", text).chunks.map((chunk) => chunk.text)).toEqual([text]);
  });
  it.each([
    `\`\`\`go\n${"// 必须检查输入\n".repeat(1200)}\`\`\`\n`,
    `- 必须检查输入\n${"  检查长度与范围。\n".repeat(1200)}`,
  ])("说明段落后没有空行仍保留围栏或条款完整：%#", (block) => {
    const chunks = sliceImportFile("规范.md", `输入要求：\n${block}后续说明。`).chunks;
    expect(chunks.some((chunk) => chunk.text.includes(block))).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(`输入要求：\n${block}后续说明。`);
  });
  it("纯文本按空行分段并保留一个章节", () => {
    const result = sliceImportFile("规范.txt", `# 不是标题\n${"校验输入。".repeat(1000)}\n\n${"处理错误。".repeat(1000)}`);
    expect(result.sections).toHaveLength(1); expect(result.chunks).toHaveLength(2);
  });
  it("按规划分配边界细分短章节", () => {
    const result = sliceImportFile("规范.md", "# 安全\n## Java\n检查输入。\n## Go\n处理错误。", "section", new Set(["section-2", "section-3"]));
    expect(result.chunks.map((item) => item.sectionId)).toEqual(["section-2", "section-3"]);
  });
});
describe("规划校验", () => {
  const file = sliceImportFile("规范.md", "# 安全\n必须检查输入。");
  const valid = { sets: [{ name: "安全", layer: "general", languages: [], sectionIds: ["section-0"] }], skipped: [] };
  it("接受父章节分配", () => { expect(validateImportPlan(valid, file)).toEqual(valid); });
  it.each([
    { ...valid, sets: [] },
    { ...valid, skipped: [{ sectionId: "section-0", reason: "综述" }] },
    { ...valid, sets: [{ ...valid.sets[0], sectionIds: ["missing"] }] },
    { ...valid, sets: [{ ...valid.sets[0], layer: "invalid" }] },
    { ...valid, sets: [{ ...valid.sets[0], languages: ["invalid"] }] },
  ])("拒绝无归属、重复、不存在或非法元数据：%j", (plan) => { expect(() => validateImportPlan(plan, file)).toThrow(); });
});
describe("上传校验", () => {
  const file = (name: string, content: Buffer) => ({ name, content: content.toString("base64") });
  it("按原始字节保存摘要和大小", () => { const result = validateImportFiles({ files: [file("规范.md", Buffer.from("必须处理错误。"))] }); expect(result[0]!.size).toBe(Buffer.byteLength("必须处理错误。")); expect(result[0]!.sha256).toHaveLength(64); });
  it("拒绝无效 UTF-8", () => { expect(() => validateImportFiles({ files: [file("规范.txt", Buffer.from([255]))] })).toThrow("UTF-8"); });
  it("拒绝超过数量和合计大小", () => { expect(() => validateImportFiles({ files: Array.from({ length: 11 }, () => file("规范.txt", Buffer.from("检查"))) })).toThrow("10"); expect(() => validateImportFiles({ files: Array.from({ length: 6 }, () => file("规范.txt", Buffer.alloc(1024 * 1024, 97))) })).toThrow("5 MB"); });
});

describe("规划归属边界", () => {
  const text = "# 编码规范\n" + Array.from({ length: 60 }, (_, i) => `## 条款 ${i}\n${"检查输入并释放资源。".repeat(35)}\n### 示例 ${i}\n${"检查错误。".repeat(20)}\n`).join("");
  it("仅列顶层与显式枚举同归属子章节产生完全相同的片段", () => {
    const file = sliceImportFile("编码.md", text);
    const top = new Map([["section-1", { setId: "coding" }]]);
    const all = new Map(file.sections.filter((section) => section.parentId).map((section) => [section.id, { setId: "coding" }]));
    const expected = sliceImportFile("编码.md", text, "section", importAssignmentBoundaries(file, top));
    expect(sliceImportFile("编码.md", text, "section", importAssignmentBoundaries(file, all))).toEqual(expected);
    expect(expected.chunks.length).toBeLessThan(10);
  });
  it.each(["other", null])("子章节归属改为 %s 时保留边界，孙章节仍继承最近祖先", (setId) => {
    const content = "# 编码规范\n## 输入\n检查输入。\n### 补充\n拒绝空值。\n## 资源\n释放资源。\n";
    const file = sliceImportFile("编码.md", content);
    const assignments = new Map([["section-1", { setId: "coding" }], ["section-2", { setId }], ["section-3", { setId }]]);
    const boundaries = importAssignmentBoundaries(file, assignments);
    expect([...boundaries]).toEqual(["section-1", "section-2"]);
    const sliced = sliceImportFile("编码.md", content, "section", boundaries);
    expect(sliced.chunks.map((chunk) => chunk.sectionId)).toEqual(["section-2", "section-4"]);
    expect(sliced.chunks[0]!.text).toContain("拒绝空值");
  });
});
