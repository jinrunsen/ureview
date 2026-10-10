import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepositoryCredentials, ReviewRule } from "../reviews/types.js";
import { createRepositoryRuleSession, prepareManagedRuleEffects } from "./repository.js";

const repository: RepositoryCredentials = { id: "business-repository", instanceUrl: "https://gitlab.example.test", projectId: 42,
  pathWithNamespace: "commerce/payment-gateway", webUrl: "https://gitlab.example.test/commerce/payment-gateway",
  httpUrlToRepo: "https://gitlab.example.test/commerce/payment-gateway.git", token: "fixture" };
const commitSha = "a".repeat(40);
const markdown = (paths = '["src/**/*.ts"]', body = "金额必须使用整数分。", extra = "") => `---\npaths: ${paths}\n${extra}---\n${body}\n`;
let directory: string;
let cwd: string;
let warnings: string[];
const put = async (path: string, body: string | Buffer) => {
  await mkdir(dirname(join(cwd, path)), { recursive: true });
  await writeFile(join(cwd, path), body);
};
const session = () => createRepositoryRuleSession(cwd, repository, commitSha, (warning) => warnings.push(warning));
const config = (value: Record<string, unknown>) => put(".sase-rule-inject.json", JSON.stringify(value));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ureview-markdown-rules-"));
  cwd = join(directory, "repository");
  warnings = [];
  await put("src/payment.ts", "export const amount = 1;\n");
  await put("src/refund.ts", "export const amount = 2;\n");
});
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

