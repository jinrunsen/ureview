import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { buildApp } from "../http.js";
import { GitLabPlatform } from "../platform/gitlab.js";
import type { RepositoryConnector, VerifiedRepository } from "../repositories/connector.js";
import { CredentialCipher } from "../repositories/credentials.js";
import { RepositoryService } from "../repositories/service.js";
import { testServerUrl } from "../test-support.js";
import { JobSlots, ReviewService } from "./service.js";
import { makeMockFileGroups } from "../runtime/test-support.js";
import { ReviewStore } from "./store.js";
import { ReadingDocumentStore } from "./reading-document-store.js";
import type { ReadingDocumentInput, ReadingDocumentOutput, ReadingDocumentRecord } from "./reading-document.js";
import { DiffNotReadyError, ReviewError, type FilePatch, type FindingCandidate, type PlatformFactory, type PullRequest, type ReviewDetail, type ReviewFinding, type ReviewInput, type ReviewRuntime } from "./types.js";

const webhookToken = "fixture-webhook-secret";
const repositoryToken = "fixture-repository-secret";
const headSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "清理评审队列测试资源失败");
});

const project: VerifiedRepository = {
  instanceUrl: "https://gitlab.example.test", projectId: 42, name: "payment-gateway",
  pathWithNamespace: "commerce/payment-gateway", webUrl: "https://gitlab.example.test/commerce/payment-gateway",
  httpUrlToRepo: "https://gitlab.example.test/commerce/payment-gateway.git",
};
const connector: RepositoryConnector = { verify: async () => project };

function pullRequest(iid = 7): PullRequest {
  return {
    iid, title: "修复金额计算", description: "补充边界检查", author: "review-author",
    webUrl: `${project.webUrl}/-/merge_requests/${iid}`, sourceBranch: "fix-amount", targetBranch: "main",
    headSha, baseSha, startSha: baseSha,
  };
}

function event(iid = 7) {
  return {
    object_kind: "merge_request", project: { id: 42 }, user: { username: "review-author" },
    object_attributes: { action: "open", target_project_id: 42, iid, title: "修复金额计算", last_commit: { id: headSha } },
  };
}

function finding(): ReviewFinding {
  return {
    id: randomUUID(), title: "未处理负数", description: "输入负数时会跳过扣款检查", severity: "high",
    location: { path: "src/payment.ts", startLine: 1, endLine: 1 },
    evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 1, description: "调用方允许负数", url: `${project.webUrl}/-/blob/${headSha}/src/payment.ts#L1` }],
    fixPrompt: "在金额入口拒绝负数", ruleId: null, generatedAt: "2026-10-02T00:00:00.000Z",
    code: "export const amount = -1;", score: 92, status: "Pending",
    generatorModel: { provider: "generator-fixture", model: "generator-model", vendor: "generator-vendor" },
    graderModel: { provider: "grader-fixture", model: "grader-model", vendor: "grader-vendor" },
    readFiles: [
      { path: "src/payment.ts", startLine: 1, endLine: 3, tool: "read", phase: "generator" },
      { path: "src/payment.ts", startLine: 1, endLine: 1, tool: "grep", phase: "grader" },
    ],
  };
}

function documentOutput(): ReadingDocumentOutput {
  return { content: { outline: [{ id: "summary", label: "概要", title: "扣款入口拒绝负数金额。" }], sections: { summary: "<p>扣款入口先校验金额。</p>" }, excerpts: {} },
    metrics: { steps: 3, nudges: 0, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, durationMs: 1, accepted: 2, rejected: 0, warnings: 0, review: null },
    readFiles: [], model: { provider: "generator-fixture", model: "generator-model", vendor: "generator-vendor" } };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("测试未收到预期的同步信号")), 5000);
    })]);
  } finally { clearTimeout(timer); }
}

function testPool(options: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(options);
  const disconnected: Promise<void>[] = [];
  pool.on("connect", (client) => {
    disconnected.push(new Promise<void>((resolve) => { client.once("end", resolve); }));
  });
  cleanups.push(async () => {
    await pool.end();
    await bounded(Promise.all(disconnected));
  });
  return pool;
}

