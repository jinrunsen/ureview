import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { createTenantPool, DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import { CredentialCipher } from "../repositories/credentials.js";
import { RepositoryService } from "../repositories/service.js";
import { testServerUrl } from "../test-support.js";
import { registerRuleCatalogRoutes, RuleCatalogService } from "./catalog.js";
import { withIdentity } from "../auth/context.js";
import { mineHistory, groupCandidates, type AdoptionEvidence } from "./mining.js";
import { GitLabHistoryReader } from "./history.js";

import { startCatalogGitLab, head, beforeSha, afterSha, ruleBody } from "./catalog/test-support.js";
let fixture: Awaited<ReturnType<typeof startCatalogGitLab>>;
let directoryName = "", roleName = "", pool: pg.Pool | undefined, adminPool: pg.Pool | undefined;
let repositories: RepositoryService, catalog: RuleCatalogService, repositoryId: string;

beforeEach(async () => {
  directoryName = `ureview_rules_${randomUUID().replaceAll("-", "")}`;
  roleName = `rules_${randomUUID().replaceAll("-", "")}`;
  fixture = await startCatalogGitLab();
  const admin = new pg.Client({ connectionString: testServerUrl });
  try { await admin.connect(); await admin.query(`CREATE DATABASE ${directoryName}`); await admin.query(`CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOBYPASSRLS`); }
  finally { await admin.end(); }
  const url = new URL(testServerUrl); url.pathname = `/${directoryName}`;
  adminPool = new pg.Pool({ connectionString: url.toString() });
  await runMigrations(adminPool, fileURLToPath(new URL("../../migrations", import.meta.url)));
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
  await adminPool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`);
  url.searchParams.set("options", `-c role=${roleName}`);
  pool = createTenantPool(url.toString());
  const cipher = new CredentialCipher(randomBytes(32));
  const instanceUrl = fixture.instanceUrl;
  repositories = new RepositoryService(pool, { verify: async (input) => ({ instanceUrl, projectId: input.projectPath === "team/payment" ? 10 : 11, name: "payment", pathWithNamespace: input.projectPath,
    webUrl: `${instanceUrl}/team/payment`, httpUrlToRepo: `${instanceUrl}/team/payment.git` }) }, cipher);
  repositoryId = (await withTeam(DEFAULT_TEAM_ID, () => repositories.connect({ instanceUrl, projectPath: "team/payment", token: "fixture-token" }))).repository.id;
  catalog = new RuleCatalogService(pool, repositories);
});

afterEach(async () => {
  await pool?.end(); pool = undefined;
  await adminPool?.end(); adminPool = undefined;
  await fixture?.close();
  const admin = new pg.Client({ connectionString: testServerUrl });
  try { await admin.connect(); if (directoryName) await admin.query(`DROP DATABASE IF EXISTS ${directoryName} WITH (FORCE)`); if (roleName) await admin.query(`DROP ROLE IF EXISTS ${roleName}`); }
  finally { await admin.end(); }
});

describe("规范目录与有依据的冷启动", () => {
  it.each([
    { description: "PR 作者未公开邮箱", publicEmail: "", commitEmail: "author@example.test" },
    { description: "提交者邮箱与 PR 作者不同", publicEmail: "author@example.test", commitEmail: "maintainer@example.test" },
    { description: "提交者邮箱缺失", publicEmail: "", commitEmail: null },
  ])("挖掘按代码落实证据生成候选并省去作者查询：$description", async ({ publicEmail, commitEmail }) => withTeam(DEFAULT_TEAM_ID, async () => {
    fixture.state.publicEmail = publicEmail;
    fixture.state.commitEmail = commitEmail;
    expect((await catalog.mine(repositoryId)).added).toBe(1);
    const candidates = (await catalog.candidates(repositoryId)).candidates;
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ body: ruleBody, active: false });
    expect(candidates[0]?.evidence.map(({ iid, author }) => ({ iid, author }))).toEqual([
      { iid: 1, author: commitEmail ?? "" }, { iid: 2, author: commitEmail ?? "" },
    ]);
    expect(fixture.requests.some((request) => request.includes("/users/"))).toBe(false);
  }));

  it("GitLab 限流保留候选与挖掘时间，并明确提示稍后重试", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    fixture.state.discussionStatus = 429;
    await expect(catalog.mine(repositoryId)).rejects.toThrow("GitLab 请求限流");
    const state = await catalog.candidates(repositoryId);
    expect(state.candidates).toEqual([]);
    expect(state.sync[0]).toMatchObject({ minedAt: null, miningError: expect.stringContaining("GitLab 请求限流") });
    expect(fixture.requests.filter((request) => request.includes("/discussions?"))).toHaveLength(1);
    expect(state.sync[0]?.miningError).not.toContain("PRIVATE_UPSTREAM_ERROR");
    fixture.state.discussionStatus = 200;
    expect((await catalog.mine(repositoryId)).added).toBe(1);
  }));

  it("同步不读取旧全局规范文件，旧 Git 全局缓存不进入当前目录", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    fixture.state.failedFiles.add(".ureview/global-rules.json");
    await pool!.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,$2,$3)",
      [repositoryId, "G-legacy", JSON.stringify({ id: "G-legacy", scope: "global" })]);
    expect((await catalog.list()).rules).toEqual([]);
    await catalog.sync(repositoryId);
    expect((await catalog.list(repositoryId)).rules).toHaveLength(2);
    expect(fixture.requests.some((request) => decodeURIComponent(request).includes("global-rules.json"))).toBe(false);
  }));

  it("目录接口独立展示各层直属 lint，保留提交与路径信息且不执行脚本", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    const rootPath = ".agents/lints/payment.mjs", nestedPath = "packages/pay/.agents/lints/check.mjs";
    const body = 'export const meta = { name: "金额检查", description: "检查扣款参数", paths: ["src/**"], args: ["--strict"] };\nthrow new Error("不得执行");\n';
    fixture.state.files[rootPath] = body;
    fixture.state.files[nestedPath] = 'export const meta = { paths: ["src/**/*.ts"] };\nprocess.exit(91);\n';
    fixture.state.files[".agents/lints/nested/ignored.mjs"] = body;
    fixture.state.files[".agents/rules/mixed.mjs"] = body;
    fixture.state.files[".agents/lints/symlink.mjs"] = body;
    fixture.state.fileModes[".agents/lints/symlink.mjs"] = "120000";
    await catalog.sync(repositoryId);
    const app = Fastify();
    registerRuleCatalogRoutes(app, { pool: pool!, repositories, service: catalog });
    try {
      await withIdentity({ userId: randomUUID(), username: "lina", email: "lina@example.test", name: "李娜", teamId: DEFAULT_TEAM_ID,
        teamName: "默认团队", role: "member" }, async () => {
        const response = await app.inject({ method: "GET", url: `/api/rules?repositoryId=${repositoryId}` });
        expect(response.statusCode).toBe(200);
        const result = response.json();
        expect(result.rules).toHaveLength(2);
        expect(result.lints).toHaveLength(2);
        expect(result.lints.map((lint: { id: string }) => lint.id)).toEqual([`lint:${nestedPath}`, `lint:${rootPath}`]);
        expect(result.lints[0]).toMatchObject({ name: "check", checkerRoot: "packages/pay", script: nestedPath, args: [] });
        expect(result.lints[1]).toEqual({ kind: "lint", id: `lint:${rootPath}`, name: "金额检查", description: "检查扣款参数",
          paths: ["src/**"], args: ["--strict"], checkerRoot: "", script: rootPath, body,
          file: { kind: "repository", repositoryId, repositoryName: "team/payment", path: rootPath, commitSha: head,
            url: `${fixture.instanceUrl}/team/payment/-/blob/${head}/${rootPath}` } });
      });
      expect(fixture.requests.every((request) => request.startsWith("GET "))).toBe(true);
      expect(fixture.requests.some((request) => /ignored|mixed|symlink/.test(request))).toBe(false);
    } finally { await app.close(); }
  }));

  it("lint 元数据逐文件降级，无效路径不妨碍其余有效配置", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    const source = (value: string) => `export const meta = ${value};`;
    fixture.state.files[".agents/lints/valid.mjs"] = source('{ paths: ["../outside/**", "src/**", "C:/outside/**"] }');
    fixture.state.files[".agents/lints/dynamic.mjs"] = source('{ paths: getPaths() }');
    fixture.state.files[".agents/lints/invalid.mjs"] = source('{ paths: "src/**" }');
    fixture.state.files[".agents/lints/empty.mjs"] = source('{ paths: [] }');
    fixture.state.files[".agents/lints/no-paths.mjs"] = source('{ paths: ["/absolute/**", "../outside/**"] }');
    fixture.state.files[".agents/lints/no-meta.mjs"] = 'throw new Error("不得执行");';
    await catalog.sync(repositoryId);
    const result = await catalog.list(repositoryId);
    expect(result.rules).toHaveLength(2);
    expect(result.lints).toHaveLength(1);
    expect(result.lints[0]?.paths).toEqual(["src/**"]);
    for (const name of ["valid", "dynamic", "invalid", "empty", "no-paths", "no-meta"]) {
      expect(result.sync[0]?.warnings.some((warning) => warning.includes(`.agents/lints/${name}.mjs`))).toBe(true);
    }
  }));

  it("lint 外部脚本按注册目录解析，只接受仓库内的普通文件", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    const script = "scripts/check-payment.mjs";
    fixture.state.files[script] = 'throw new Error("不得执行外部脚本");';
    const add = (name: string, target: string) => {
      fixture.state.files[`.agents/lints/${name}.mjs`] = `export const meta = ${JSON.stringify({ paths: ["src/**"], script: target, args: ["--hook"] })};`;
    };
    add("valid", "../../scripts/check-payment.mjs");
    add("escape", "../../../outside.mjs");
    add("absolute", "/tmp/outside.mjs");
    add("windows", "C:\\outside.mjs");
    add("missing", "unregistered.mjs");
    add("link", "../../scripts/link.mjs");
    fixture.state.files["scripts/link.mjs"] = script;
    fixture.state.fileModes["scripts/link.mjs"] = "120000";
    await catalog.sync(repositoryId);
    const result = await catalog.list(repositoryId);
    expect(result.lints).toHaveLength(1);
    expect(result.lints[0]).toMatchObject({ script, args: ["--hook"], checkerRoot: "" });
    expect(result.sync[0]?.warnings).toHaveLength(5);
    expect(fixture.requests.some((request) => request.includes("outside.mjs"))).toBe(false);
  }));

  it("lint 更新与删除替换目录，规则配置关闭不停止 lint 扫描，其他团队不能访问", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    const lintPath = ".agents/lints/payment.mjs";
    fixture.state.files[lintPath] = 'export const meta = { paths: ["src/**"], name: "原检查" };';
    fixture.state.files[".sase-rule-inject.json"] = JSON.stringify({ rulesRoot: "docs/rules", enabled: false });
    await catalog.sync(repositoryId);
    expect((await catalog.list(repositoryId)).lints[0]?.name).toBe("原检查");
    fixture.state.files[lintPath] = 'export const meta = { paths: ["lib/**"], name: "新检查" };';
    await catalog.sync(repositoryId);
    expect((await catalog.list(repositoryId)).lints[0]).toMatchObject({ name: "新检查", paths: ["lib/**"] });
    const otherTeam = randomUUID();
    await adminPool!.query("INSERT INTO teams(id,name) VALUES($1,'其他团队')", [otherTeam]);
    await withTeam(otherTeam, async () => {
      expect((await catalog.list()).lints).toEqual([]);
      await expect(catalog.list(repositoryId)).rejects.toMatchObject({ code: "not_found" });
      await expect(catalog.sync(repositoryId)).rejects.toMatchObject({ code: "not_found" });
    });
    delete fixture.state.files[lintPath];
    await catalog.sync(repositoryId);
    expect((await catalog.list(repositoryId)).lints).toEqual([]);
  }));

  it("Git 规范与 lint 只属于各自的仓库", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    fixture.state.files[".agents/lints/payment.mjs"] = 'export const meta = { paths: ["src/**"] };';
    await catalog.sync(repositoryId);
    const secondary = (await repositories.connect({ instanceUrl: fixture.instanceUrl, projectPath: "team/orders", token: "fixture-token" })).repository.id;
    const inherited = await catalog.list(secondary);
    expect(inherited.rules).toEqual([]);
    expect(inherited.lints).toEqual([]);
    await catalog.sync(secondary);
    const local = await catalog.list(secondary);
    expect(local.lints).toHaveLength(1);
    expect(local.lints[0]?.file.repositoryId).toBe(secondary);
    expect((await catalog.list()).lints).toHaveLength(2);
  }));

  it("lint 注册或脚本读取失败保留完整旧快照，过大文件告警跳过", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    const lintPath = ".agents/lints/payment.mjs", script = "scripts/check.mjs";
    fixture.state.files[lintPath] = 'export const meta = { paths: ["src/**"], script: "../../scripts/check.mjs" };';
    fixture.state.files[script] = "process.exit(0);";
    await catalog.sync(repositoryId);
    const previous = await catalog.list(repositoryId);
    fixture.state.files[".agents/rules/payment.md"] = "---\npaths: [src/**]\n---\n未完成的目录更新\n";
    for (const path of [lintPath, script]) {
      fixture.state.failedFiles.add(path);
      await expect(catalog.sync(repositoryId)).rejects.toThrow("同步失败");
      const result = await catalog.list(repositoryId);
      expect(result.rules).toEqual(previous.rules);
      expect(result.lints).toEqual(previous.lints);
      expect(result.sync[0]?.syncedAt).toBe(previous.sync[0]?.syncedAt);
      fixture.state.failedFiles.clear();
    }
    fixture.state.files[".agents/lints/large.mjs"] = `export const meta = { paths: ["src/**"] };\n//${"x".repeat(1024 * 1024)}`;
    fixture.state.files[script] = "x".repeat(1024 * 1024 + 1);
    await catalog.sync(repositoryId);
    const result = await catalog.list(repositoryId);
    expect(result.lints).toEqual([]);
    expect(result.sync[0]?.warnings).toHaveLength(2);
    expect(result.sync[0]?.syncError).toBeNull();
  }));

  it("直接同步 Git 中未命中的路径规则及惰性文档，更新和删除随新快照可见", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    await catalog.sync(repositoryId);
    let result = await catalog.list(repositoryId);
    expect(result.rules).toHaveLength(2);
    expect(result.rules.find((rule) => rule.id.endsWith("lazy.md"))).toMatchObject({ lazy: true });
    delete fixture.state.files[".agents/rules/lazy.md"];
    fixture.state.files[".agents/rules/payment.md"] = "---\npaths: [src/**]\n---\n更新的规范正文\n";
    await catalog.sync(repositoryId);
    result = await catalog.list(repositoryId);
    expect(result.rules).toHaveLength(1);
    expect(result.rules.find((rule) => rule.id.endsWith("payment.md"))?.body).toBe("更新的规范正文");
    expect(fixture.requests.every((request) => request.startsWith("GET "))).toBe(true);
  }));

  it("失败保留上一次完整目录，跨团队列表和重新同步均无法访问", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    await catalog.sync(repositoryId);
    fixture.state.failedFiles.add(".agents/rules/payment.md");
    await expect(catalog.sync(repositoryId)).rejects.toThrow("同步失败");
    expect((await catalog.list()).rules).toHaveLength(2);
    expect((await catalog.list()).sync[0]?.syncError).toContain("保留上一次完整结果");
    const otherTeam = randomUUID();
    await adminPool!.query("INSERT INTO teams(id,name) VALUES($1,'其他团队')", [otherTeam]);
    await withTeam(otherTeam, async () => {
      expect((await catalog.list()).rules).toEqual([]);
      expect((await catalog.candidates()).candidates).toEqual([]);
      await expect(catalog.sync(repositoryId)).rejects.toMatchObject({ code: "not_found" });
    });
  }));

  it("评论后的精确修改跨两个 PR 重复时生成可复制候选", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    const mined = await catalog.mine(repositoryId);
    expect(mined.added).toBe(1);
    let candidates = (await catalog.candidates(repositoryId)).candidates;
    expect(candidates[0]).toMatchObject({ body: ruleBody, active: false });
    expect(candidates[0]?.evidence.map((entry) => entry.iid)).toEqual([1, 2]);
    const requests = fixture.state.requestCount;
    expect((await catalog.mine(repositoryId)).added).toBe(0);
    expect(fixture.state.requestCount).toBe(requests);
    fixture.state.files[candidates[0]!.suggestedPath] = candidates[0]!.markdown;
    await catalog.sync(repositoryId);
    candidates = (await catalog.candidates(repositoryId)).candidates;
    expect(candidates[0]?.active).toBe(true);
    const source = (await catalog.list(repositoryId)).rules.find((rule) => rule.file.path === candidates[0]!.suggestedPath);
    expect(source?.source).toEqual({ kind: "mined", url: candidates[0]!.evidence[0]!.commentUrl });
    expect((await catalog.list(repositoryId)).rules.find((rule) => rule.file.path === ".agents/rules/payment.md")?.source)
      .toEqual({ kind: "mined", url: candidates[0]!.evidence[0]!.commentUrl });
  }));

  it.each([false, true])("缺少代码落实证据时没有候选，讨论解决状态为 %s", async (resolved) => withTeam(DEFAULT_TEAM_ID, async () => {
    fixture.state.currentAfter = "const amount = input;\n";
    fixture.state.resolved = resolved;
    fixture.state.publicEmail = "";
    fixture.state.commitEmail = null;
    const credentials = await repositories.getCredentials(repositoryId);
    expect(await mineHistory(credentials, catalog.history)).toEqual({ candidates: [], scanned: 2, skippedNoAdoption: 2 });
    expect(fixture.requests.some((request) => request.includes("/users/"))).toBe(false);
  }));

  it("候选按仓库规则根生成路径，停用或惰性文件不标为生效，正文修改后不冒认挖掘来源", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    fixture.state.files[".sase-rule-inject.json"] = JSON.stringify({ rulesRoot: "./docs/rules//", enabled: false });
    expect((await catalog.mine(repositoryId)).added).toBe(1);
    const candidate = (await catalog.candidates(repositoryId)).candidates[0]!;
    expect(candidate.suggestedPath).toBe(`docs/rules/candidate-${candidate.key.slice(0, 12)}.md`);
    fixture.state.files[candidate.suggestedPath] = candidate.markdown;
    await catalog.sync(repositoryId);
    expect((await catalog.candidates(repositoryId)).candidates[0]?.active).toBe(false);
    expect((await catalog.list(repositoryId)).rules.find((rule) => rule.file.path === candidate.suggestedPath)).toMatchObject({
      enabled: false, source: { kind: "mined", url: candidate.evidence[0]!.commentUrl },
    });
    fixture.state.files[".sase-rule-inject.json"] = JSON.stringify({ rulesRoot: "docs/rules", enabled: true });
    await catalog.sync(repositoryId);
    expect((await catalog.candidates(repositoryId)).candidates[0]?.active).toBe(true);
    fixture.state.files[candidate.suggestedPath] = `---\nname: 惰性候选\n---\n${candidate.body}\n`;
    await catalog.sync(repositoryId);
    expect((await catalog.candidates(repositoryId)).candidates[0]?.active).toBe(false);
    fixture.state.files[candidate.suggestedPath] = candidate.markdown.replace(candidate.body, "金额校验由维护者修改为另一项约定。");
    await catalog.sync(repositoryId);
    expect((await catalog.list(repositoryId)).rules.find((rule) => rule.file.path === candidate.suggestedPath)?.source).toEqual({ kind: "manual" });
    expect((await catalog.candidates(repositoryId)).candidates[0]?.active).toBe(false);
  }));

  it("讨论读取完整分页，重复评论只按不同PR计数", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    fixture.state.discussionPage = true;
    const history = new GitLabHistoryReader(repositories);
    expect(await history.getDiscussions(repositoryId, 1)).toHaveLength(2);
    const evidence: AdoptionEvidence = { iid: 1, pullRequestUrl: "https://example.test/1", commentUrl: "https://example.test/1#note", author: "author@example.test",
      path: "src/payment.ts", before: "before", after: "after", beforeSha, afterSha, commitUrl: "https://example.test/commit" };
    expect(groupCandidates([{ body: ruleBody, evidence }, { body: ruleBody, evidence: { ...evidence, commentUrl: "another" } }])).toEqual([]);
  }));

  it("一个仓库的挖掘时间不消耗其他仓库的首次额度", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    const globalId = "00000000-0000-4000-8000-000000000002";
    await adminPool!.query("UPDATE repositories SET id=$1 WHERE id=$2", [globalId, repositoryId]);
    catalog = new RuleCatalogService(pool!, repositories);
    const secondary = (await repositories.connect({ instanceUrl: fixture.instanceUrl, projectPath: "team/orders", token: "fixture-token" })).repository.id;
    expect(globalId < secondary).toBe(true);
    await catalog.mine(globalId);
    expect((await catalog.mine(secondary)).added).toBe(1);
  }));

  it("成员可读取目录但不能同步或挖掘，未登录没有读取入口", async () => {
    const app = Fastify();
    registerRuleCatalogRoutes(app, { pool: pool!, repositories });
    const member = { userId: randomUUID(), username: "lina", email: "lina@example.test", name: "李娜", teamId: DEFAULT_TEAM_ID, teamName: "默认团队", role: "member" as const };
    try {
      expect((await app.inject({ method: "GET", url: "/api/rules" })).statusCode).toBe(401);
      await withIdentity(member, async () => {
        expect((await app.inject({ method: "GET", url: "/api/rules" })).statusCode).toBe(200);
        for (const operation of ["sync", "mine"]) {
          expect((await app.inject({ method: "POST", url: `/api/rules/repositories/${repositoryId}/${operation}` })).statusCode).toBe(403);
        }
      });
      expect(fixture.state.requestCount).toBe(0);
    } finally { await app.close(); }
  });

  it("规范文件或采纳证据读取故障保留旧目录且不推进挖掘时间", async () => withTeam(DEFAULT_TEAM_ID, async () => {
    await catalog.sync(repositoryId);
    const previous = await catalog.list();
    fixture.state.failedFiles.add(".agents/rules/payment.md");
    await expect(catalog.sync(repositoryId)).rejects.toThrow("同步失败");
    const current = await catalog.list();
    expect(current.rules).toEqual(previous.rules);
    expect(current.sync[0]?.syncedAt).toBe(previous.sync[0]?.syncedAt);
    expect(current.sync[0]?.syncError).toContain("失败");
    fixture.state.failedFiles.clear();
    fixture.state.failedFiles.add("src/payment.ts");
    await expect(catalog.mine(repositoryId)).rejects.toThrow("挖掘失败");
    const mined = await catalog.candidates(repositoryId);
    expect(mined.candidates).toEqual([]);
    expect(mined.sync[0]?.minedAt).toBeNull();
    expect(mined.sync[0]?.miningError).toContain("不完整");
    fixture.state.failedFiles.clear();
    expect((await catalog.mine(repositoryId)).added).toBe(1);
  }));
});
