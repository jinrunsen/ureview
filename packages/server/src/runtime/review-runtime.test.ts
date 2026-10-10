import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "tsx/esm/api";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FindingCandidate, ReviewInput, ReviewRuntime, ReviewRule, RepositoryRuleSession, GitReviewRule, ReportSubmission } from "../reviews/types.js";
import { bootReviewHost } from "./host.js";
import { makeMockFileGroups, startMockModelServer, type MockModelOptions, type MockToolStep } from "./test-support.js";
import { createRepositoryRuleSession } from "../rules/repository.js";
import { IdentityScenario, fixtureRepository } from "../auth/test-support.js";
import { DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import { ReviewStore } from "../reviews/store.js";
import type { ReviewDetail } from "../reviews/types.js";
import { mockRuleDraft } from "./test-support.js";
import { pruneReviewWorkspace } from "../reviews/exclusions.js";
import { REVIEW_STEP_LIMIT } from "./review-runtime.js";

let directory: string;
let cwd: string;
let host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
let mock: Awaited<ReturnType<typeof startMockModelServer>> | undefined;
let runtime: ReviewRuntime;
const source = "export function pay(amount: number) {\n  return amount - 1;\n}\n";

beforeAll(() => { register(); });
beforeEach(async () => {
  host = undefined;
  mock = undefined;
  directory = await mkdtemp(join(tmpdir(), "ureview-runtime-"));
  cwd = join(directory, "repo");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/payment.ts"), source);
  await writeFile(join(cwd, "AGENTS.md"), "UNTRUSTED_AUTOMATIC_INSTRUCTION_SENTINEL");
});
afterEach(async () => {
  try { await host?.dispose(); }
  finally {
    try { await mock?.dispose(); }
    finally {
      await rm(directory, { recursive: true, force: true });
      expect(mock?.scriptErrors ?? []).toEqual([]);
    }
  }
});

async function start(options: MockModelOptions = {}): Promise<void> {
  mock = await startMockModelServer(options);
  host = await bootReviewHost({ homeDir: join(directory, "home"), models: mock.models,
    onReady: async (created) => { runtime = created; return async () => {}; } });
}

function expectResponseLanguageLast(system: unknown): void {
  const expected = "思考过程（reasoning）、中间说明、回答和解释必须使用简体中文。所有面向用户的自然语言内容，包括解读正文、文件分组名称和主题、finding 标题、问题描述、证据说明、修复提示词、评分解释、规范正文与示例注释，都使用简体中文。Mermaid 图中的说明文字使用简体中文。工具名、结构化字段名、枚举值、代码标识符、文件路径、URL 和原文引用保持原样，不要翻译；代码示例遵循对应语言的语法。";
  const text = typeof system === "string" ? system : Array.isArray(system) ? system.map((block: unknown) => {
    if (typeof block !== "object" || block === null || !("text" in block) || typeof block.text !== "string") {
      throw new Error("模型请求的 system 段必须包含文本");
    }
    return block.text;
  }).join("\n\n") : "";
  expect(text.trimEnd().split(/\n\s*\n/).at(-1)).toBe(expected);
  expect(text.split(expected)).toHaveLength(2);
  expect(text.split("必须使用简体中文")).toHaveLength(2);
}

function input(onFinding: ReviewInput["onFinding"] = async () => {}): ReviewInput {
  return {
    reviewId: "fixture-review", cwd,
    pullRequest: { iid: 7, title: "金额检查", description: "检查扣款入口", author: "fixture",
      webUrl: "https://gitlab.example.test/commerce/payment-gateway/-/merge_requests/7",
      sourceBranch: "fix/payment", targetBranch: "main", headSha: "a".repeat(40),
      baseSha: "b".repeat(40), startSha: "b".repeat(40) },
    files: [{ oldPath: "src/payment.ts", newPath: "src/payment.ts", patch: "@@ -1 +1 @@\n-old\n+new",
      newFile: false, deletedFile: false, renamedFile: false }], onFinding,
  };
}

function candidate(title = "扣款缺少校验"): NonNullable<MockModelOptions["candidates"]>[number] {
  return { title, description: "负金额可以进入扣款逻辑", severity: "high",
    location: { path: "src/payment.ts", startLine: 1, endLine: 3 },
    evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }],
    fixPrompt: "在扣款入口拒绝非正金额，并补充边界用例。" };
}

function readStep(offset = 1, limit = 3): MockToolStep {
  return { name: "read", input: { file_path: "src/payment.ts", offset, limit }, result: { isError: false } };
}

function fileGroupsStep(): MockToolStep {
  return { name: "report_file_groups", input: { fileGroups: makeMockFileGroups() }, result: { isError: false, includes: "文件分组已记录" } };
}

function finishStep(count: number): MockToolStep {
  return { name: "finish_report", input: {}, result: { isError: false, includes: `已记录 ${count} 条结论` } };
}

async function storedFiles(path: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...await storedFiles(child));
    else result.push(child);
  }
  return result;
}

function repositoryRule(paths = ["src/payment.ts"]): GitReviewRule {
  return { id: "repository:.agents/rules/payment.md", body: "REPOSITORY_RULE_SENTINEL 金额必须为正数", source: { kind: "manual" },
    file: { kind: "repository", repositoryId: "fixture", repositoryName: "commerce/payment-gateway",
      path: ".agents/rules/payment.md", commitSha: "a".repeat(40),
      url: "https://gitlab.example.test/commerce/payment-gateway/-/blob/aaaa/.agents/rules/payment.md" }, matchedPaths: paths };
}

function ruleSessions(rule = repositoryRule()) {
  const sessions: Array<Array<{ paths: string[]; turn: number }>> = [];
  return { sessions, factory: (): RepositoryRuleSession => {
    const calls: Array<{ paths: string[]; turn: number }> = [];
    sessions.push(calls);
    const matched = new Set<string>();
    return { resolve: async (paths, turn) => {
      calls.push({ paths, turn });
      const previous = matched.size;
      for (const path of paths) if (rule.matchedPaths.includes(path)) matched.add(path);
      return { context: !previous && matched.size ? `${rule.id}\n${rule.body}` : "",
        rules: matched.size ? [{ ...rule, matchedPaths: [...matched] }] : [] };
    } };
  } };
}