async function fixture(options: {
  runtime?: Pick<ReviewRuntime, "review">; repository?: VerifiedRepository; repositoryRule?: string; retryDelayMs?: number;
  maxDiffAttempts?: number; managedRulesUnavailable?: boolean; legacy?: boolean; onPullRequest?: (pr: PullRequest) => Promise<void>;
  files?: FilePatch[]; workspaceFiles?: Record<string, string>; excludedDirectories?: (repositoryId: string) => Promise<string[]>;
  slots?: JobSlots;
  writeDocument?: ReviewRuntime["writeDocument"];
} = {}) {
  const databaseName = `ureview_review_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: testServerUrl });
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally { await admin.end(); }
  cleanups.push(async () => {
    const cleanup = new pg.Client({ connectionString: testServerUrl });
    try { await cleanup.connect(); await cleanup.query(`DROP DATABASE ${databaseName} WITH (FORCE)`); }
    finally { await cleanup.end(); }
  });
  const databaseUrl = new URL(testServerUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const connectionString = databaseUrl.toString();
  const pool = testPool({ connectionString });
  const migrations = fileURLToPath(new URL("../../migrations", import.meta.url));
  if (options.legacy) {
    const previous = await mkdtemp(join(tmpdir(), "ureview-migrations-"));
    cleanups.push(() => rm(previous, { recursive: true, force: true }));
    for (const file of (await readdir(migrations)).filter((name) => name < "0005")) await copyFile(join(migrations, file), join(previous, file));
    await runMigrations(pool, previous);
  } else await runMigrations(pool, migrations);
  const worktreeDir = await mkdtemp(join(tmpdir(), "ureview-queue-"));
  cleanups.push(() => rm(worktreeDir, { recursive: true, force: true }));
  const cipher = new CredentialCipher(randomBytes(32));
  const verifiedProject = options.repository ?? project;
  const repositories = new RepositoryService(pool, options.repository ? { verify: async () => verifiedProject } : connector, cipher);
  let repositoryId: string;
  if (options.legacy) {
    repositoryId = randomUUID();
    await pool.query(`INSERT INTO repositories(id,instance_url,project_id,name,path_with_namespace,web_url,http_url_to_repo,credential_ciphertext)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [repositoryId, verifiedProject.instanceUrl, verifiedProject.projectId, verifiedProject.name,
      verifiedProject.pathWithNamespace, verifiedProject.webUrl, verifiedProject.httpUrlToRepo,
      cipher.encrypt(repositoryToken, `${verifiedProject.instanceUrl}#${verifiedProject.projectId}`)]);
  } else {
    repositoryId = (await repositories.connect({ instanceUrl: verifiedProject.instanceUrl, projectPath: verifiedProject.pathWithNamespace, token: repositoryToken })).repository.id;
  }
  const outputFinding = finding();
  let runtimeRuns = 0;
  const runtime: ReviewRuntime = { ...options.runtime ?? { review: async () => ({
    findings: [{ ...outputFinding, id: runtimeRuns++ === 0 ? outputFinding.id : randomUUID() }],
    readFiles: outputFinding.readFiles, fileGroups: makeMockFileGroups(),
  }) }, writeDocument: options.writeDocument ?? (async () => documentOutput()) };
  const calls = { diffs: 0, clones: 0, cwd: "", pullRequests: 0 };
  let currentHead = headSha;
  let platformUnavailable = false;
  let refsReady = true;
  let pendingDiffs = 0;
  const platforms: PlatformFactory = (repository) => ({
    onEvent: (payload) => new GitLabPlatform(repository).onEvent(payload),
    getPullRequest: async (iid) => {
      calls.pullRequests++;
      if (platformUnavailable) throw new ReviewError("platform_unavailable", "无法访问代码平台，请检查网络或令牌");
      const current = { ...pullRequest(iid), headSha: currentHead, ...(refsReady ? {} : { baseSha: null, startSha: null }) };
      await options.onPullRequest?.(current);
      return current;
    },
    getDiff: async (pr) => {
      calls.diffs++;
      if (!pr.baseSha || !pr.startSha) throw new DiffNotReadyError();
      if (pendingDiffs-- > 0) throw new DiffNotReadyError();
      return options.files ?? [{ oldPath: "src/payment.ts", newPath: "src/payment.ts", patch: "@@ -1 +1 @@\n-1\n+2\n", newFile: false, deletedFile: false, renamedFile: false }];
    },
    getFileContent: async () => {
      return { content: "export const amount = -1;\n", commitSha: headSha, path: "src/payment.ts" };
    },
    getGroupingSignals: async () => ({ labels: [] }),
    getCommits: async () => [],
    getClosingIssues: async () => [],
    cloneOrUpdate: async (_pr, directory) => {
      calls.clones++;
      calls.cwd = join(directory, "checkout");
      await mkdir(calls.cwd, { recursive: true });
      await writeFile(join(calls.cwd, "payment.ts"), "export const amount = -1;\n");
      for (const [path, content] of Object.entries(options.workspaceFiles ?? {})) {
        await mkdir(dirname(join(calls.cwd, path)), { recursive: true });
        await writeFile(join(calls.cwd, path), content);
      }
      if (options.repositoryRule) {
        await mkdir(join(calls.cwd, ".agents/rules"), { recursive: true });
        await writeFile(join(calls.cwd, ".agents/rules/payment.md"), options.repositoryRule);
      }
      return calls.cwd;
    },
  });
  const store = new ReviewStore(pool);
  const documents = new ReadingDocumentStore(pool);
  const service = new ReviewService(store, repositories, platforms, runtime, worktreeDir, { documents, ...(options.slots ? { slots: options.slots } : {}),
    retryDelayMs: options.retryDelayMs ?? 0, maxDiffAttempts: options.maxDiffAttempts ?? 3,
    managedRules: async () => { if (options.managedRulesUnavailable) throw new Error(`数据库请求失败 ${repositoryToken}`); return []; },
    ...(options.excludedDirectories ? { excludedDirectories: options.excludedDirectories } : {}),
  });
  cleanups.push(() => service.stop());
  const apps: FastifyInstance[] = [];
  cleanups.push(async () => { for (const app of apps.reverse()) await app.close(); });
  async function startApp(reviews = service, token: string | undefined = webhookToken) {
    const app = buildApp({ pool, repositories, reviews, readingDocuments: documents, ...(token ? { webhookToken: token } : {}) });
    apps.push(app);
    const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    return { app, baseUrl };
  }
  const { app, baseUrl } = await startApp();
  const eventUrl = `${baseUrl}/api/repositories/${repositoryId}/events/gitlab`;
  async function sendEvent(eventId: string = randomUUID(), payload: unknown = event(), change: Record<string, string | undefined> = {}) {
    const headers: Record<string, string> = {
      "content-type": "application/json", "x-gitlab-token": webhookToken,
      "x-gitlab-event": "Merge Request Hook", "webhook-id": eventId,
    };
    for (const [key, value] of Object.entries(change)) {
      if (value === undefined) delete headers[key]; else headers[key] = value;
    }
    const response = await fetch(eventUrl, { method: "POST", headers, body: JSON.stringify(payload) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }
  async function getReview(id: string, url = baseUrl): Promise<ReviewDetail> {
    const response = await fetch(`${url}/api/reviews/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return (await response.json() as { review: ReviewDetail }).review;
  }
  return {
    pool, connectionString, cipher, repositories, repositoryId, store, service, platforms, runtime, worktreeDir,
    app, baseUrl, startApp, sendEvent, getReview, outputFinding, calls,
    setPendingDiffs: (count: number) => { pendingDiffs = count; },
    setHead: (sha: string) => { currentHead = sha; },
    setPlatformUnavailable: (unavailable: boolean) => { platformUnavailable = unavailable; },
    setRefsReady: (ready: boolean) => { refsReady = ready; },
  };
}

function patch(path: string, oldPath = path): FilePatch {
  return { oldPath, newPath: path, patch: "@@ -1 +1 @@\n-before\n+after\n", newFile: false,
    deletedFile: false, renamedFile: path !== oldPath };
}

describe("解读", () => {
  it("每轮评审与 Generator 并行生成，输入不含 finding，工作副本等两边结束再清理；评审结束后可再生成一份", async () => {
    const inputs: ReadingDocumentInput[] = [];
    let reviewStarted = false;
    let documentSawReview = false;
    const entered = deferred(), release = deferred();
    const test = await fixture({
      writeDocument: async (input) => {
        inputs.push(input);
        if (inputs.length === 1) { entered.resolve(); await release.promise; }
        documentSawReview ||= reviewStarted;
        return documentOutput();
      },
      runtime: { review: async () => {
        reviewStarted = true;
        await bounded(entered.promise);
        release.resolve();
        return { findings: [], readFiles: [], fileGroups: makeMockFileGroups() };
      } },
    });
    const id = String((await test.sendEvent()).body.reviewId);
    const url = `${test.baseUrl}/api/reviews/${id}/reading-documents`;
    expect((await fetch(url, { method: "POST" })).status).toBe(409);
    await test.service.runOnce();
    expect(documentSawReview).toBe(true);
    expect(inputs[0]).toMatchObject({ reviewId: id, requirementSources: [{ id: "pull_request", title: "修复金额计算" }] });
    expect(inputs[0]).not.toHaveProperty("findings");
    expect(await readdir(test.worktreeDir)).toEqual([]);
    expect(await test.getReview(id)).toMatchObject({ status: "completed", readingSummary: "扣款入口先校验金额。" });
    let listed = await (await fetch(url)).json() as { documents: ReadingDocumentRecord[] };
    expect(listed.documents).toMatchObject([{ status: "completed", content: { sections: { summary: "<p>扣款入口先校验金额。</p>" } } }]);
    expect((await fetch(url, { method: "POST" })).status).toBe(202);
    expect((await fetch(url, { method: "POST" })).status).toBe(409);
    expect(await test.service.runOnce()).toBe(true);
    listed = await (await fetch(url)).json() as { documents: ReadingDocumentRecord[] };
    expect(listed.documents.map((item) => item.status)).toEqual(["completed", "completed"]);
    expect(await test.service.runOnce()).toBe(false);
  });

  it("解读失败不影响 finding，保存原因后可以重新生成", async () => {
    const test = await fixture({ writeDocument: async () => { throw new ReviewError("reading_document_failed", "模型解读未正常完成"); } });
    const id = String((await test.sendEvent()).body.reviewId);
    await test.service.runOnce();
    expect(await test.getReview(id)).toMatchObject({ status: "completed", readingSummary: null });
    const url = `${test.baseUrl}/api/reviews/${id}/reading-documents`;
    const listed = await (await fetch(url)).json() as { documents: ReadingDocumentRecord[] };
    expect(listed.documents).toMatchObject([{ status: "failed", failureReason: "模型解读未正常完成", content: null }]);
    expect((await fetch(url, { method: "POST" })).status).toBe(202);
  });

  it("需求来源读取失败时保留已读到的来源，解读照常生成", async () => {
    const inputs: ReadingDocumentInput[] = [];
    const test = await fixture({ writeDocument: async (input) => { inputs.push(input); return documentOutput(); } });
    const repository = await test.repositories.getCredentials(test.repositoryId);
    const reviews = new ReviewService(test.store, test.repositories, () => ({
      ...test.platforms(repository), getCommits: async () => [{ sha: headSha, title: "校验扣款", message: "拒绝负数", webUrl: `${project.webUrl}/-/commit/${headSha}` }],
      getClosingIssues: async () => { throw new ReviewError("platform_unavailable", "关联 issue 读取失败"); },
    }), test.runtime, test.worktreeDir, { documents: new ReadingDocumentStore(test.pool) });
    cleanups.push(() => reviews.stop());
    const accepted = await test.sendEvent();
    await reviews.runOnce();
    expect(await test.getReview(String(accepted.body.reviewId))).toMatchObject({ status: "completed",
      requirementSources: [{ kind: "pull_request" }, { kind: "commit", description: "拒绝负数" }] });
    expect(inputs[0]?.requirementSources.map((source) => source.kind)).toEqual(["pull_request", "commit"]);
  });
});

describe("并发执行", () => {
  it("worker 在共享名额内同时执行多个评审，只等领取完成；名额用完不再领取", async () => {
    let running = 0, peak = 0;
    const release = deferred();
    const slots = new JobSlots(2);
    const test = await fixture({ slots, runtime: { review: async () => {
      running++; peak = Math.max(peak, running);
      await release.promise;
      running--;
      return { findings: [], readFiles: [], fileGroups: makeMockFileGroups() };
    } } });
    const ids = [];
    for (const iid of [7, 8, 9]) ids.push(String((await test.sendEvent(randomUUID(), event(iid))).body.reviewId));
    await bounded(test.service.dispatch());
    await bounded((async () => { while (running < 2) await new Promise((resolve) => setTimeout(resolve, 20)); })());
    expect(slots.tryAcquire()).toBe(false);
    expect((await Promise.all(ids.map((id) => test.getReview(id)))).map((review) => review.status).sort()).toEqual(["queued", "running", "running"]);
    release.resolve();
    await test.service.stop();
    expect(peak).toBe(2);
    expect((await Promise.all(ids.map((id) => test.getReview(id)))).filter((review) => review.status === "completed")).toHaveLength(2);
  });
});

describe("空差异降级", () => {
  it("空 diff 保留在运行时输入，运行中及完成后通过已有状态消息提示", async () => {
    let observed: ReviewInput | undefined;
    let runningMessage: string | null = null;
    const test = await fixture({
      files: [{ ...patch("src/payment.ts"), patch: "" }],
      runtime: { review: async (input) => {
        observed = input;
        runningMessage = (await test.getReview(input.reviewId)).statusMessage;
        return { findings: [], readFiles: [], fileGroups: makeMockFileGroups() };
      } },
    });
    const id = String((await test.sendEvent()).body.reviewId);
    await test.service.runOnce();
    expect(observed?.files).toMatchObject([{ newPath: "src/payment.ts", patch: "" }]);
    expect(runningMessage).toBe("代码平台返回了 1 个文件的空 diff，评审继续执行；这些文件的变更内容无法通过 diff 核对：src/payment.ts。");
    expect(await test.getReview(id)).toMatchObject({ status: "completed", statusMessage: runningMessage, failureReason: null });
  });
});

describe("排除评审目录", () => {
  it("排除目录及移出目录的重命名不进入评审输入和工作副本，相邻目录仍参与评审", async () => {
    let observed: ReviewInput | undefined;
    const excludedDirectories = vi.fn(async (_repositoryId: string) => ["features/steps"]);
    const test = await fixture({
      excludedDirectories,
      files: [patch("src/payment.ts"), patch("features/steps/payment.ts"), patch("features/steps-extra/payment.ts"),
        patch("src/moved.ts", "features/steps/moved.ts")],
      workspaceFiles: {
        "src/payment.ts": "PAYMENT_SOURCE", "features/steps/payment.ts": "EXCLUDED_TEST_SOURCE",
        "features/steps-extra/payment.ts": "NEIGHBOR_SOURCE", "src/moved.ts": "MOVED_TEST_SOURCE",
        ".git/objects/fixture": "GIT_TEST_SOURCE",
      },
      runtime: { review: async (input) => {
        observed = input;
        for (const path of ["features/steps/payment.ts", "src/moved.ts", ".git/objects/fixture"]) {
          await expect(readFile(join(input.cwd, path), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect(await readFile(join(input.cwd, "features/steps-extra/payment.ts"), "utf8")).toBe("NEIGHBOR_SOURCE");
        return { findings: [], readFiles: [], fileGroups: makeMockFileGroups(input.files.map((file) => file.newPath)) };
      } },
    });
    const accepted = await test.sendEvent();
    await test.service.runOnce();
    const completed = await test.getReview(String(accepted.body.reviewId));
    expect(completed.status).toBe("completed");
    expect(completed.scope).toEqual({ excludedDirectories: ["features/steps"], excludedFileCount: 2 });
    expect(completed.files.map((file) => file.newPath)).toEqual(["src/payment.ts", "features/steps-extra/payment.ts"]);
    expect(excludedDirectories).toHaveBeenCalledTimes(1);
    expect(excludedDirectories).toHaveBeenCalledWith(completed.repositoryId);
    expect(observed?.files).toEqual(completed.files);
    expect(observed?.excludedDirectories).toEqual(["features/steps", "features/steps/moved.ts", "src/moved.ts"]);
  });

  it("全部文件排除后完成并明确说明跳过，不克隆、不加载规范、不调用模型", async () => {
    const review = vi.fn<ReviewRuntime["review"]>();
    const test = await fixture({ files: [patch("features/steps/payment.ts")], managedRulesUnavailable: true,
      excludedDirectories: async () => ["features/steps"], runtime: { review } });
    const accepted = await test.sendEvent();
    await test.service.runOnce();
    expect(await test.getReview(String(accepted.body.reviewId))).toMatchObject({
      status: "completed", statusMessage: "全部变更文件已被排除，本轮未调用模型评审。", failureReason: null,
      fileGroups: [], files: [], findings: [], readFiles: [], rules: [],
      scope: { excludedDirectories: ["features/steps"], excludedFileCount: 1 },
      findingCounts: { high: 0, medium: 0 }, completedAt: expect.any(String),
    });
    expect(test.calls.clones).toBe(0);
    expect(review).not.toHaveBeenCalled();
    expect(await readdir(test.worktreeDir)).toEqual([]);
  });

  it("重跑使用最新目录配置，历史轮次保留原范围与跳过结果", async () => {
    let directories = ["features/steps"];
    const review = vi.fn<ReviewRuntime["review"]>(async (input) => ({ findings: [], readFiles: [],
      fileGroups: makeMockFileGroups(input.files.map((file) => file.newPath)) }));
    const test = await fixture({ files: [patch("features/steps/payment.ts")],
      excludedDirectories: async () => directories, runtime: { review } });
    const accepted = await test.sendEvent();
    const originalId = String(accepted.body.reviewId);
    await test.service.runOnce();
    const original = await test.getReview(originalId);
    directories = [];
    const rerun = await requestJson(test.baseUrl, `/api/reviews/${originalId}/rerun`, { requestId: randomUUID() });
    expect(rerun.status).toBe(202);
    await test.service.runOnce();
    expect(await test.getReview(String(rerun.body.reviewId))).toMatchObject({
      status: "completed", statusMessage: null, scope: { excludedDirectories: [], excludedFileCount: 0 },
      files: [patch("features/steps/payment.ts")],
    });
    expect(review).toHaveBeenCalledOnce();
    expect(await test.getReview(originalId)).toEqual(original);
  });
});

describe("通过 MR 链接手动评审", () => {
  it("首次提交链接读取当前 PR 并进入手动队列，无需已有评审", async () => {
    const test = await fixture({ onPullRequest: async (pr) => { pr.title = "最新库存边界检查"; } });
    const latestHead = "c".repeat(40);
    test.setHead(latestHead);
    const response = await requestJson(test.baseUrl, "/api/reviews", {
      url: `${project.webUrl}/-/merge_requests/7/diffs?diff_id=4#note_9`, requestId: randomUUID(),
    });
    expect(response).toMatchObject({ status: 202, body: { id: expect.any(String), created: true } });
    expect(await test.getReview(response.body.id)).toMatchObject({
      iid: 7, title: "最新库存边界检查", headSha: latestHead, author: "review-author", status: "queued", round: 1, trigger: "manual",
    });
    expect(test.calls.pullRequests).toBe(1);
    await test.service.runOnce();
    expect(await test.getReview(response.body.id)).toMatchObject({ status: "completed" });
  });

  it("并发重复请求仅创建一轮，接受后重复请求不依赖平台可用", async () => {
    const test = await fixture();
    const body = { url: `${project.webUrl}/-/merge_requests/7`, requestId: randomUUID() };
    const responses = await Promise.all(Array.from({ length: 4 }, () => requestJson(test.baseUrl, "/api/reviews", body)));
    expect(responses.every((response) => response.status === 202)).toBe(true);
    expect(responses.filter((response) => response.body.created)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    expect(test.calls.pullRequests).toBe(1);
    test.setPlatformUnavailable(true);
    expect(await requestJson(test.baseUrl, "/api/reviews", body)).toMatchObject({ status: 202,
      body: { id: responses[0]!.body.id, created: false } });
    expect(test.calls.pullRequests).toBe(1);
    expect((await test.pool.query("SELECT id FROM reviews")).rows).toHaveLength(1);
    expect((await requestJson(test.baseUrl, "/api/reviews", { ...body, url: `${project.webUrl}/-/merge_requests/8` })).status).toBe(409);
  });

  it("平台失败不入队或消费请求标识，恢复后同标识使用最新提交", async () => {
    const test = await fixture();
    const body = { url: `${project.webUrl}/-/merge_requests/7`, requestId: randomUUID() };
    test.setPlatformUnavailable(true);
    expect((await requestJson(test.baseUrl, "/api/reviews", body)).status).toBe(502);
    expect((await test.pool.query("SELECT id FROM reviews")).rows).toHaveLength(0);
    expect((await test.pool.query("SELECT * FROM review_deliveries")).rows).toHaveLength(0);
    const latestHead = "d".repeat(40);
    test.setHead(latestHead);
    test.setPlatformUnavailable(false);
    const accepted = await requestJson(test.baseUrl, "/api/reviews", body);
    expect(accepted.status).toBe(202);
    expect(await test.getReview(accepted.body.id)).toMatchObject({ headSha: latestHead, round: 1 });
  });

  it("未接入的主机或仓库不读取凭据、不访问平台且明确提示接入", async () => {
    const test = await fixture();
    const credentials = vi.spyOn(test.repositories, "getCredentials");
    for (const url of [
      "https://unconnected.example.test/commerce/payment-gateway/-/merge_requests/7",
      "https://gitlab.example.test/commerce/another-project/-/merge_requests/7",
      "https://gitlab.example.test:8443/commerce/payment-gateway/-/merge_requests/7",
    ]) {
      expect(await requestJson(test.baseUrl, "/api/reviews", { url, requestId: randomUUID() }))
        .toMatchObject({ status: 422, body: { error: { code: "repository_not_connected", message: expect.stringContaining("请先接入") } } });
    }
    expect(credentials).not.toHaveBeenCalled();
    expect(test.calls.pullRequests).toBe(0);
    expect((await test.pool.query("SELECT id FROM reviews")).rows).toHaveLength(0);
  });

  it("按自建实例路径前缀和完整命名空间定位仓库", async () => {
    const repository = { ...project, instanceUrl: "https://gitlab.example.test/gitlab",
      pathWithNamespace: "commerce/subgroup/payment-gateway", webUrl: "https://gitlab.example.test/gitlab/commerce/subgroup/payment-gateway" };
    const test = await fixture({ repository });
    const accepted = await requestJson(test.baseUrl, "/api/reviews", {
      url: `${repository.webUrl}/-/merge_requests/7/commits`, requestId: randomUUID(),
    });
    expect(accepted.status).toBe(202);
    expect(await test.getReview(accepted.body.id)).toMatchObject({ repositoryId: test.repositoryId });
    const wrongPrefix = await requestJson(test.baseUrl, "/api/reviews", {
      url: `${project.instanceUrl}/${repository.pathWithNamespace}/-/merge_requests/7`, requestId: randomUUID(),
    });
    expect(wrongPrefix.status).toBe(422);
    expect(test.calls.pullRequests).toBe(1);
  });

  it("无效参数与非 MR 链接返回 400，队列保持为空", async () => {
    const test = await fixture();
    for (const body of [
      {}, { url: `${project.webUrl}/-/merge_requests/7`, requestId: "invalid" },
      { url: project.webUrl, requestId: randomUUID() },
      { url: `${project.webUrl}/-/merge_requests/0`, requestId: randomUUID() },
      { url: "https://user:secret@gitlab.example.test/commerce/payment-gateway/-/merge_requests/7", requestId: randomUUID() },
    ]) {
      const response = await requestJson(test.baseUrl, "/api/reviews", body);
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).not.toContain("secret");
    }
    expect(test.calls.pullRequests).toBe(0);
    expect((await test.pool.query("SELECT id FROM reviews")).rows).toHaveLength(0);
  });
});