describe("仓库规范按需注入", () => {
  it("判断题布尔属性进入快照，非法值告警并使用默认值", async () => {
    await put(".agents/rules/judgement.md", markdown(undefined, "可能的 Feature Envy。", "judgement: true\n"));
    await put(".agents/rules/ordinary.md", markdown(undefined, "整数分金额。", "judgement: false\n"));
    await put(".agents/rules/invalid.md", markdown(undefined, "金额上限。", 'judgement: "true"\n'));
    const rules = session();
    const result = await rules.resolve(["src/payment.ts"], 1);
    expect(result.rules.find((rule) => rule.id.endsWith("judgement.md"))?.judgement).toBe(true);
    expect(result.rules.find((rule) => rule.id.endsWith("ordinary.md"))?.judgement).toBe(false);
    expect(result.rules.find((rule) => rule.id.endsWith("invalid.md"))?.judgement).toBe(false);
    expect(result.context).toContain('judgement="true"');
    expect(result.context).toContain("判断题规范");
    const refreshed = await rules.resolve(["src/payment.ts"], 31);
    expect(refreshed.context).toContain("rule-ticket");
    expect(refreshed.context).toContain('judgement="true"');
    expect(refreshed.context).toContain("判断题规范");
    expect(warnings).toEqual([expect.stringContaining("judgement 必须是 true 或 false")]);
  });

  it("读取匹配文件才注入正文，快照有稳定身份、来源提交及匹配路径", async () => {
    await put(".agents/rules/payment.md", markdown(undefined, "  金额必须使用整数分。  ", 'name: "金额格式"\ndescription: "结算约定"\n'));
    await put("README.md", "文档");
    const rules = session();
    expect(await rules.resolve(["README.md"], 1)).toEqual({ context: "", rules: [] });
    const result = await rules.resolve(["src/payment.ts"], 2);
    expect(result.context).toContain('<rule-context id="repository:.agents/rules/payment.md"');
    expect(result.context).toContain('rule="金额格式"');
    expect(result.context).not.toContain("paths:");
    expect(result.rules).toEqual([{ id: "repository:.agents/rules/payment.md", body: "金额必须使用整数分。", judgement: false, layer: "team", languages: [], overrides: [], status: "active", effectivePaths: ["src/payment.ts"], overriddenBy: [], source: { kind: "manual" },
      file: { kind: "repository", repositoryId: repository.id, repositoryName: repository.pathWithNamespace, path: ".agents/rules/payment.md", commitSha,
        url: `${repository.webUrl}/-/blob/${commitSha}/.agents/rules/payment.md` }, matchedPaths: ["src/payment.ts"] }]);
    expect(warnings).toEqual([]);
  });

  it("近层规则优先，glob 锚在层目录，同层先具体路径再按规则文件名排序", async () => {
    await put("packages/payment/src/charge.ts", "export const charge = 1;");
    await put(".agents/rules/root.md", markdown('["packages/payment/src/charge.ts"]', "根层"));
    await put("packages/payment/.agents/rules/guides/z.md", markdown('["src/charge.ts"]', "同层 z"));
    await put("packages/payment/.agents/rules/guides/a.md", markdown('["src/charge.ts"]', "同层 a"));
    await put("packages/payment/.agents/rules/broad.md", markdown('["**/*.ts"]', "同层宽范围"));
    await mkdir(join(directory, ".agents/rules"), { recursive: true });
    await writeFile(join(directory, ".agents/rules/parent.md"), markdown('["**"]', "越过仓根"));
    const result = await session().resolve(["packages/payment/src/charge.ts"], 1);
    expect(result.rules.map((rule) => rule.body)).toEqual(["同层 a", "同层 z", "同层宽范围", "根层"]);
  });

  it("同名规则仍按文件路径区分，多个文件命中一次并累计静默读取路径", async () => {
    await put(".agents/rules/a.md", markdown(undefined, "第一条", "name: payment\n"));
    await put(".agents/rules/b.md", markdown(undefined, "第二条", "name: payment\n"));
    const rules = session();
    const initial = await rules.resolve(["src/payment.ts", "src/payment.ts"], 1);
    expect(initial.rules).toHaveLength(2);
    const repeated = await rules.resolve(["src/refund.ts"], 2);
    expect(repeated.context).toBe("");
    expect(repeated.rules.every((rule) => rule.matchedPaths.join(",") === "src/payment.ts,src/refund.ts")).toBe(true);
    expect(initial.rules[0]?.matchedPaths).toEqual(["src/payment.ts"]);
  });

  it("支持块列表和未知 frontmatter 字段，缺少或空 paths 的规则保持惰性", async () => {
    await put(".agents/rules/active.md", markdown('\n  - "src/payment.ts"\n  - src/refund.ts', "列表规则", "unknown: true\n"));
    await put(".agents/rules/lazy.md", "---\nname: 知识\n---\n惰性正文");
    await put(".agents/rules/empty.md", markdown("[]", "空列表"));
    await put(".agents/rules/prose.md", "---\n正文中的分隔线\n---\n普通文档");
    await put(".agents/rules/unclosed.md", "---\n普通文档");
    const result = await session().resolve(["src/refund.ts"], 1);
    expect(result.rules.map((rule) => rule.body)).toEqual(["列表规则"]);
    expect(warnings).toEqual([]);
  });

  it.each([
    ["src/**/*.ts", "src/payment.ts"], ["src/", "src/deep/payment.ts"], ["src/payment.?s", "src/payment.ts"],
    ["src/[slug].ts", "src/[slug].ts"], ["src/{a,b}.ts", "src/{a,b}.ts"], ["!literal.ts", "!literal.ts"],
  ])("glob %s 按有限通配符语义匹配 %s", async (pattern, path) => {
    await put(path, "fixture");
    await put(".agents/rules/pattern.md", markdown(`\n  - '${pattern}'`));
    expect((await session().resolve([path], 1)).rules).toHaveLength(1);
  });

  it("字符组与花括号不展开，星号不跨目录", async () => {
    await put("src/a.ts", "fixture");
    await put("src/deep/a.ts", "fixture");
    await put(".agents/rules/literal.md", markdown("\n  - src/[ab].ts\n  - src/{a,b}.ts\n  - src/*.js"));
    expect((await session().resolve(["src/a.ts", "src/deep/a.ts"], 1)).rules).toEqual([]);
  });

  it("坏文件与非法 glob 告警跳过，合法匹配继续工作", async () => {
    await put(".agents/rules/scalar.md", markdown("src/**"));
    await put(".agents/rules/globs.md", markdown('\n  - ../outside\n  - /absolute\n  - C:/drive\n  - src\\bad\n  - src/payment.ts'));
    await put(".agents/rules/unclosed.md", `---\n${"# 行\n".repeat(201)}---\n正文`);
    await put(".agents/rules/utf8.md", Buffer.from([0xff, 0xfe]));
    await put(".agents/rules/huge.md", markdown(undefined, "a".repeat(1024 * 1024)));
    const rules = session();
    expect((await rules.resolve(["src/payment.ts"], 1)).rules.map((rule) => rule.file.path)).toEqual([".agents/rules/globs.md"]);
    expect(warnings.some((warning) => warning.includes("paths 必须是 glob 列表"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("200 行"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("无效 glob"))).toBe(true);
    const warningCount = warnings.length;
    await rules.resolve(["src/payment.ts"], 2);
    expect(warnings).toHaveLength(warningCount);
  });

  it("扫描只深入八层目录，frontmatter 的字节窗口也有限制", async () => {
    await put(`.agents/rules/${"level/".repeat(8)}active.md`, markdown());
    await put(`.agents/rules/${"level/".repeat(9)}ignored.md`, markdown(undefined, "超过扫描深度"));
    await put(".agents/rules/header.md", `---\nname: ${"字".repeat(6000)}\npaths: ["src/**"]\n---\n正文`);
    const result = await session().resolve(["src/payment.ts"], 1);
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]?.file.path).toContain("active.md");
    expect(warnings).toHaveLength(1);
  });

  it("规则文件、规则根、中间目录与读取路径的符号链接都不越界", async () => {
    await put(".agents/rules/valid.md", markdown());
    await writeFile(join(directory, "outside.md"), markdown());
    await symlink(join(directory, "outside.md"), join(cwd, ".agents/rules/link.md"));
    await symlink(directory, join(cwd, ".agents/rules/link-directory"));
    await mkdir(join(directory, "external-rules"));
    await writeFile(join(directory, "external-rules/rule.md"), markdown('["**"]'));
    await put("packages/a/src/code.ts", "fixture");
    await symlink(join(directory, "external-rules"), join(cwd, "packages/a/.agents"));
    await symlink(join(directory, "outside.md"), join(cwd, "src/outside.ts"));
    const result = await session().resolve(["src/payment.ts", "src/outside.ts", "../outside.md", "packages/a/src/code.ts"], 1);
    expect(result.rules.map((rule) => rule.file.path)).toEqual([".agents/rules/valid.md"]);
    expect(result.rules[0]?.matchedPaths).toEqual(["src/payment.ts"]);
  });

  it("规则根本身为符号链接时跳过整个根", async () => {
    await mkdir(join(cwd, ".agents"));
    await mkdir(join(directory, "external"));
    await writeFile(join(directory, "external/rule.md"), markdown());
    await symlink(join(directory, "external"), join(cwd, ".agents/rules"));
    expect((await session().resolve(["src/payment.ts"], 1)).rules).toEqual([]);
  });

  it("正文变动即重新全文注入，独立会话不共享已注入状态", async () => {
    await put(".agents/rules/a.md", markdown());
    const rules = session();
    const first = await rules.resolve(["src/payment.ts"], 1);
    expect((await rules.resolve(["src/payment.ts"], 2)).context).toBe("");
    await put(".agents/rules/a.md", markdown(undefined, "金额必须为非负整数分。"));
    const changed = await rules.resolve(["src/payment.ts"], 3);
    expect(changed.context).toContain("<rule-context");
    expect(changed.context).not.toEqual(first.context);
    expect(changed.rules[0]?.body).toBe("金额必须为非负整数分。");
    expect((await session().resolve(["src/payment.ts"], 3)).context).toContain("<rule-context");
  });

  it("三十轮后发提醒，静默命中不推迟刷新且时间回退也提醒", async () => {
    await put(".agents/rules/a.md", markdown());
    const rules = session();
    await rules.resolve(["src/payment.ts"], 1);
    expect((await rules.resolve(["src/payment.ts"], 30)).context).toBe("");
    expect((await rules.resolve(["src/payment.ts"], 31)).context).toContain("<rule-ticket");
    expect((await rules.resolve(["src/payment.ts"], 32)).context).toBe("");
    expect((await rules.resolve(["src/payment.ts"], 2)).context).toContain("<rule-ticket");
  });

  it("轮次不可用时按墙钟刷新，有轮次时挂机不算刷新", async () => {
    await put(".agents/rules/a.md", markdown());
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
    const timed = session();
    const counted = session();
    await timed.resolve(["src/payment.ts"], NaN);
    await counted.resolve(["src/payment.ts"], 1);
    clock.mockReturnValue(2_701_000);
    expect((await timed.resolve(["src/payment.ts"], NaN)).context).toContain("<rule-ticket");
    expect((await counted.resolve(["src/payment.ts"], 2)).context).toBe("");
  });

  it("零预算与零刷新配置表示不限制、不自动刷新", async () => {
    await config({ maxRuleChars: 0, maxTotalChars: 0, refreshWindowTurns: 0, refreshWindowSeconds: 0 });
    await put(".agents/rules/a.md", markdown(undefined, "a".repeat(12000)));
    const rules = session();
    expect((await rules.resolve(["src/payment.ts"], 1)).context.length).toBeGreaterThan(12000);
    expect((await rules.resolve(["src/payment.ts"], 1000)).context).toBe("");
  });

  it("单条正文截断仍保存全文，单次总字符数不超预算", async () => {
    await config({ maxRuleChars: 400, maxTotalChars: 450 });
    await put(".agents/rules/a.md", markdown(undefined, "长正文".repeat(1000)));
    const result = await session().resolve(["src/payment.ts"], 1);
    expect(result.context).toContain("已截断");
    expect(result.context).toHaveLength(400);
    expect(result.rules[0]?.body).toHaveLength(3000);
  });

  it("预算只能容纳索引时不计入快照，下次扩大预算仍全文注入", async () => {
    await config({ maxRuleChars: 1, maxTotalChars: 500 });
    await put(".agents/rules/a.md", markdown());
    const rules = session();
    const indexed = await rules.resolve(["src/payment.ts"], 1);
    expect(indexed.context).toContain('<rule-ref id="repository:.agents/rules/a.md"');
    expect(indexed.rules).toEqual([]);
    await config({ maxRuleChars: 0, maxTotalChars: 0 });
    const delivered = await rules.resolve(["src/payment.ts"], 2);
    expect(delivered.context).toContain("<rule-context");
    expect(delivered.rules).toHaveLength(1);
  });

  it("同次只登记预算内实际送达的规则，溢出规则在后续读取时仍可注入", async () => {
    await config({ maxTotalChars: 350 });
    await put(".agents/rules/a.md", markdown(undefined, "第一条"));
    await put(".agents/rules/b.md", markdown(undefined, "第二条"));
    const rules = session();
    const first = await rules.resolve(["src/payment.ts"], 1);
    expect(first.context.length).toBeLessThanOrEqual(350);
    expect(first.rules.map((rule) => rule.body)).toEqual(["第一条"]);
    const second = await rules.resolve(["src/payment.ts"], 2);
    expect(second.context).toContain('id="repository:.agents/rules/b.md"');
    expect(second.context).toContain("<rule-context");
    expect(second.rules.map((rule) => rule.body)).toEqual(["第一条", "第二条"]);
  });

  it.each([1, 20, 60, 200])("极小总预算 %s 也不超限或登记未送达规则", async (maxTotalChars) => {
    await config({ maxTotalChars });
    await put(".agents/rules/a.md", markdown(undefined, "正文".repeat(100)));
    const result = await session().resolve(["src/payment.ts"], 1);
    expect(result.context.length).toBeLessThanOrEqual(maxTotalChars);
    expect(result.rules).toEqual([]);
  });

  it("自定义规则目录逐层生效，关闭时不注入，非法单项退回默认值", async () => {
    await config({ rulesRoot: ".policies", refreshWindowTurns: -1, unknown: "ignored" });
    await put("src/.policies/payment.md", markdown('["payment.ts"]'));
    const rules = session();
    expect((await rules.resolve(["src/payment.ts"], 1)).rules[0]?.file.path).toBe("src/.policies/payment.md");
    expect(warnings).toHaveLength(1);
    await config({ enabled: false });
    expect((await session().resolve(["src/payment.ts"], 1)).context).toBe("");
    await config({ rulesRoot: "../outside" });
    await put(".agents/rules/default.md", markdown());
    expect((await session().resolve(["src/payment.ts"], 1)).rules[0]?.file.path).toBe(".agents/rules/default.md");
  });

  it("并行工具读取共用一个账本且每个调用都返回累积路径", async () => {
    await put(".agents/rules/a.md", markdown());
    const rules = session();
    const results = await Promise.all([rules.resolve(["src/payment.ts"], 1), rules.resolve(["src/refund.ts"], 1)]);
    expect(results.filter((result) => result.context.includes("<rule-context"))).toHaveLength(1);
    expect(results[1]?.rules[0]?.matchedPaths).toEqual(["src/payment.ts", "src/refund.ts"]);
  });
  it("语言与 paths 同时匹配，层级及非法声明进入快照和告警", async () => {
    await put("src/payment.c", "int amount = 1;");
    await put(".agents/rules/sql.md", markdown('["src/**"]', "禁止未限定 SQL 更新", 'layer: language\nlanguages: [sql]\n'));
    await put(".agents/rules/c.md", markdown('["src/**"]', "检查整数溢出", 'layer: language\nlanguages: [c]\n'));
    await put(".agents/rules/invalid.md", markdown('["src/**"]', "通用检查", 'layer: invalid\n'));
    await put(".agents/rules/unknown.md", markdown('["src/**"]', "未知语言", 'languages: [unknown]\n'));
    const result = await session().resolve(["src/payment.c"], 1);
    expect(result.rules.map((rule) => rule.body)).toEqual(["检查整数溢出", "通用检查"]);
    expect(result.rules[0]).toMatchObject({ layer: "language", languages: ["c"] });
    expect(result.rules[1]).toMatchObject({ layer: "team" });
    expect(warnings.some((warning) => warning.includes("layer"))).toBe(true);
    expect(warnings.some((warning) => warning.includes("languages"))).toBe(true);
  });

  it("非法语言列表不会扩大适用范围，列表中的有效语言仍可匹配", async () => {
    await put("src/kernel.c", "int count = 0;");
    await put("src/query.sql", "SELECT 1;");
    await put(".agents/rules/scalar.md", markdown('["src/**"]', "非法单行语言", 'languages: sql\n'));
    await put(".agents/rules/mapping.md", markdown('["src/**"]', "非法块语言", 'languages:\n  sql: true\n'));
    await put(".agents/rules/partial.md", markdown('["src/**"]', "SQL 检查", 'languages:\n  - sql\n  unknown: true\n'));
    expect((await session().resolve(["src/kernel.c"], 1)).rules).toEqual([]);
    expect((await session().resolve(["src/query.sql"], 1)).rules.map((rule) => rule.body)).toEqual(["SQL 检查"]);
    for (const name of ["scalar", "mapping", "partial"]) {
      expect(warnings.some((warning) => warning.includes(`${name}.md`) && warning.includes("languages 必须是列表"))).toBe(true);
    }
  });

  it("Git 覆盖按共同路径消除正文，剩余路径仍保留上层规范", async () => {
    await put(".agents/rules/general.md", markdown('["src/**"]', "通用原文", 'layer: general\n'));
    await put(".agents/rules/team.md", markdown('["src/payment.ts"]', "团队原文", 'layer: team\noverrides: [repository:.agents/rules/general.md]\n'));
    const rules = session();
    const first = await rules.resolve(["src/payment.ts"], 1);
    expect(first.context).toContain("团队原文");
    expect(first.context).not.toContain("通用原文");
    expect(first.rules.find((rule) => rule.layer === "general")).toMatchObject({ status: "overridden", effectivePaths: [],
      overriddenBy: [{ ruleId: "repository:.agents/rules/team.md", paths: ["src/payment.ts"] }] });
    const next = await rules.resolve(["src/refund.ts"], 2);
    expect(next.context).toContain("通用原文");
    expect(next.rules.find((rule) => rule.layer === "general")).toMatchObject({ status: "active", effectivePaths: ["src/refund.ts"] });
  });

  it("Git 覆盖工作台规范在预注入前生效，工作台覆盖 Git 同样按读取过滤", async () => {
    const managed: ReviewRule = { id: "managed:general", layer: "general", body: "全局规范", source: { kind: "generated" },
      file: { kind: "database", ruleId: "general", version: 1, scope: "global" }, matchedPaths: ["src/payment.ts"] };
    await put(".agents/rules/team.md", markdown(undefined, "仓库规范", 'layer: team\noverrides: [managed:general]\n'));
    const result = await prepareManagedRuleEffects(cwd, repository, commitSha, ["src/payment.ts"], [managed]);
    expect(result[0]).toMatchObject({ status: "overridden", effectivePaths: [], overriddenBy: [{ ruleId: "repository:.agents/rules/team.md", paths: ["src/payment.ts"] }] });
    await put(".agents/rules/team.md", markdown(undefined, "仓库规范", 'layer: general\n'));
    const overriding: ReviewRule = { ...managed, layer: "team", overrides: ["repository:.agents/rules/team.md"] };
    const resolved = await createRepositoryRuleSession(cwd, repository, commitSha, undefined, [overriding]).resolve(["src/payment.ts"], 1);
    expect(resolved.context).toBe("");
    expect(resolved.rules[0]).toMatchObject({ status: "overridden", effectivePaths: [] });
  });

  it("覆盖声明指向存在但不适用于本轮的工作台规范时保留关系且不误告警", async () => {
    await put(".agents/rules/team.md", markdown(undefined, "仓库规范", 'layer: team\noverrides: [managed:sql]\n'));
    const result = await createRepositoryRuleSession(cwd, repository, commitSha, (message) => warnings.push(message), [],
      [{ id: "managed:sql", layer: "language", overrides: [] }]).resolve(["src/payment.ts"], 1);
    expect(result.rules[0]).toMatchObject({ status: "active", overrides: ["managed:sql"] });
    expect(warnings).toEqual([]);
  });

  it("覆盖目标位于其他目录且本次未读取时仍保留有效声明", async () => {
    await put("packages/orders/.agents/rules/general.md", markdown('["src/**"]', "订单目录规范", 'layer: general\n'));
    await put(".agents/rules/team.md", markdown(undefined, "仓库规范", 'layer: team\noverrides: [repository:packages/orders/.agents/rules/general.md]\n'));
    const result = await session().resolve(["src/payment.ts"], 1);
    expect(result.rules[0]).toMatchObject({ status: "active", overrides: ["repository:packages/orders/.agents/rules/general.md"] });
    expect(warnings).toEqual([]);
  });

});