describe("正式 dsh profile 的评审闭环", () => {
  it("两个阶段的读与搜索均不可带入排除目录、符号链接别名及排除目录内的规范", async () => {
    await mkdir(join(cwd, "features/steps/rules"), { recursive: true });
    await writeFile(join(cwd, "features/steps/payment.ts"), "EXCLUDED_TEST_CODE_SENTINEL amount\n");
    await writeFile(join(cwd, "features/steps/rules/payment.md"), "---\npaths: [src/**]\n---\nEXCLUDED_RULE_BODY_SENTINEL\n");
    await writeFile(join(cwd, ".sase-rule-inject.json"), JSON.stringify({ rulesRoot: "features/steps/rules" }));
    await mkdir(join(cwd, ".git"), { recursive: true });
    await writeFile(join(cwd, ".git/private.txt"), "EXCLUDED_GIT_CONTENT_SENTINEL\n");
    await symlink(join(cwd, "features/steps/payment.ts"), join(cwd, "test-alias.ts"));
    await pruneReviewWorkspace(cwd, ["features/steps"]);
    const calls = [
      { name: "glob", input: { pattern: "**/*" } },
      { name: "grep", input: { pattern: "amount" } },
      { name: "read", input: { file_path: "features/steps/payment.ts" } },
      { name: "read", input: { file_path: "test-alias.ts" } },
      { name: "read", input: { file_path: ".git/private.txt" } },
      { name: "read", input: { file_path: "src/payment.ts" } },
    ];
    await start({ discoveryCalls: calls, graderCalls: calls });
    const request = input();
    const repo = { id: "fixture", instanceUrl: "https://gitlab.example.test", projectId: 42,
      pathWithNamespace: "commerce/payment-gateway", webUrl: "https://gitlab.example.test/commerce/payment-gateway",
      httpUrlToRepo: "https://gitlab.example.test/commerce/payment-gateway.git", token: "fixture" };
    const output = await runtime.review({ ...request, excludedDirectories: ["features/steps"],
      repositoryRules: () => createRepositoryRuleSession(cwd, repo, request.pullRequest.headSha) });
    expect(output.findings).toHaveLength(1);
    expect(output.readFiles.every((range) => range.path === "src/payment.ts")).toBe(true);
    for (const model of ["fixture-generator", "fixture-grader"]) {
      const requests = mock!.requests.filter((request) => request.body.model === model);
      expect(requests.length).toBeGreaterThan(0);
      const messages = JSON.stringify(requests);
      expect(messages).toContain("该路径已从本轮评审中排除");
      expect(messages).not.toMatch(/EXCLUDED_TEST_CODE_SENTINEL|EXCLUDED_RULE_BODY_SENTINEL|EXCLUDED_GIT_CONTENT_SENTINEL/);
    }
  });

  it("排除目录的代码不能被报告为结论或证据", async () => {
    await mkdir(join(cwd, "features/steps"), { recursive: true });
    await writeFile(join(cwd, "features/steps/payment.ts"), source);
    const candidates: FindingCandidate[] = [];
    await start({ candidates: [{ title: "金额检查", description: "拒绝负金额", severity: "high",
      location: { path: "features/steps/payment.ts", startLine: 1, endLine: 3 },
      evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }], fixPrompt: "补充校验" }] });
    const result = await runtime.review({ ...input(async (finding) => { candidates.push(finding); }), excludedDirectories: ["features/steps"] });
    expect(result.findings).toEqual([]);
    expect(candidates).toEqual([]);
    expect(JSON.stringify(mock!.requests)).toContain("评审结论不能引用已排除的代码");
  });

  it("团队后台的正式 dsh 异步回调在强制 RLS 下保存规范和 finding，并经认证 HTTP 读取完成报告", async () => {
    const scenario = new IdentityScenario();
    await scenario.start();
    try {
      await scenario.setup();
      const connected = await scenario.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository);
      expect(connected.status).toBe(201);
      const repositoryId = connected.body.repository.id;
      await mkdir(join(cwd, ".agents/rules"), { recursive: true });
      await writeFile(join(cwd, ".agents/rules/payment.md"), "---\npaths: [src/**]\n---\n扣款金额必须为正数。\n");
      await writeFile(join(cwd, "src/context.ts"), "export const minimumAmount = 1;\n");
      const ruleId = "repository:.agents/rules/payment.md";
      await start({ discoveryCalls: [{ name: "read", input: { file_path: "src/payment.ts" } }],
        graderCalls: [{ name: "read", input: { file_path: "src/context.ts" } }],
        candidates: [{ title: "扣款缺少金额校验", description: "扣款金额可以为负数", severity: "high", ruleId,
          location: { path: "src/payment.ts", startLine: 1, endLine: 3 },
          evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }], fixPrompt: "拒绝非正金额" }] });
      const request = input();
      const repository = { id: repositoryId, instanceUrl: fixtureRepository.instanceUrl, projectId: 42,
        pathWithNamespace: fixtureRepository.projectPath, webUrl: `${fixtureRepository.instanceUrl}/${fixtureRepository.projectPath}`,
        httpUrlToRepo: `${fixtureRepository.instanceUrl}/${fixtureRepository.projectPath}.git`, token: fixtureRepository.token };
      const store = new ReviewStore(scenario.pool);
      const persistedRulePaths: string[][] = [];
      const reviewId = await withTeam(DEFAULT_TEAM_ID, async () => {
        const queued = await store.enqueue(repositoryId, "tenant-runtime", { projectId: 42, iid: request.pullRequest.iid,
          headSha: request.pullRequest.headSha, title: request.pullRequest.title, author: request.pullRequest.author });
        expect(queued).not.toBeNull();
        const job = await store.claim();
        expect(job?.id).toBe(queued!.id);
        await store.setPullRequest(queued!.id, request.pullRequest);
        await store.setFiles(queued!.id, request.files);
        const output = await runtime.review({ ...request, reviewId: queued!.id,
          repositoryRules: () => createRepositoryRuleSession(cwd, repository, request.pullRequest.headSha),
          onFinding: (finding) => store.reportFinding(queued!.id, finding),
          onRules: async (rules) => {
            await store.setRules(queued!.id, rules);
            const saved = await store.get(queued!.id);
            expect(saved?.rules).toEqual(rules);
            persistedRulePaths.push(saved!.rules.flatMap((rule) => rule.matchedPaths).sort());
          } });
        expect(persistedRulePaths).toEqual([["src/payment.ts"], ["src/context.ts", "src/payment.ts"]]);
        // 完成操作会重写 finding；先读取逐条回调已写入的记录，防止最终保存掩盖回调丢失。
        expect((await scenario.pool.query("SELECT id FROM review_findings WHERE review_id=$1", [queued!.id])).rowCount).toBe(1);
        const snapshot = await store.get(queued!.id);
        expect(snapshot?.rules[0]?.matchedPaths.sort()).toEqual(["src/context.ts", "src/payment.ts"]);
        await store.complete(queued!.id, output);
        return queued!.id;
      });
      const result = await scenario.request<{ review: ReviewDetail }>(`/api/reviews/${reviewId}`);
      expect(result.status).toBe(200);
      expect(result.body.review).toMatchObject({ status: "completed", findings: [{ ruleId, score: 88 }] });
      expect(result.body.review.rules).toHaveLength(1);
      const firstRule = result.body.review.rules[0];
      expect(firstRule?.file.kind !== "database" && firstRule?.file.repositoryId).toBe(repositoryId);
      expect(new Set(result.body.review.readFiles.map((range) => range.phase))).toEqual(new Set(["generator", "grader"]));
      expect((await scenario.pool.query("SELECT id FROM reviews")).rows).toEqual([]);
      expect(host!.activeAgentCount).toBe(0);
    } finally { await scenario.stop(); }
  });

  it("真实 Markdown 规范引擎随 dsh 读取发现多层规则并保存同一轮快照", async () => {
    await mkdir(join(cwd, ".agents/rules"), { recursive: true });
    await mkdir(join(cwd, "src/.agents/rules"), { recursive: true });
    await writeFile(join(cwd, ".agents/rules/payment.md"), "---\npaths: [src/**]\n---\nROOT_RULE_BODY 金额需要校验\n");
    await writeFile(join(cwd, "src/.agents/rules/context.md"), "---\npaths:\n  - context.ts\n---\nNESTED_RULE_BODY 数值不得为负\n");
    await writeFile(join(cwd, "src/context.ts"), "export const value = -1;\n");
    const saved: ReviewRule[][] = [];
    const request = input();
    const repository = { id: "fixture", instanceUrl: "https://gitlab.example.test", projectId: 1,
      pathWithNamespace: "commerce/payment-gateway", webUrl: "https://gitlab.example.test/commerce/payment-gateway",
      httpUrlToRepo: "https://gitlab.example.test/commerce/payment-gateway.git", token: "fixture" };
    const ruleId = "repository:src/.agents/rules/context.md";
    await start({ discoveryCalls: [
      { name: "read", input: { file_path: "src/payment.ts" } },
      { name: "read", input: { file_path: "src/context.ts" } },
    ], candidates: [{ title: "数值为负", description: "上下文中的数值小于零", severity: "high", ruleId,
      location: { path: "src/context.ts", startLine: 1, endLine: 1 },
      evidence: [{ path: "src/context.ts", startLine: 1, endLine: 1, description: "数值来源" }], fixPrompt: "补充校验" }] });
    const result = await runtime.review({ ...request,
      repositoryRules: () => createRepositoryRuleSession(cwd, repository, request.pullRequest.headSha),
      onRules: async (rules) => { saved.push(structuredClone(rules)); } });
    expect(result.findings[0]).toMatchObject({ ruleId, score: 88 });
    const requests = mock!.requests.filter((item) => item.body.model === "fixture-generator");
    expect(JSON.stringify(requests[0]!.body)).not.toContain("ROOT_RULE_BODY");
    expect(JSON.stringify(requests[1]!.body)).toContain("ROOT_RULE_BODY");
    expect(JSON.stringify(requests[1]!.body)).not.toContain("NESTED_RULE_BODY");
    expect(JSON.stringify(requests[2]!.body)).toContain("NESTED_RULE_BODY");
    expect(saved.at(-1)!.map((rule) => ({ id: rule.id, paths: rule.matchedPaths, sha: rule.file.kind !== "database" ? rule.file.commitSha : null })))
      .toEqual([
        { id: "repository:.agents/rules/payment.md", paths: ["src/payment.ts", "src/context.ts"], sha: request.pullRequest.headSha },
        { id: ruleId, paths: ["src/context.ts"], sha: request.pullRequest.headSha },
      ]);
    const grading = mock!.requests.find((item) => item.body.model === "fixture-grader")!;
    expect(JSON.stringify(grading.body)).toContain("NESTED_RULE_BODY");
    expect(host!.activeAgentCount).toBe(0);
  });

  it("按实际读取注入仓库规范，重复读取保持静默，Generator 与 Grader 分别获得正文", async () => {
    const rule = repositoryRule();
    const sessions = ruleSessions(rule);
    const saved: ReviewRule[][] = [];
    await start({ discoveryCalls: [
      { name: "glob", input: { pattern: "src/*" } },
      { name: "read", input: { file_path: "missing.ts" } },
      { name: "read", input: { file_path: "src/payment.ts" } },
      { name: "read", input: { file_path: "src/payment.ts" } },
    ], graderCalls: [{ name: "read", input: { file_path: "src/payment.ts" } }], candidates: [{
      title: "扣款缺少校验", description: "金额可以为负数", severity: "high", ruleId: rule.id,
      location: { path: "src/payment.ts", startLine: 1, endLine: 3 },
      evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }], fixPrompt: "检查金额",
    }] });
    const result = await runtime.review({ ...input(), repositoryRules: sessions.factory,
      onRules: async (rules) => { saved.push(structuredClone(rules)); } });
    expect(result.findings[0]).toMatchObject({ ruleId: rule.id, score: 88 });
    const requests = mock!.requests.filter((request) => request.body.model === "fixture-generator");
    for (const request of requests.slice(0, 3)) expect(JSON.stringify(request.body)).not.toContain(rule.body);
    expect(JSON.stringify(requests[3]!.body)).toContain(rule.body);
    expect(JSON.stringify(requests.at(-1)!.body).split(rule.body)).toHaveLength(2);
    const grading = mock!.requests.filter((request) => request.body.model === "fixture-grader");
    expect(JSON.stringify(grading[0]!.body)).toContain(rule.body);
    expect(JSON.stringify(grading.at(-1)!.body).split(rule.body)).toHaveLength(2);
    expect(sessions.sessions).toHaveLength(2);
    expect(sessions.sessions[0]!.map((call) => call.paths)).toEqual([["src/payment.ts"], ["src/payment.ts"]]);
    expect(sessions.sessions[0]![1]!.turn).toBeGreaterThan(sessions.sessions[0]![0]!.turn);
    expect(sessions.sessions[1]!.map((call) => call.paths)).toEqual([["src/payment.ts"], ["src/payment.ts"]]);
    expect(saved).toEqual([[rule]]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("grep 只按返回的代码命中注入，也覆盖 diff 之外的上下文文件", async () => {
    await writeFile(join(cwd, "src/context.ts"), "export const referenceAmount = 1;\n");
    const rule = repositoryRule(["src/context.ts"]);
    const sessions = ruleSessions(rule);
    const saved: ReviewRule[][] = [];
    await start({ mode: "empty", discoveryCalls: [
      { name: "grep", input: { pattern: "not-present" } },
      { name: "glob", input: { pattern: "src/context.ts" } },
      { name: "grep", input: { pattern: "referenceAmount" } },
      { name: "read", input: { file_path: "src/payment.ts" } },
    ] });
    const result = await runtime.review({ ...input(), repositoryRules: sessions.factory,
      onRules: async (rules) => { saved.push(structuredClone(rules)); } });
    const requests = mock!.requests;
    for (const request of requests.slice(0, 3)) expect(JSON.stringify(request.body)).not.toContain(rule.body);
    expect(JSON.stringify(requests[3]!.body)).toContain(rule.body);
    expect(result.readFiles).toContainEqual({ path: "src/context.ts", startLine: 1, endLine: 1, tool: "grep", phase: "generator" });
    expect(sessions.sessions[0]!.map((call) => call.paths)).toEqual([["src/context.ts"], ["src/payment.ts"]]);
    expect(saved).toEqual([[rule]]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("同一规范的后续匹配路径继续入快照，Grader 首次读取也独立发现规范", async () => {
    await writeFile(join(cwd, "src/context.ts"), "export const value = 1;\n");
    const local = repositoryRule(["src/payment.ts", "src/context.ts"]);
    const global: ReviewRule = { ...repositoryRule(), id: "G-001", body: "GLOBAL_RULE_SENTINEL",
      file: { ...repositoryRule().file, kind: "global", path: ".ureview/global-rules.json" } };
    const sessions = ruleSessions(local);
    const saved: ReviewRule[][] = [];
    await start({ discoveryCalls: [{ name: "read", input: { file_path: "src/payment.ts" } }],
      graderCalls: [{ name: "read", input: { file_path: "src/context.ts" } }] });
    await runtime.review({ ...input(), rules: [global], repositoryRules: sessions.factory,
      onRules: async (rules) => { saved.push(structuredClone(rules)); } });
    expect(saved).toEqual([[global, { ...local, matchedPaths: ["src/payment.ts"] }], [global, local]]);
    const grading = mock!.requests.filter((request) => request.body.model === "fixture-grader");
    expect(JSON.stringify(grading[0]!.body)).toContain(global.body);
    expect(JSON.stringify(grading[0]!.body)).not.toContain(local.body);
    expect(JSON.stringify(grading[1]!.body)).toContain(local.body);
    expect(sessions.sessions.map((calls) => calls.map((call) => call.paths)))
      .toEqual([[["src/payment.ts"]], [["src/context.ts"]]]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each(["unmatched", "index-only"] as const)("仓库规范引用 %s 不成为 finding 的依据", async (mode) => {
    const rule = repositoryRule(["src/context.ts"]);
    const sessions = ruleSessions(rule);
    await start({ candidates: [{ title: "扣款缺少校验", description: "金额可以为负数", severity: "high", ruleId: rule.id,
      location: { path: "src/payment.ts", startLine: 1, endLine: 3 },
      evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }], fixPrompt: "检查金额" }] });
    const repositoryRules = mode === "unmatched" ? sessions.factory : () => ({ resolve: async () => ({
      context: `规范索引：${rule.id}，正文尚未送达`, rules: [],
    }) });
    expect((await runtime.review({ ...input(), repositoryRules })).findings).toEqual([]);
    expect(JSON.stringify(mock!.requests)).toContain("评审结论引用了未注入或不适用于该位置的规范");
    expect(host!.activeAgentCount).toBe(0);
  });

  it("规范快照保存失败不能被工具协议吞掉后作为成功评审", async () => {
    await start();
    const sessions = ruleSessions();
    const findings: FindingCandidate[] = [];
    await expect(runtime.review({ ...input(async (finding) => { findings.push(finding); }),
      repositoryRules: sessions.factory, onRules: async () => { throw new Error("人工存储故障"); },
    })).rejects.toMatchObject({ code: "rules_write_failed" });
    expect(findings).toEqual([]);
    expect(JSON.stringify(mock!.requests)).not.toContain(repositoryRule().body);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("显式允许同厂商时完成两个独立模型阶段并保留真实厂商", async () => {
    mock = await startMockModelServer();
    const models = { ...mock.models, allowSameVendor: true,
      generator: { ...mock.models.generator, vendor: "deepseek" },
      grader: { ...mock.models.grader, vendor: "deepseek" } };
    host = await bootReviewHost({ homeDir: join(directory, "home"), models,
      onReady: async (created) => { runtime = created; return async () => {}; } });
    const result = await runtime.review(input());
    expect(result.findings[0]).toMatchObject({ score: 88,
      generatorModel: { vendor: "deepseek", provider: "ureview-generator", model: "fixture-generator" },
      graderModel: { vendor: "deepseek", provider: "ureview-grader", model: "fixture-grader" } });
    expect(mock.requests.some((request) => request.body.model === "fixture-generator")).toBe(true);
    expect(mock.requests.some((request) => request.body.model === "fixture-grader")).toBe(true);
    expect(host.activeAgentCount).toBe(0);
  });

  it.each(["valid", "missing", "wrong-path"] as const)("规范引用分支 %s 验证注入、评分和位置约束", async (mode) => {
    const rule: ReviewRule = { id: "R-007", body: "扣款金额必须为正数", source: { kind: "manual" },
      file: { kind: "repository", repositoryId: "fixture", repositoryName: "commerce/payment-gateway", path: ".ureview/rules.json",
        commitSha: "a".repeat(40), url: "https://gitlab.example.test/commerce/payment-gateway/-/blob/aaaa/.ureview/rules.json" },
      matchedPaths: mode === "wrong-path" ? ["src/other.ts"] : ["src/payment.ts"] };
    await start({ candidates: [{ title: "负数扣款", description: "扣款入口允许负数", severity: "high", ruleId: "R-007",
      location: { path: "src/payment.ts", startLine: 1, endLine: 3 }, evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }],
      fixPrompt: "校验金额为正数" }] });
    const request = { ...input(), rules: mode === "missing" ? [] : [rule] };
    if (mode !== "valid") {
      expect((await runtime.review(request)).findings).toEqual([]);
      expect(JSON.stringify(mock!.requests)).toContain("评审结论引用了未注入或不适用于该位置的规范");
    } else {
      expect((await runtime.review(request)).findings[0]).toMatchObject({ ruleId: "R-007", score: 88 });
      for (const model of ["fixture-generator", "fixture-grader"]) {
        expect(JSON.stringify(mock!.requests.filter((item) => item.body.model === model))).toContain(rule.body);
      }
    }
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each([["error", "high"], ["warning", "medium"], ["recommendation", "low"]] as const)("数据库规范 %s 确定性覆盖模型严重度，在两个阶段保留类别与示例，快照保留版本", async (ruleSeverity, severity) => {
    const rule: ReviewRule = { ...mockRuleDraft, severity: ruleSeverity, id: "managed:payment-policy", source: { kind: "generated" },
      file: { kind: "database", ruleId: "payment-policy", version: 3, scope: "repositories" }, matchedPaths: ["src/payment.ts"] };
    const saved: FindingCandidate[] = [];
    const snapshots: ReviewRule[][] = [];
    await start({ candidates: [{ title: "金额缺少校验", description: "扣款入口允许负数", severity: severity === "high" ? "low" : "high", ruleId: rule.id,
      location: { path: "src/payment.ts", startLine: 1, endLine: 3 }, evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }], fixPrompt: "校验正整数分" }] });
    const output = await runtime.review({ ...input(async (finding) => { saved.push(finding); }), rules: [rule],
      repositoryRules: ruleSessions().factory, onRules: async (rules) => { snapshots.push(structuredClone(rules)); } });
    expect(saved[0]).toMatchObject({ ruleId: rule.id, ruleCategory: "correctness", ruleSeverity, severity });
    expect(output.findings[0]).toMatchObject({ ruleCategory: "correctness", ruleSeverity, severity });
    expect(snapshots.every((snapshot) => snapshot.find((entry) => entry.id === rule.id)?.file)).toBe(true);
    expect(snapshots.at(-1)?.find((entry) => entry.id === rule.id)).toEqual(rule);
    for (const model of ["fixture-generator", "fixture-grader"]) {
      const messages = mock!.requests.find((request) => request.body.model === model)!.body.messages
        .flatMap((message) => typeof message.content === "string" ? [message.content] : message.content.map((part) => part.text ?? "")).join("\n");
      expect(messages).toContain(rule.goodExample);
      expect(messages).toContain(rule.badExample);
      expect(messages).toContain(`"id":"${rule.id}"`);
      expect(messages).toContain(`"category":"${rule.category}"`);
      expect(messages).not.toContain(JSON.stringify(rule.file));
    }
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each(["git", "error", "warning", "recommendation"] as const)("判断题规范 %s 拒绝高危并接受中危重试，数据库映射遵守上限", async (kind) => {
    const rule: ReviewRule = kind === "git" ? { ...repositoryRule(), judgement: true }
      : { ...mockRuleDraft, judgement: true, severity: kind, id: "managed:smell", source: { kind: "manual" },
        file: { kind: "database", ruleId: "smell", version: 1, scope: "global" }, matchedPaths: ["src/payment.ts"] };
    const finding = { ...candidate("可能的 Feature Envy"), ruleId: rule.id };
    const saved: FindingCandidate[] = [];
    const submissions: ReportSubmission[] = [];
    const snapshots: ReviewRule[][] = [];
    await start({ generatorScript: [readStep(),
      { name: "report_finding", input: finding, result: { isError: true, includes: "severity 改为 medium" } },
      { name: "report_finding", input: { ...finding, severity: "medium" }, result: { isError: false } }, fileGroupsStep(), finishStep(1),
    ] });
    const request = input(async (accepted) => { saved.push(accepted); });
    const output = await runtime.review({ ...request,
      ...(kind === "git" ? { repositoryRules: ruleSessions({ ...repositoryRule(), judgement: true }).factory } : { rules: [rule] }),
      onRules: async (rules) => { snapshots.push(rules); },
      onReportSubmission: async (submission) => { submissions.push(submission); },
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: finding.title, ruleId: rule.id, severity: kind === "recommendation" ? "low" : "medium" });
    expect(output.findings).toHaveLength(1);
    expect(output.findings[0]!.severity).toBe(saved[0]!.severity);
    expect(submissions.filter((submission) => submission.tool === "report_finding")).toEqual([
      expect.objectContaining({ outcome: "rejected", code: "judgement_severity_exceeded", reason: expect.stringContaining("重新提交") }),
      expect.objectContaining({ outcome: "accepted", code: null }),
    ]);
    if (kind === "git") expect(snapshots.at(-1)?.find((entry) => entry.id === rule.id)?.judgement).toBe(true);
    for (const model of ["fixture-generator", "fixture-grader"]) {
      const messages = JSON.stringify(mock!.requests.filter((request) => request.body.model === model));
      for (const text of [rule.body, "判断题规范", "可能的 X", "依据与例外情形", "最高为中危", "以团队规范为准"]) {
        expect(messages).toContain(text);
      }
    }
    expect(host!.activeAgentCount).toBe(0);
  });

  it("实际执行只读工具、逐条持久化回调、异厂商评分，并释放全部会话", async () => {
    await start();
    const saved: FindingCandidate[] = [];
    const result = await runtime.review(input(async (finding) => { saved.push(finding); }));

    expect(saved).toHaveLength(1);
    expect(result.fileGroups).toEqual(makeMockFileGroups());
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: saved[0]!.id, code: source.trimEnd(), score: 88,
      generatorModel: { vendor: "fixture-vendor-a", provider: "ureview-generator" },
      graderModel: { vendor: "fixture-vendor-b", provider: "ureview-grader" }, ruleId: null });
    expect(result.findings[0]!.evidence[0]!.url).toContain(`/-/blob/${"a".repeat(40)}/src/payment.ts#L1-3`);
    expect(result.findings[0]!.evidence[0]!.code).toBe(source.trimEnd());
    expect(result.findings[0]!.anchor).toMatchObject({ path: "src/payment.ts", startLine: 1, endLine: 3 });
    expect(result.readFiles).toContainEqual({ path: "src/payment.ts", startLine: 1, endLine: 3, tool: "read", phase: "generator" });
    expect(result.readFiles).toContainEqual({ path: "src/payment.ts", startLine: 1, endLine: 2, tool: "grep", phase: "generator" });
    expect(host!.activeAgentCount).toBe(0);
    const requests = mock!.requests;
    expect(new Set(requests.map((request) => request.body.model))).toEqual(new Set(["fixture-generator", "fixture-grader"]));
    const serialized = JSON.stringify(requests);
    expect(serialized).toContain("return amount - 1");
    expect(serialized).not.toContain("UNTRUSTED_AUTOMATIC_INSTRUCTION_SENTINEL");
    expect(serialized).not.toContain("session_log");
    expect(serialized).not.toContain("plugin_packages");
    for (const request of requests) {
      expect(request.url).toMatch(/^\/v1\/messages/);
      expectResponseLanguageLast(request.body.system);
      const allowed = request.body.model === "fixture-grader" ? ["read", "grep", "glob", "grade_finding"]
        : ["read", "grep", "glob", "report_file_groups", "report_finding", "finish_report"];
      expect(request.body.tools?.map((tool) => tool.name).sort()).toEqual(allowed.sort());
    }
    const paths = await storedFiles(join(directory, "home"));
    expect(paths.some((path) => /session\.v|session_projcache|sessions\//.test(path))).toBe(false);
    expect(await readFile(join(cwd, "src/payment.ts"), "utf8")).toBe(source);
  });

  it("保留各条模型评分，高危与中危都有代码锚", async () => {
    await start({ candidates: ["high", "medium"].map((severity) => ({
      title: "扣款入口缺少校验", description: "负数金额进入扣款逻辑", severity: severity as "high" | "medium",
      location: { path: "src/payment.ts", startLine: 1, endLine: 3 },
      evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }],
      fixPrompt: "补充正数金额校验",
    })), scores: [93, 74] });
    const result = await runtime.review(input());
    expect(result.findings.map((finding) => finding.score)).toEqual([93, 74]);
    expect(result.findings.map((finding) => finding.anchor)).toEqual(["high", "medium"].map(() =>
      expect.objectContaining({ path: "src/payment.ts", startLine: 1, endLine: 3, side: "new" })));
    expect(result.fileGroups).toEqual(makeMockFileGroups());
    expect(host!.activeAgentCount).toBe(0);
  });

  it("同轮文件分组包含新增、改名与删除文件，没有遗漏", async () => {
    await start();
    const request = input();
    request.files.push(
      { oldPath: "docs/old.md", newPath: "docs/new.md", patch: "", newFile: false, deletedFile: false, renamedFile: true },
      { oldPath: "docs/deleted.md", newPath: "docs/deleted.md", patch: "", newFile: false, deletedFile: true, renamedFile: false },
      { oldPath: "docs/added.md", newPath: "docs/added.md", patch: "", newFile: true, deletedFile: false, renamedFile: false },
    );
    const result = await runtime.review(request);
    expect(result.fileGroups.flatMap((group) => group.files.map((file) => file.path)))
      .toEqual(["src/payment.ts", "docs/new.md", "docs/deleted.md", "docs/added.md"]);
    expect(result.findings).toHaveLength(1);
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each([
    ["empty", undefined, 0], ["no-report", "file_groups_missing", 0], ["model-error", "model_unavailable", 0],
    ["missing-grade", "grade_missing", 0], ["invalid-range", undefined, 0],
    ["missing-file-groups", "file_groups_missing", 0], ["invalid-file-groups", "file_groups_missing", 0], ["duplicate-file-groups", undefined, 1],
  ] as const)("模型分支 %s 具有明确结果且没有遗留会话", async (mode, errorCode, count) => {
    await start({ mode });
    if (errorCode) await expect(runtime.review(input())).rejects.toMatchObject({ code: errorCode });
    else {
      const result = await runtime.review(input());
      expect(result.findings).toHaveLength(count);
      expect(result.fileGroups).toEqual(makeMockFileGroups());
    }
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each(["schema", "content"] as const)("文件分组校验拒绝后根据工具回执修正可完成评审：%s", async (kind) => {
    const invalid = kind === "schema" ? { fileGroups: "先前模型误传为字符串" }
      : { fileGroups: [{ name: "无效路径", files: [{ path: "unrelated.ts", theme: "不属于本次改动" }] }] };
    await start({ generatorScript: [
      { name: "report_file_groups", input: invalid, result: { isError: true } }, fileGroupsStep(), finishStep(0),
    ] });
    const result = await runtime.review(input());
    expect(result.fileGroups).toEqual(makeMockFileGroups());
    expect(result.findings).toEqual([]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("被拒绝后放弃的无效 finding 不成为报告的一部分", async () => {
    await start({ generatorScript: [
      { name: "report_finding", input: { location: "PRIVATE_ARGUMENT_SENTINEL" }, result: { isError: true, includes: "invalid arguments" } },
      fileGroupsStep(), finishStep(0),
    ] });
    const saved: FindingCandidate[] = [];
    const result = await runtime.review(input(async (finding) => { saved.push(finding); }));
    expect(saved).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ARGUMENT_SENTINEL");
    expect(mock!.requests.some((request) => request.body.model === "fixture-grader")).toBe(false);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("无效代码范围返回可修正原因，不保存被拒绝的结论", async () => {
    const invalid = candidate();
    invalid.location.endLine = 99999;
    await start({ generatorScript: [readStep(),
      { name: "report_finding", input: invalid, result: { isError: true, includes: "评审结论引用的行号不存在" } },
      fileGroupsStep(), finishStep(0),
    ] });
    const saved: FindingCandidate[] = [];
    expect((await runtime.review(input(async (finding) => { saved.push(finding); }))).findings).toEqual([]);
    expect(saved).toEqual([]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each([
    ["含 NUL", "src/payment\0.ts", "代码位置须使用仓库相对路径"],
    ["文件不存在", "src/missing.ts", "代码位置没有对应的文件"],
  ] as const)("finding 主位置%s时拒绝当前提交，修正路径后完成评审", async (_, path, reason) => {
    const complete = candidate();
    await start({ generatorScript: [readStep(),
      { name: "report_finding", input: { ...complete, location: { ...complete.location, path } },
        result: { isError: true, includes: reason } },
      { name: "report_finding", input: complete, result: { isError: false } }, fileGroupsStep(), finishStep(1),
    ] });
    const saved: FindingCandidate[] = [];
    const result = await runtime.review(input(async (finding) => { saved.push(finding); }));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject(complete);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: saved[0]!.id, location: complete.location, score: 88 });
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each(["missing", "empty"] as const)("finding 的 fixPrompt %s 后根据回执补齐，均只保存有效提交", async (kind) => {
    const complete = candidate();
    const { fixPrompt: _, ...withoutPrompt } = complete;
    await start({ generatorScript: [readStep(),
      { name: "report_finding", input: kind === "missing" ? withoutPrompt : { ...complete, fixPrompt: " " },
        result: { isError: true, includes: "fixPrompt" } },
      { name: "report_finding", input: complete, result: { isError: false } }, fileGroupsStep(), finishStep(1),
    ] });
    const saved: FindingCandidate[] = [];
    const submissions: ReportSubmission[] = [];
    const result = await runtime.review({ ...input(async (finding) => { saved.push(finding); }),
      onReportSubmission: async (submission) => { submissions.push(submission); } });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject(complete);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: saved[0]!.id, score: 88 });
    expect(submissions.map(({ phase, tool, outcome, code }) => ({ phase, tool, outcome, code }))).toEqual([
      { phase: "generator", tool: "report_finding", outcome: "rejected", code: kind === "missing" ? "INVALID_ARGS" : "invalid_finding" },
      { phase: "generator", tool: "report_finding", outcome: "accepted", code: null },
      { phase: "generator", tool: "report_file_groups", outcome: "accepted", code: null },
      { phase: "generator", tool: "finish_report", outcome: "accepted", code: null },
      { phase: "grader", tool: "grade_finding", outcome: "accepted", code: null },
    ]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("证据尚未读取时收到拒绝，补读修正后接受三条结论并进入评分", async () => {
    const findings = [candidate("扣款缺少边界检查"), candidate("金额缺少整数检查"), candidate("缺少余额不足处理")];
    await start({ generatorScript: [readStep(1, 1),
      { name: "report_finding", input: findings[0]!, result: { isError: true, includes: "尚未读取的代码" } },
      readStep(2, 2),
      ...findings.map((finding) => ({ name: "report_finding", input: finding, result: { isError: false } })),
      fileGroupsStep(), finishStep(3),
    ], scores: [91, 85, 72] });
    const saved: FindingCandidate[] = [];
    const result = await runtime.review(input(async (finding) => { saved.push(finding); }));
    expect(saved.map((finding) => finding.title)).toEqual(findings.map((finding) => finding.title));
    expect(result.findings.map((finding) => finding.score)).toEqual([91, 85, 72]);
    expect(result.findings.map((finding) => finding.id)).toEqual(saved.map((finding) => finding.id));
    expect(host!.activeAgentCount).toBe(0);
  });

  it("结论被拒后补读并成功重试，真实上下文压缩后仍保留读取证据并完成两条结论", async () => {
    const first = candidate("扣款缺少边界检查");
    const second = candidate("金额缺少整数检查");
    await start({ compactAfterGeneratorSteps: 4, generatorScript: [readStep(1, 1),
      { name: "report_finding", input: first, result: { isError: true, includes: "尚未读取的代码" } },
      readStep(2, 2),
      { name: "report_finding", input: first, result: { isError: false } },
      { name: "report_finding", input: second, result: { isError: false } }, fileGroupsStep(), finishStep(2),
    ] });
    const saved: FindingCandidate[] = [];
    const submissions: ReportSubmission[] = [];
    const result = await runtime.review({ ...input(async (finding) => { saved.push(finding); }),
      onReportSubmission: async (submission) => { submissions.push(submission); } });
    expect(mock!.compactionRequests).toBe(1);
    const compactedRequest = mock!.requests.find((request) => JSON.stringify(request.body.messages)
      .includes("This is an automatically generated checkpoint"));
    expect(compactedRequest).toBeDefined();
    expect(JSON.stringify(compactedRequest!.body.messages)).not.toContain("return amount - 1");
    expect(saved.map((finding) => finding.title)).toEqual([first.title, second.title]);
    expect(result.findings.map((finding) => finding.id)).toEqual(saved.map((finding) => finding.id));
    expect(result.findings.every((finding) => finding.score === 88 && finding.code === source.trimEnd())).toBe(true);
    expect(result.readFiles).toEqual([
      { path: "src/payment.ts", startLine: 1, endLine: 1, tool: "read", phase: "generator" },
      { path: "src/payment.ts", startLine: 2, endLine: 3, tool: "read", phase: "generator" },
    ]);
    expect(submissions.filter((submission) => submission.outcome === "rejected")).toEqual([
      expect.objectContaining({ tool: "report_finding", code: "unread_evidence" }),
    ]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("提交记录保存失败是致命故障，后续成功调用不能覆盖", async () => {
    await start({ generatorScript: [
      { name: "report_finding", input: candidate(), result: { isError: true, includes: "尚未读取的代码" } },
      { name: "report_file_groups", input: { fileGroups: makeMockFileGroups() }, result: { isError: true, includes: "评审提交记录保存失败" } },
    ] });
    await expect(runtime.review({ ...input(), onReportSubmission: async () => { throw new Error("PRIVATE_SUBMISSION_STORAGE_SENTINEL"); } }))
      .rejects.toMatchObject({ code: "report_submission_write_failed" });
    expect(JSON.stringify(mock!.requests)).not.toContain("PRIVATE_SUBMISSION_STORAGE_SENTINEL");
    expect(host!.activeAgentCount).toBe(0);
  });

  it("持续无效提交达到阶段步骤上限时停止模型调用并保留明确失败原因", async () => {
    await start({ generatorScript: Array.from({ length: REVIEW_STEP_LIMIT + 1 }, () => ({
      name: "report_finding", input: {}, result: { isError: true },
    })) });
    const submissions: ReportSubmission[] = [];
    await expect(runtime.review({ ...input(), onReportSubmission: async (submission) => { submissions.push(submission); } }))
      .rejects.toMatchObject({ code: "review_budget_exceeded", message: expect.stringContaining(String(REVIEW_STEP_LIMIT)) });
    expect(mock!.requests).toHaveLength(REVIEW_STEP_LIMIT);
    expect(submissions).toHaveLength(REVIEW_STEP_LIMIT);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("规范引用被拒绝后可修正为普通缺陷", async () => {
    const complete = candidate();
    await start({ generatorScript: [readStep(),
      { name: "report_finding", input: { ...complete, ruleId: "missing-rule" },
        result: { isError: true, includes: "未注入或不适用于该位置的规范" } },
      { name: "report_finding", input: complete, result: { isError: false } }, fileGroupsStep(), finishStep(1),
    ] });
    const saved: FindingCandidate[] = [];
    const result = await runtime.review(input(async (finding) => { saved.push(finding); }));
    expect(saved).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ ruleId: null, score: 88 });
    expect(host!.activeAgentCount).toBe(0);
  });

  it("提前完成报告收到缺项回执后仍可提交文件分组并重新完成", async () => {
    await start({ generatorScript: [
      { name: "finish_report", input: {}, result: { isError: true, includes: "report_file_groups" } },
      fileGroupsStep(), finishStep(0),
    ] });
    const result = await runtime.review(input());
    expect(result.fileGroups).toEqual(makeMockFileGroups());
    expect(result.findings).toEqual([]);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("文件分组已经接受但未完成报告时仍失败", async () => {
    await start({ generatorScript: [fileGroupsStep()] });
    await expect(runtime.review(input())).rejects.toMatchObject({ code: "report_missing" });
    expect(host!.activeAgentCount).toBe(0);
  });

  it("重复提交文件分组和评分只拒绝重复操作，并保留先前接受的内容", async () => {
    await start({ generatorScript: [readStep(),
      { name: "report_finding", input: candidate(), result: { isError: false } }, fileGroupsStep(),
      { name: "report_file_groups", input: { fileGroups: [{ name: "重复提交不能覆盖", files: [{ path: "src/payment.ts", theme: "重复" }] }] }, result: { isError: true } },
      finishStep(1),
    ], graderScript: [
      { name: "grade_finding", input: ([findingId]) => ({ findingId, score: 90 }), result: { isError: false, includes: "评分已记录" } },
      { name: "grade_finding", input: ([findingId]) => ({ findingId, score: 20 }), result: { isError: true } },
    ] });
    const saved: FindingCandidate[] = [];
    const result = await runtime.review(input(async (finding) => { saved.push(finding); }));
    expect(saved).toHaveLength(1);
    expect(result.fileGroups).toEqual(makeMockFileGroups());
    expect(result.findings[0]).toMatchObject({ score: 90 });
    expect(host!.activeAgentCount).toBe(0);
  });

  it("保存失败终止后续报告写入与完成，保留明确错误码并隐藏原始异常", async () => {
    await start({ generatorScript: [readStep(),
      { name: "report_finding", input: { title: "初步问题" }, result: { isError: true } },
      { name: "report_finding", input: candidate(), result: { isError: true, includes: "评审结论保存失败" } },
      { name: "report_finding", input: candidate("模型重试"), result: { isError: true, includes: "评审结论保存失败" } },
      { name: "report_file_groups", input: { fileGroups: makeMockFileGroups() }, result: { isError: true, includes: "评审结论保存失败" } },
      { name: "finish_report", input: {}, result: { isError: true, includes: "评审结论保存失败" } },
    ] });
    let writes = 0;
    await expect(runtime.review(input(async () => { writes++; throw new Error("PRIVATE_STORAGE_SENTINEL"); })))
      .rejects.toMatchObject({ code: "finding_write_failed", message: "评审结论保存失败" });
    expect(writes).toBe(1);
    expect(JSON.stringify(mock!.requests)).not.toContain("PRIVATE_STORAGE_SENTINEL");
    expect(mock!.requests.some((request) => request.body.model === "fixture-grader")).toBe(false);
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each([101, NaN])("Grader 的无效评分 %s 未修正时仍缺少必需评分", async (score) => {
    await start({ scores: [score] });
    await expect(runtime.review(input())).rejects.toMatchObject({ code: "grade_missing" });
    expect(host!.activeAgentCount).toBe(0);
  });

  it("Grader 根据越界评分的拒绝回执重新提交有效评分", async () => {
    await start({ graderScript: [
      { name: "grade_finding", input: ([findingId]) => ({ findingId, score: 101 }), result: { isError: true } },
      { name: "grade_finding", input: ([findingId]) => ({ findingId, score: 90 }), result: { isError: false, includes: "评分已记录" } },
    ] });
    const result = await runtime.review(input());
    expect(result.findings[0]).toMatchObject({ score: 90 });
    expect(host!.activeAgentCount).toBe(0);
  });

  it("Grader 只完成部分已接受结论的评分时仍失败", async () => {
    await start({ candidates: [candidate("金额边界"), candidate("余额不足")], graderScript: [
      { name: "grade_finding", input: ([findingId]) => ({ findingId, score: 90 }), result: { isError: false, includes: "评分已记录" } },
    ] });
    await expect(runtime.review(input())).rejects.toMatchObject({ code: "grade_missing" });
    expect(host!.activeAgentCount).toBe(0);
  });

  it("追溯使用工具实际返回的行，不把请求窗口和文件发现当作已读内容", async () => {
    await start({ extraCalls: [
      { name: "read", input: { file_path: "src/payment.ts", offset: 2, limit: 999 } },
      { name: "read", input: { file_path: "missing.ts" } },
    ] });
    const result = await runtime.review(input());
    expect(result.readFiles).toContainEqual({ path: "src/payment.ts", startLine: 2, endLine: 3,
      tool: "read", phase: "generator" });
    expect(result.readFiles.every((read) => read.endLine <= 3 && read.path === "src/payment.ts")).toBe(true);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("工具在读取前拒绝越界路径和外部符号链接，模型看不到外部内容", async () => {
    const outside = join(directory, "private.txt");
    await writeFile(outside, "OUTSIDE_SECRET_SENTINEL");
    await symlink(outside, join(cwd, "external.txt"));
    await start({ extraCalls: [
      { name: "read", input: { file_path: "../private.txt" } },
      { name: "read", input: { file_path: outside } },
      { name: "read", input: { file_path: "external.txt" } },
      { name: "grep", input: { pattern: "OUTSIDE_SECRET", path: "../" } },
      { name: "grep", input: { pattern: "OUTSIDE_SECRET", path: "external.txt" } },
      { name: "glob", input: { pattern: "*", path: "../" } },
      { name: "glob", input: { pattern: "*", path: directory } },
      { name: "grep", input: { pattern: "OUTSIDE_SECRET" } },
    ] });
    const result = await runtime.review(input());
    expect(result.findings).toHaveLength(1);
    const serialized = JSON.stringify(mock!.requests);
    expect(serialized).not.toContain("OUTSIDE_SECRET_SENTINEL");
    expect(serialized).toContain("只能读取本次评审的工作副本");
    expect(result.readFiles.every((read) => read.path === "src/payment.ts")).toBe(true);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("未配置模型时接入服务照常启动，评审返回明确错误", async () => {
    host = await bootReviewHost({ homeDir: join(directory, "home"),
      onReady: async (created) => { runtime = created; return async () => {}; } });
    await expect(runtime.review(input())).rejects.toMatchObject({ code: "models_not_configured" });
    expect(host.activeAgentCount).toBe(0);
  });
});