describe("评审队列与 webhook 的持久化边界", () => {
  it.each([false, true])("接受与拒绝记录在运行结束后可读，失败状态为 %s", async (failed) => {
    const submissions = [
      { phase: "generator", tool: "report_finding", outcome: "rejected", code: "unread_evidence", reason: "评审结论引用了模型尚未读取的代码" },
      { phase: "generator", tool: "report_file_groups", outcome: "accepted", code: null, reason: null },
    ] as const;
    const test = await fixture({ runtime: { review: async (input) => {
      await Promise.all(submissions.map((submission) => input.onReportSubmission!(submission)));
      if (failed) throw new ReviewError("model_unavailable", "模型服务当前不可用，评审未能完成");
      return { findings: [], readFiles: [], fileGroups: makeMockFileGroups() };
    } } });
    const accepted = await test.sendEvent();
    const id = String(accepted.body.reviewId);
    expect((await test.getReview(id)).reportSubmissions).toEqual([]);
    await test.service.runOnce();
    const review = await test.getReview(id);
    expect(review.status).toBe(failed ? "failed" : "completed");
    expect(review.reportSubmissions).toHaveLength(2);
    expect(review.reportSubmissions).toEqual(expect.arrayContaining([...submissions]));
    const restarted = await test.startApp();
    expect((await test.getReview(id, restarted.baseUrl)).reportSubmissions).toEqual(review.reportSubmissions);
  });

  it("运行时读取仓库规范后保存规范正文与当前提交来源", async () => {
    const test = await fixture({ repositoryRule: "---\npaths: [\"payment.ts\"]\n---\n扣款金额必须大于零。\n", runtime: {
      review: async (input) => {
        const first = await input.repositoryRules!().resolve(["payment.ts"], 1);
        const second = await input.repositoryRules!().resolve(["payment.ts"], 1);
        expect(first.context).toContain("扣款金额必须大于零");
        expect(second.context).toBe(first.context);
        await input.onRules!(first.rules);
        return { findings: [], readFiles: [], fileGroups: makeMockFileGroups() };
      },
    } });
    const accepted = await test.sendEvent();
    await test.service.runOnce();
    expect(await test.getReview(String(accepted.body.reviewId))).toMatchObject({ status: "completed", rules: [{
      id: "repository:.agents/rules/payment.md", body: "扣款金额必须大于零。",
      file: { repositoryId: test.repositoryId, path: ".agents/rules/payment.md", commitSha: headSha }, matchedPaths: ["payment.ts"],
    }] });
  });

  it("数据库规范不可读时评审失败，模型不运行且不泄露上游错误", async () => {
    let runs = 0;
    const test = await fixture({ managedRulesUnavailable: true, runtime: { review: async () => {
      runs++;
      return { findings: [], readFiles: [], fileGroups: makeMockFileGroups() };
    } } });
    const response = await test.sendEvent();
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await test.service.runOnce();
      const records = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toContainEqual(expect.objectContaining({ event: "review.failed",
        reviewId: response.body.reviewId, errorCode: "rules_unavailable", operation: "managed_rules_read",
      }));
      expect(JSON.stringify(records)).not.toContain(repositoryToken);
    } finally { logs.mockRestore(); }
    const review = await test.getReview(String(response.body.reviewId));
    expect(review).toMatchObject({ status: "failed", failureReason: "无法读取团队数据库规范，请稍后重试", findings: [] });
    expect(runs).toBe(0);
    expect(JSON.stringify(review)).not.toContain(repositoryToken);
  });

  it("并发重复投递和不同投递标识的同一提交只产生一份评审", async () => {
    const test = await fixture();
    const results = await Promise.all(Array.from({ length: 12 }, () => test.sendEvent("delivery-one")));
    expect(results.filter((result) => result.status === 202)).toHaveLength(1);
    expect(results.filter((result) => result.status === 200)).toHaveLength(11);
    const id = String(results[0]!.body.reviewId);
    expect(results.every((result) => result.body.reviewId === id)).toBe(true);
    const redelivery = await test.sendEvent("delivery-two");
    expect(redelivery).toMatchObject({ status: 200, body: { reviewId: id, created: false } });
    expect((await test.pool.query("SELECT id FROM reviews")).rows).toHaveLength(1);
    await expect(test.service.runOnce()).resolves.toBe(true);
    await expect(test.service.runOnce()).resolves.toBe(false);
    expect(await test.getReview(id)).toMatchObject({ status: "completed" });
    expect(test.calls.clones).toBe(1);
  });

  it("第二个 worker 跳过锁定任务，并发领取不会把一份任务交给两人", async () => {
    const test = await fixture();
    const first = await test.sendEvent("first", event(7));
    const second = await test.sendEvent("second", event(8));
    const peerPool = testPool({ connectionString: test.connectionString, statement_timeout: 5000 });
    const peer = new ReviewStore(peerPool);
    const locker = await test.pool.connect();
    let claim: ReturnType<ReviewStore["claim"]> | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM reviews WHERE id=$1 FOR UPDATE", [first.body.reviewId]);
      claim = peer.claim();
      expect(await claim).toMatchObject({ id: second.body.reviewId, attempts: 1 });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
      await claim?.catch(() => undefined);
    }
    const claims = await Promise.all([test.store.claim(), peer.claim()]);
    expect(claims.filter(Boolean)).toEqual([expect.objectContaining({ id: first.body.reviewId, attempts: 1 })]);
    expect((await test.pool.query("SELECT id FROM reviews WHERE status='running' AND attempts=1")).rows).toHaveLength(2);
  });

  it("错误密钥、缺失鉴权或投递标识均不会入队", async () => {
    const test = await fixture();
    for (const headers of [
      { "x-gitlab-token": "wrong-secret" }, { "x-gitlab-token": undefined }, { "webhook-id": undefined },
      { "webhook-id": "" }, { "webhook-id": "x".repeat(257) },
    ]) {
      const response = await test.sendEvent("delivery", event(), headers);
      expect([400, 401]).toContain(response.status);
      expect(JSON.stringify(response.body)).not.toContain(webhookToken);
    }
    const withoutEventType = await test.sendEvent("delivery", event(), { "x-gitlab-event": undefined });
    expect(withoutEventType.body).toEqual({ ignored: true });
    expect((await test.pool.query("SELECT id FROM reviews")).rows).toHaveLength(0);
  });

  it("未配置密钥返回不可用，非新建 MR 事件忽略，错误目标项目拒绝", async () => {
    const test = await fixture();
    const unconfigured = await test.startApp(test.service, "");
    const response = await fetch(`${unconfigured.baseUrl}/api/repositories/${test.repositoryId}/events/gitlab`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(event()),
    });
    expect(response.status).toBe(503);
    const payload = event();
    for (const action of ["update", "reopen", "merge", "close"]) {
      const ignored = await test.sendEvent(`delivery-${action}`, { ...payload, object_attributes: { ...payload.object_attributes, action } });
      expect(ignored).toEqual({ status: 202, body: { ignored: true } });
    }
    const push = await test.sendEvent("push", { object_kind: "push" }, { "x-gitlab-event": "Push Hook" });
    expect(push).toEqual({ status: 202, body: { ignored: true } });
    const wrong = await test.sendEvent("wrong-project", { ...payload, project: { id: 99 } });
    expect(wrong.status).toBe(400);
    expect((await test.pool.query("SELECT id FROM reviews")).rows).toHaveLength(0);
  });

  it("部分 finding 已落库时进行中与失败响应都不展示，失败清理工作副本并隐藏异常正文", async () => {
    const reported = deferred();
    const release = deferred();
    const partial = finding();
    const test = await fixture({ runtime: { review: async (input) => {
      await input.onFinding(partial satisfies FindingCandidate);
      reported.resolve();
      await release.promise;
      throw new Error(`执行错误 ${repositoryToken} ${webhookToken}`);
    } } });
    const accepted = await test.sendEvent();
    const id = String(accepted.body.reviewId);
    const running = test.service.runOnce();
    try {
      await bounded(reported.promise);
      expect((await test.pool.query("SELECT id FROM review_findings WHERE review_id=$1", [id])).rows).toHaveLength(1);
      expect(await test.getReview(id)).toMatchObject({ status: "running", findings: [],
        conclusion: { status: "running", findingCounts: { high: 0, medium: 0 }, disposedCount: 0 } });
      expect(await readdir(test.worktreeDir)).toEqual([id]);
      release.resolve();
      await running;
      const failed = await test.getReview(id);
      expect(failed).toMatchObject({ status: "failed", findings: [], failureReason: "评审未能完成，请检查服务配置后重试",
        conclusion: { status: "failed", findingCounts: { high: 0, medium: 0 }, disposedCount: 0 } });
      expect(JSON.stringify(failed)).not.toContain(repositoryToken);
      expect(JSON.stringify(failed)).not.toContain(webhookToken);
      expect(await readdir(test.worktreeDir)).toEqual([]);
    } finally { release.resolve(); await running; }
  });

  it("最终报告保存失败时回滚结果并明确归属，隐藏中间 finding 和数据库异常", async () => {
    const partial = finding();
    const test = await fixture({ runtime: { review: async (input) => {
      await input.onFinding(partial);
      return { findings: [{ ...partial, score: 99 }], readFiles: partial.readFiles, fileGroups: makeMockFileGroups() };
    } } });
    await test.pool.query(`ALTER TABLE reviews ADD CONSTRAINT "PRIVATE_STORAGE_SENTINEL" CHECK (status <> 'completed')`);
    const accepted = await test.sendEvent();
    const id = String(accepted.body.reviewId);
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(test.service.runOnce()).resolves.toBe(true);
      const review = await test.getReview(id);
      expect(review).toMatchObject({ status: "failed", failureReason: "评审报告保存失败", findings: [], fileGroups: [] });
      const stored = await test.pool.query("SELECT payload FROM review_findings WHERE review_id=$1", [id]);
      expect(stored.rows).toEqual([{ payload: partial }]);
      const records = logs.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toContainEqual(expect.objectContaining({
        event: "review.failed", reviewId: id, errorCode: "review_write_failed",
      }));
      expect(records).not.toContainEqual(expect.objectContaining({ event: "review.completed" }));
      expect(JSON.stringify({ review, records })).not.toContain("PRIVATE_STORAGE_SENTINEL");
      expect(await readdir(test.worktreeDir)).toEqual([]);
    } finally { logs.mockRestore(); }
  });

  it("diff 持续未就绪只尝试配置次数，等待时不调用 runtime 或留下代码目录", async () => {
    let runtimeCalls = 0;
    const test = await fixture({ maxDiffAttempts: 3, runtime: { review: async () => { runtimeCalls++; return { findings: [], readFiles: [], fileGroups: makeMockFileGroups() }; } } });
    test.setPendingDiffs(10);
    const accepted = await test.sendEvent();
    const id = String(accepted.body.reviewId);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(test.service.runOnce()).resolves.toBe(true);
      const review = await test.getReview(id);
      expect(review.status).toBe(attempt < 3 ? "queued" : "failed");
      expect(review.findings).toEqual([]);
      expect(await readdir(test.worktreeDir)).toEqual([]);
    }
    expect(await test.getReview(id)).toMatchObject({ failureReason: "代码平台尚未准备好本次提交的 diff，评审未能完成" });
    expect(test.calls).toMatchObject({ diffs: 3, clones: 0 });
    expect(runtimeCalls).toBe(0);
    await expect(test.service.runOnce()).resolves.toBe(false);
  });

  it("diff 就绪后同一份评审完成，重建 app 和连接池仍能读到结果、评分和逐行追溯", async () => {
    const test = await fixture();
    test.setPendingDiffs(1);
    const accepted = await test.sendEvent();
    const id = String(accepted.body.reviewId);
    await test.service.runOnce();
    expect(await test.getReview(id)).toMatchObject({ status: "queued", findings: [],
      conclusion: { status: "queued", findingCounts: { high: 0, medium: 0 }, disposedCount: 0 } });
    await test.service.runOnce();
    const completed = await test.getReview(id);
    expect(completed).toMatchObject({ status: "completed", pullRequest: pullRequest(), findings: [test.outputFinding], readFiles: test.outputFinding.readFiles,
      conclusion: { status: "requires_changes", findingCounts: { high: 1, medium: 0 }, disposedCount: 0 } });
    expect(completed.completedAt).not.toBeNull();
    expect(await readdir(test.worktreeDir)).toEqual([]);
    await test.app.close();
    await test.service.stop();
    const restartedPool = testPool({ connectionString: test.connectionString });
    const restartedRepositories = new RepositoryService(restartedPool, connector, test.cipher);
    const restarted = new ReviewService(new ReviewStore(restartedPool), restartedRepositories, test.platforms, test.runtime, test.worktreeDir);
    cleanups.push(() => restarted.stop());
    const app = buildApp({ pool: restartedPool, repositories: restartedRepositories, reviews: restarted, webhookToken });
    cleanups.push(() => app.close());
    const url = await app.listen({ host: "127.0.0.1", port: 0 });
    expect(await test.getReview(id, url)).toEqual(completed);
    const list = await fetch(`${url}/api/repositories/${test.repositoryId}/reviews`);
    expect(await list.json()).toMatchObject({ reviews: [{ id, status: "completed", headSha }] });
    await expect(restarted.runOnce()).resolves.toBe(false);
  });
});

