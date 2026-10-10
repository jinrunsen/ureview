import { describe, expect, it } from "vitest";
import type { FilePatch, RepositoryCredentials } from "../reviews/types.js";
import type { ManagedRule } from "./managed-types.js";
import { mockRuleDraft } from "../runtime/test-support.js";
import { ReviewRulesLoader, type ManagedRulesReader } from "./load.js";

const repository: RepositoryCredentials = { id: "payment", instanceUrl: "https://gitlab.example.test", projectId: 42,
  pathWithNamespace: "commerce/payment", webUrl: "https://gitlab.example.test/commerce/payment",
  httpUrlToRepo: "https://gitlab.example.test/commerce/payment.git", token: "fixture" };
const change = (newPath: string, oldPath = newPath): FilePatch => ({ newPath, oldPath, patch: "", newFile: false, deletedFile: false, renamedFile: oldPath !== newPath });
function rule(id: string, changes: Partial<ManagedRule> = {}): ManagedRule {
  return { ...mockRuleDraft, overrides: [], waivers: [], id, scope: "global", repositories: [], status: "active", version: 2,
    createdBy: "admin", updatedBy: "admin", createdAt: "2026-10-04T00:00:00Z", updatedAt: "2026-10-04T00:00:00Z", ...changes };
}
function loader(read: ManagedRulesReader) {
  return new ReviewRulesLoader(read);
}
describe("数据库规范进入评审快照", () => {
  it("判断题属性随版本进入快照，后续修改不改变本轮依据", async () => {
    const managed = rule("heuristic", { judgement: true });
    const result = await loader(async () => [managed]).load(repository.id, [change("src/payment.ts")]);
    expect(result[0]?.judgement).toBe(true);
    managed.judgement = false;
    expect(result[0]?.judgement).toBe(true);
  });

  it("仅激活规范生效，仓库与路径同时匹配，重命名考虑旧新路径", async () => {
    const calls: string[] = [];
    const rules = [rule("global"), rule("draft", { status: "draft" }),
      rule("payment", { scope: "repositories", repositories: [{ repositoryId: "payment", paths: ["src/**"] }] }),
      rule("all-paths", { scope: "repositories", repositories: [{ repositoryId: "payment", paths: [] }] }),
      rule("elsewhere", { scope: "repositories", repositories: [{ repositoryId: "orders", paths: [] }] }),
      rule("docs", { scope: "repositories", repositories: [{ repositoryId: "payment", paths: ["docs/**"] }] })];
    const result = await loader(async (id) => { calls.push(id); return rules; }).load(repository.id, [change("archive/payment.ts", "src/payment.ts"), change("schema.sql")]);
    expect(calls).toEqual(["payment"]);
    expect(result.map((item) => item.id)).toEqual(["managed:global", "managed:payment", "managed:all-paths"]);
    expect(result.find((item) => item.id === "managed:payment")?.matchedPaths).toEqual(["src/payment.ts"]);
    expect(result[0]?.matchedPaths).toEqual(["src/payment.ts", "archive/payment.ts", "schema.sql"]);
    expect(result[0]).toMatchObject({ ...mockRuleDraft, source: { kind: "generated" }, file: { kind: "database", ruleId: "global", version: 2, scope: "global" } });
    rules[0]!.body = "修改后的规范";
    expect(result[0]?.body).toBe(mockRuleDraft.body);
  });

  it("同一变更文件同时满足仓库路径和语言，未知扩展名只匹配全部语言", async () => {
    const rules = [rule("sql", { languages: ["sql"] }), rule("c", { languages: ["c"] }), rule("all"),
      rule("split", { languages: ["sql"], scope: "repositories", repositories: [{ repositoryId: "payment", paths: ["src/**"] }] })];
    const selected = await loader(async () => rules).loadWithRelations(repository.id, [change("src/payment.c"), change("db/schema.sql"), change("README")]);
    const result = selected.rules;
    expect(selected.relations.map((entry) => entry.id)).toContain("managed:split");
    expect(result.map((entry) => entry.id)).toEqual(["managed:sql", "managed:c", "managed:all"]);
    expect(result[0]!.matchedPaths).toEqual(["db/schema.sql"]);
    expect(result[1]!.matchedPaths).toEqual(["src/payment.c"]);
    const onlyC = await loader(async () => rules).load(repository.id, [change("src/payment.c")]);
    expect(onlyC.map((entry) => entry.id)).toEqual(["managed:c", "managed:all"]);
  });

  it("数据库读取失败明确终止规则加载，原始错误不外泄", async () => {
    await expect(loader(async () => { throw new Error("PRIVATE_DATABASE_SENTINEL"); }).load(repository.id, [change("src/payment.ts")]))
      .rejects.toMatchObject({ code: "rules_unavailable", message: "无法读取团队数据库规范，请稍后重试" });
  });
});
