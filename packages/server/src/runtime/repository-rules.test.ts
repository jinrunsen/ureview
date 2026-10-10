import { describe, expect, it } from "vitest";
import type { ReviewRule } from "../reviews/types.js";
import { RepositoryRuleInjection } from "./repository-rules.js";

const general: ReviewRule = {
  id: "repository:.agents/rules/general.md", body: "错误必须传递给调用方。", layer: "general", languages: [], overrides: [],
  source: { kind: "manual" }, file: { kind: "repository", repositoryId: "repository", repositoryName: "commerce/payments",
    path: ".agents/rules/general.md", commitSha: "head", url: "https://gitlab.example.test/commerce/payments/-/blob/head/.agents/rules/general.md" },
  matchedPaths: [], status: "active", effectivePaths: [], overriddenBy: [],
};
const agent = { inject() {} };

function session(snapshots: Map<string, ReviewRule>, rule: ReviewRule, onRules?: (rules: ReviewRule[]) => Promise<void>) {
  return new RepositoryRuleInjection({ cwd: "/workspace", repositoryRules: () => ({ resolve: async () => ({ context: "规范正文", rules: [rule] }) }),
    ...(onRules ? { onRules } : {}) }, snapshots);
}

describe("各阶段规范快照合并", () => {
  it("Grader 只读取部分文件时保留 Generator 发现的其他适用路径和覆盖方", async () => {
    const snapshots = new Map<string, ReviewRule>();
    const saved: ReviewRule[][] = [];
    const generator = session(snapshots, { ...general, matchedPaths: ["src/payment.ts", "src/report.ts", "src/batch.ts"], effectivePaths: ["src/payment.ts", "src/batch.ts"],
      overriddenBy: [{ ruleId: "managed:reporting", paths: ["src/report.ts"] }] }, async (rules) => { saved.push(structuredClone(rules)); });
    await generator.inject(agent, ["src/payment.ts", "src/report.ts", "src/batch.ts"]);
    const grader = session(snapshots, { ...general, matchedPaths: ["src/payment.ts"], effectivePaths: ["src/payment.ts"] }, async (rules) => { saved.push(structuredClone(rules)); });
    await grader.inject(agent, ["src/payment.ts"]);
    const snapshot = snapshots.get(general.id)!;
    expect(snapshot.matchedPaths).toEqual(["src/payment.ts", "src/report.ts", "src/batch.ts"]);
    expect(snapshot.effectivePaths).toEqual(expect.arrayContaining(["src/payment.ts", "src/batch.ts"]));
    expect(snapshot.overriddenBy).toEqual([{ ruleId: "managed:reporting", paths: ["src/report.ts"] }]);
    expect(snapshot.status).toBe("active");
    expect(saved.at(-1)).toEqual([snapshot]);
    expect(generator.applies(general.id, "src/batch.ts")).toBe(true);
    expect(grader.applies(general.id, "src/batch.ts")).toBe(false);
  });

  it("后续读取只更新已核查路径的效力，合并同一覆盖方并保留其他会话的生效路径", async () => {
    const snapshots = new Map<string, ReviewRule>([[general.id, { ...general,
      matchedPaths: ["src/a.ts", "src/b.ts", "src/c.ts"], effectivePaths: ["src/a.ts", "src/b.ts"],
      overriddenBy: [{ ruleId: "managed:team", paths: ["src/c.ts"] }] }]]);
    const grader = session(snapshots, { ...general, matchedPaths: ["src/a.ts", "src/d.ts"], status: "overridden", effectivePaths: [],
      overriddenBy: [{ ruleId: "managed:team", paths: ["src/a.ts", "src/d.ts"] }] });
    await grader.inject(agent, ["src/a.ts", "src/d.ts"]);
    expect(snapshots.get(general.id)).toMatchObject({ status: "active", effectivePaths: ["src/b.ts"],
      matchedPaths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      overriddenBy: [{ ruleId: "managed:team", paths: ["src/c.ts", "src/a.ts", "src/d.ts"] }] });
    expect(grader.applies(general.id, "src/a.ts")).toBe(false);
  });
});