async function requestJson(baseUrl: string, path: string, body?: unknown) {
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as { id: string; created: boolean; reviewId: string; viewedAt: string; reviews: ReviewDetail[]; total: number } };
}

describe("评审轮次、历史与列表", () => {
  it("轮次迁移按原创建顺序编号，重复迁移保留历史并允许同提交手动重跑", async () => {
    const test = await fixture({ legacy: true });
    const oldId = randomUUID();
    const latestId = randomUUID();
    await test.pool.query(
      `INSERT INTO reviews (id,repository_id,event_id,iid,head_sha,title,author,created_at) VALUES
       ($1,$3,'old',7,$4,'旧提交','review-author','2026-10-01T00:00:00Z'),
       ($2,$3,'latest',7,$5,'新提交','review-author','2026-10-02T00:00:00Z')`,
      [oldId, latestId, test.repositoryId, baseSha, headSha],
    );
    const migrations = fileURLToPath(new URL("../../migrations", import.meta.url));
    expect(await runMigrations(test.pool, migrations)).toContain("0005_review_rounds.sql");
    expect(await runMigrations(test.pool, migrations)).toBe("没有待执行的迁移");
    expect((await test.store.history(test.repositoryId, 7)).map((item) => ({ id: item.id, round: item.round, trigger: item.trigger }))).toEqual([
      { id: latestId, round: 2, trigger: "automatic" }, { id: oldId, round: 1, trigger: "automatic" },
    ]);
    test.setPlatformUnavailable(true);
    expect(await test.sendEvent("latest")).toMatchObject({ status: 200, body: { reviewId: latestId, created: false } });
    test.setPlatformUnavailable(false);
    const rerun = await requestJson(test.baseUrl, `/api/reviews/${latestId}/rerun`, { requestId: randomUUID() });
    expect(rerun.status).toBe(202);
    expect(await test.getReview(rerun.body.reviewId)).toMatchObject({ round: 3, trigger: "manual", headSha });
  });

  it("新提交与手动重跑并发分配独立轮次，同一请求幂等且旧结果完整保留", async () => {
    const test = await fixture();
    const first = await test.sendEvent();
    const firstId = String(first.body.reviewId);
    await test.service.runOnce();
    const original = await test.getReview(firstId);
    const nextHead = "c".repeat(40);
    test.setHead(nextHead);
    const requestId = randomUUID();
    const payload = event();
    payload.object_attributes.last_commit.id = nextHead;
    Object.assign(payload.object_attributes, { action: "update", oldrev: headSha });
    const [automatic, ...manual] = await Promise.all([
      test.sendEvent("new-commit", payload),
      ...Array.from({ length: 8 }, () => requestJson(test.baseUrl, `/api/reviews/${firstId}/rerun`, { requestId })),
    ]);
    expect(automatic.status).toBe(202);
    expect(manual.filter((item) => item.status === 202)).toHaveLength(1);
    const manualId = manual[0]!.body.reviewId;
    expect(manual.every((item) => item.body.reviewId === manualId)).toBe(true);
    expect(manualId).not.toBe(automatic.body.reviewId);
    const historyUrl = `/api/repositories/${test.repositoryId}/pull-requests/7/reviews`;
    let history = await requestJson(test.baseUrl, historyUrl);
    expect(history.body.reviews.map((review: ReviewDetail) => review.round)).toEqual([3, 2, 1]);
    expect(history.body.reviews.slice(0, 2).map((review: ReviewDetail) => review.headSha)).toEqual([nextHead, nextHead]);
    const calls = test.calls.pullRequests;
    const repeated = await requestJson(test.baseUrl, `/api/reviews/${firstId}/rerun`, { requestId });
    expect(repeated).toMatchObject({ status: 200, body: { reviewId: manualId, created: false } });
    expect(test.calls.pullRequests).toBe(calls);
    await test.service.runOnce();
    await test.service.runOnce();
    expect(await test.getReview(firstId)).toEqual(original);
    history = await requestJson(test.baseUrl, historyUrl);
    expect(history.body.reviews.every((review: ReviewDetail) => review.status === "completed")).toBe(true);
    const latest = await requestJson(test.baseUrl, "/api/reviews");
    expect(latest.body).toMatchObject({ total: 1, page: 1, pageSize: 20, reviews: [{ round: 3 }] });
  });

  it("同一提交的不同手动请求可以重跑，重用请求标识到其他 PR 被拒绝", async () => {
    const test = await fixture();
    const first = await test.sendEvent();
    const other = await test.sendEvent("other", event(8));
    const requestId = randomUUID();
    const firstRerun = await requestJson(test.baseUrl, `/api/reviews/${first.body.reviewId}/rerun`, { requestId });
    const nextRerun = await requestJson(test.baseUrl, `/api/reviews/${first.body.reviewId}/rerun`, { requestId: randomUUID() });
    expect(firstRerun.status).toBe(202);
    expect(nextRerun.status).toBe(202);
    expect(nextRerun.body.reviewId).not.toBe(firstRerun.body.reviewId);
    const conflict = await requestJson(test.baseUrl, `/api/reviews/${other.body.reviewId}/rerun`, { requestId });
    expect(conflict.status).toBe(409);
    expect((await test.sendEvent(`manual:${requestId}`, event(9))).status).toBe(202);
    expect((await test.store.history(test.repositoryId, 7)).map((review) => review.round)).toEqual([3, 2, 1]);
  });

  it("旧轮迟完成不会替换新轮，筛选只判断每个 PR 的最新轮次", async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const test = await fixture({ runtime: { review: async () => {
      if (calls++ === 0) { entered.resolve(); await release.promise; }
      return { findings: [finding()], readFiles: [], fileGroups: makeMockFileGroups() };
    } } });
    const first = await test.sendEvent();
    const firstId = String(first.body.reviewId);
    const oldRun = test.service.runOnce();
    try {
      await bounded(entered.promise);
      const rerun = await requestJson(test.baseUrl, `/api/reviews/${firstId}/rerun`, { requestId: randomUUID() });
      const secondId = String(rerun.body.reviewId);
      const peer = new ReviewService(test.store, test.repositories, test.platforms, test.runtime, test.worktreeDir);
      cleanups.push(() => peer.stop());
      await peer.runOnce();
      expect((await requestJson(test.baseUrl, "/api/reviews?status=running")).body).toMatchObject({ total: 0, reviews: [] });
      const latest = await requestJson(test.baseUrl, "/api/reviews?status=completed");
      expect(latest.body).toMatchObject({ total: 1, reviews: [{ id: secondId, round: 2 }] });
      release.resolve();
      await oldRun;
      expect((await requestJson(test.baseUrl, "/api/reviews")).body).toMatchObject({ total: 1, reviews: [{ id: secondId, round: 2 }] });
      expect((await test.getReview(firstId)).status).toBe("completed");
    } finally { release.resolve(); await oldRun; }
  });

  it("列表分页、空页总数、仓库筛选与全量严重度计数一致", async () => {
    const findings = Array.from({ length: 9 }, (_, index) => ({ ...finding(), severity: index < 6 ? "high" as const : index < 8 ? "medium" as const : "low" as const }));
    const test = await fixture({ runtime: { review: async () => ({
      findings: findings.map((item) => ({ ...item, id: randomUUID() })), readFiles: [], fileGroups: makeMockFileGroups(),
    }) } });
    const first = await test.sendEvent("first", event(7));
    await test.service.runOnce();
    const second = await test.sendEvent("second", event(8));
    const completed = await test.getReview(String(first.body.reviewId));
    expect(completed).toMatchObject({ findingCounts: { high: 6, medium: 2 }, foldedCount: 3, fileGroups: makeMockFileGroups() });
    expect(completed.findings).toHaveLength(5);
    expect(completed.files).toHaveLength(1);
    const stored = await test.pool.query("SELECT payload FROM review_findings WHERE review_id=$1", [first.body.reviewId]);
    expect(stored.rows).toHaveLength(8);
    expect(stored.rows.every((row) => row.payload.severity !== "low")).toBe(true);
    const page1 = await requestJson(test.baseUrl, `/api/reviews?repositoryId=${test.repositoryId}&page=1&pageSize=1`);
    expect(page1.body).toMatchObject({ total: 2, page: 1, pageSize: 1, reviews: [{ id: second.body.reviewId, findingCounts: { high: 0, medium: 0 } }] });
    const page2 = await requestJson(test.baseUrl, "/api/reviews?page=2&pageSize=1");
    expect(page2.body).toMatchObject({ total: 2, page: 2, reviews: [{ id: first.body.reviewId, findingCounts: { high: 6, medium: 2 } }] });
    expect((await requestJson(test.baseUrl, "/api/reviews?page=3&pageSize=1")).body).toMatchObject({ total: 2, reviews: [] });
    expect((await requestJson(test.baseUrl, `/api/reviews?repositoryId=${randomUUID()}`)).body).toMatchObject({ total: 0, reviews: [] });
    expect((await requestJson(test.baseUrl, "/api/reviews?status=queued")).body).toMatchObject({ total: 1, reviews: [{ id: second.body.reviewId }] });
  });

  it("GET 保持未查看，显式查看只接受完成轮次且重试和重启保留首次时间", async () => {
    const test = await fixture();
    const accepted = await test.sendEvent();
    const id = String(accepted.body.reviewId);
    expect((await requestJson(test.baseUrl, `/api/reviews/${id}/viewed`, {})).status).toBe(409);
    await test.service.runOnce();
    expect((await test.getReview(id)).viewedAt).toBeNull();
    expect((await test.getReview(id)).viewedAt).toBeNull();
    const viewed = await requestJson(test.baseUrl, `/api/reviews/${id}/viewed`, {});
    expect(viewed.status).toBe(200);
    expect(viewed.body.viewedAt).toEqual(expect.any(String));
    expect((await requestJson(test.baseUrl, `/api/reviews/${id}/viewed`, {})).body).toEqual(viewed.body);
    const restarted = await test.startApp(new ReviewService(new ReviewStore(test.pool), test.repositories, test.platforms, test.runtime, test.worktreeDir));
    expect((await test.getReview(id, restarted.baseUrl)).viewedAt).toBe(viewed.body.viewedAt);
    const next = await requestJson(test.baseUrl, `/api/reviews/${id}/rerun`, { requestId: randomUUID() });
    expect((await test.getReview(next.body.reviewId)).viewedAt).toBeNull();
    expect((await requestJson(test.baseUrl, `/api/reviews/${randomUUID()}/viewed`, {})).status).toBe(404);
  });

  it("列表和重跑参数无效时明确拒绝且不产生新轮次", async () => {
    const test = await fixture();
    const accepted = await test.sendEvent();
    for (const query of ["page=0", "page=-1", "page=1.5", "pageSize=101", "status=pending", "repositoryId=no", "pageSize=0"]) {
      const response = await requestJson(test.baseUrl, `/api/reviews?${query}`);
      expect(response).toMatchObject({ status: 400, body: { error: { code: "invalid_input", message: "请求参数不正确" } } });
    }
    for (const body of [{}, { requestId: "abc" }]) {
      expect((await requestJson(test.baseUrl, `/api/reviews/${accepted.body.reviewId}/rerun`, body)).status).toBe(400);
    }
    expect((await requestJson(test.baseUrl, `/api/reviews/${randomUUID()}/rerun`, { requestId: randomUUID() })).status).toBe(404);
    expect((await test.store.list(test.repositoryId))).toHaveLength(1);
  });
});

function updateEvent(next: string, previous: string = headSha, iid = 7) {
  const payload = event(iid);
  return { ...payload, user: { username: "push-author" }, object_attributes: {
    ...payload.object_attributes, action: "update", oldrev: previous, last_commit: { id: next },
  } };
}

describe("提交阶段与权威 PR 快照", () => {
  it("不同 PR 并发复用同一手动请求标识时只接受一个，另一个返回冲突", async () => {
    const ready = deferred();
    const release = deferred();
    let reads = 0;
    const test = await fixture({ onPullRequest: async () => {
      if (++reads === 2) ready.resolve();
      await release.promise;
    } });
    const first = await test.sendEvent("open-7", event(7));
    const second = await test.sendEvent("open-8", event(8));
    const requestId = randomUUID();
    const requests = [first, second].map((item) => requestJson(test.baseUrl, `/api/reviews/${item.body.reviewId}/rerun`, { requestId }));
    try {
      await bounded(ready.promise);
      release.resolve();
      const results = await Promise.all(requests);
      expect(results.map((item) => item.status).sort()).toEqual([202, 409]);
      expect((await test.pool.query("SELECT id FROM reviews WHERE trigger='manual'")).rows).toHaveLength(1);
    } finally { release.resolve(); await Promise.all(requests); }
  });

  it("较新提交先完成后，迟到的旧 update 和 open 都不替换最新评审", async () => {
    const test = await fixture();
    await test.sendEvent("open-a");
    await test.service.runOnce();
    const skippedHead = "c".repeat(40);
    const currentHead = "d".repeat(40);
    test.setHead(currentHead);
    const current = await test.sendEvent("update-c", updateEvent(currentHead, skippedHead));
    expect(current.status).toBe(202);
    await test.service.runOnce();
    for (const [id, payload] of [
      ["delayed-update-b", updateEvent(skippedHead)], ["delayed-open", event()],
    ] as const) {
      expect(await test.sendEvent(id, payload)).toEqual({ status: 202, body: { ignored: true } });
    }
    expect((await requestJson(test.baseUrl, "/api/reviews")).body).toMatchObject({ total: 1, reviews: [{ id: current.body.reviewId, round: 2, headSha: currentHead, status: "completed" }] });
    expect(await test.service.runOnce()).toBe(false);
    test.setHead(skippedHead);
    expect(await test.sendEvent("delayed-update-b", updateEvent(skippedHead))).toEqual({ status: 202, body: { ignored: true } });
    expect((await test.store.history(test.repositoryId, 7))).toHaveLength(2);
  });

  it("回退到历史提交会产生新自动轮，已合并投递重放仍指向原轮", async () => {
    const test = await fixture();
    const original = await test.sendEvent("open-a");
    expect(await test.sendEvent("another-open-a")).toMatchObject({ status: 200, body: { reviewId: original.body.reviewId } });
    await test.service.runOnce();
    const nextHead = "c".repeat(40);
    test.setHead(nextHead);
    const second = await test.sendEvent("update-b", updateEvent(nextHead));
    await test.service.runOnce();
    test.setHead(headSha);
    const rollback = await test.sendEvent("rollback-a", updateEvent(headSha, nextHead));
    expect(rollback.status).toBe(202);
    expect(rollback.body.reviewId).not.toBe(original.body.reviewId);
    await test.service.runOnce();
    const ids = (await test.store.history(test.repositoryId, 7)).map((review) => [review.round, review.headSha]);
    expect(ids).toEqual([[3, headSha], [2, nextHead], [1, headSha]]);
    expect(await test.sendEvent("another-open-a")).toMatchObject({ status: 200, body: { reviewId: original.body.reviewId, created: false } });
    expect(await test.sendEvent("duplicate-rollback", updateEvent(headSha, nextHead))).toMatchObject({ status: 200, body: { reviewId: rollback.body.reviewId } });
    expect((await requestJson(test.baseUrl, "/api/reviews")).body).toMatchObject({ total: 1, reviews: [{ id: rollback.body.reviewId }] });
    expect(second.body.reviewId).not.toBe(rollback.body.reviewId);
  });

  it("手动轮经过另一提交后，回退自动轮属于新的提交阶段", async () => {
    const test = await fixture();
    const first = await test.sendEvent("open-a");
    const nextHead = "c".repeat(40);
    test.setHead(nextHead);
    expect((await requestJson(test.baseUrl, `/api/reviews/${first.body.reviewId}/rerun`, { requestId: randomUUID() })).status).toBe(202);
    test.setHead(headSha);
    const rollback = await test.sendEvent("rollback-a", updateEvent(headSha, nextHead));
    expect(rollback.status).toBe(202);
    expect(await test.getReview(String(rollback.body.reviewId))).toMatchObject({ round: 3, trigger: "automatic", headSha });
  });

  it("update 使用 API 的 PR 作者，diff_refs 未就绪仍能确认 head 后等待", async () => {
    const test = await fixture();
    const nextHead = "c".repeat(40);
    test.setHead(nextHead);
    test.setRefsReady(false);
    const result = await test.sendEvent("update-before-ready", updateEvent(nextHead));
    const id = String(result.body.reviewId);
    expect(result.status).toBe(202);
    expect(await test.getReview(id)).toMatchObject({ author: "review-author", headSha: nextHead, status: "queued" });
    await test.service.runOnce();
    expect(await test.getReview(id)).toMatchObject({ status: "queued", statusMessage: "代码平台尚未准备好本次提交的 diff，正在等待" });
    const stale = await test.sendEvent("older-before-ready", updateEvent(headSha, baseSha));
    expect(stale).toEqual({ status: 202, body: { ignored: true } });
    test.setRefsReady(true);
    await test.service.runOnce();
    expect(await test.getReview(id)).toMatchObject({ status: "completed", author: "review-author", round: 1 });
  });

  it("update 平台失败不消费投递，恢复后同标识可重试；已接受的重试不访问平台", async () => {
    const test = await fixture();
    const nextHead = "c".repeat(40);
    test.setHead(nextHead);
    test.setPlatformUnavailable(true);
    expect((await test.sendEvent("update-b", updateEvent(nextHead))).status).toBe(502);
    expect((await test.pool.query("SELECT * FROM review_deliveries")).rows).toHaveLength(0);
    expect(await test.store.history(test.repositoryId, 7)).toHaveLength(0);
    test.setPlatformUnavailable(false);
    const accepted = await test.sendEvent("update-b", updateEvent(nextHead));
    expect(accepted.status).toBe(202);
    const calls = test.calls.pullRequests;
    test.setPlatformUnavailable(true);
    expect(await test.sendEvent("update-b", updateEvent(nextHead))).toMatchObject({ status: 200, body: { reviewId: accepted.body.reviewId } });
    expect(test.calls.pullRequests).toBe(calls);
  });

  it("新建 PR 平台不可达仍进入队列并明确失败", async () => {
    const test = await fixture();
    test.setPlatformUnavailable(true);
    const accepted = await test.sendEvent();
    expect(accepted.status).toBe(202);
    expect(test.calls.pullRequests).toBe(0);
    await test.service.runOnce();
    expect(await test.getReview(String(accepted.body.reviewId))).toMatchObject({ status: "failed", failureReason: "无法访问代码平台，请检查网络或令牌" });
  });

  it("同一 PR 在读取平台前串行，不同 PR 可并行且新快照最后入队", async () => {
    const captured = deferred();
    const release = deferred();
    const middleHead = "c".repeat(40);
    const latestHead = "d".repeat(40);
    const observed: string[] = [];
    const test = await fixture({ onPullRequest: async (pr) => {
      observed.push(pr.headSha);
      if (pr.headSha === middleHead) { captured.resolve(); await release.promise; }
    } });
    const first = await test.sendEvent("open-a");
    test.setHead(middleHead);
    const manual = requestJson(test.baseUrl, `/api/reviews/${first.body.reviewId}/rerun`, { requestId: randomUUID() });
    let next: ReturnType<typeof test.sendEvent> | undefined;
    try {
      await bounded(captured.promise);
      test.setHead(latestHead);
      next = test.sendEvent("update-c", updateEvent(latestHead, middleHead));
      await (async () => {
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const locks = await test.pool.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
          if (locks.rowCount) return;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("没有观察到同 PR 入队等待锁");
      })();
      expect(observed).toEqual([middleHead]);
      expect((await test.sendEvent("another-pr", updateEvent(latestHead, middleHead, 8))).status).toBe(202);
      release.resolve();
      expect((await manual).status).toBe(202);
      const accepted = await next;
      expect(accepted.status).toBe(202);
      expect((await test.store.history(test.repositoryId, 7)).map((review) => [review.round, review.headSha])).toEqual([[3, latestHead], [2, middleHead], [1, headSha]]);
      expect(await test.getReview(String(accepted.body.reviewId))).toMatchObject({ headSha: latestHead, round: 3 });
    } finally { release.resolve(); await manual; await next; }
  });
});
