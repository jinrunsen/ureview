import { execFile, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffNotReadyError, ReviewError, type RepositoryCredentials } from "../reviews/types.js";
import { GitLabPlatform } from "./gitlab.js";

const run = promisify(execFile);
const token = "glpat-review-protocol-secret";
const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(options: { prefix?: string; apiStatus?: number; apiRedirect?: string; gitRedirect?: string; hang?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ureview-review-gitlab-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const work = join(directory, "source");
  const remote = join(directory, "group/project.git");
  const git = (args: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  await mkdir(join(directory, "group"));
  await git(["init", "--initial-branch=main", "--template=", work]);
  await mkdir(join(work, "src"));
  await writeFile(join(work, "src/value.ts"), "export const value = 1;\n");
  await writeFile(join(work, ".gitmodules"), '[submodule "external"]\n  path = external\n  url = https://unreachable.invalid/source.git\n');
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,external"]);
  await git(["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  const baseSha = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-b", "fork-feature"]);
  await writeFile(join(work, "src/value.ts"), "export const value = 2;\n");
  await git(["-C", work, "add", "src/value.ts"]);
  await git(["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "head"]);
  const headSha = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["clone", "--bare", "--template=", work, remote]);
  await git(["--git-dir", remote, "update-ref", "refs/merge-requests/7/head", headSha]);
  await git(["--git-dir", remote, "update-ref", "-d", "refs/heads/fork-feature"]);
  await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const prefix = options.prefix ?? "";
  const requests: Array<{ method: string; url: string; privateToken?: string; authorization?: string }> = [];
  const diff = {
    old_path: "src/value.ts", new_path: "src/value.ts", new_file: false, deleted_file: false, renamed_file: false,
    a_mode: "100644", b_mode: "100644", diff: "@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n",
  };
  const refs = { head_commit_sha: headSha, base_commit_sha: baseSha, start_commit_sha: baseSha };
  const version: Record<string, unknown> = { id: 11, ...refs, state: "collected", real_size: "1", diffs: [diff] };
  const pages: Array<unknown[]> = [[{ id: 11, ...refs }]];
  const commitPages: Array<unknown[]> = [[]];
  const issuePages: Array<unknown[]> = [[]];
  const hookPages: Array<unknown[]> = [[]];
  const file: Record<string, unknown> = { file_path: "src/value.ts", encoding: "base64", commit_id: headSha,
    content: Buffer.from("export const value = 2;\n").toString("base64"),
    content_sha256: createHash("sha256").update("export const value = 2;\n").digest("hex") };
  let pageHeaders: Record<string, string> | undefined;
  let malformed = false;
  let base: string;
  const metadata: Record<string, unknown> = {
    iid: 7, project_id: 42, target_project_id: 42, source_project_id: 99, title: "验证 fork 的提交", description: null,
    author: { username: "review-author" }, source_branch: "fork-feature", target_branch: "main", sha: headSha,
    diff_refs: { head_sha: headSha, base_sha: baseSha, start_sha: baseSha }, labels: ["backend", "bug"],
  };
  const json = (response: ServerResponse, body: unknown, headers: Record<string, string> = {}) =>
    response.writeHead(200, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? "", url: request.url ?? "",
      ...(typeof request.headers["private-token"] === "string" ? { privateToken: request.headers["private-token"] } : {}),
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
    });
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith(`${prefix}/api/v4/`)) {
      if (options.hang) return;
      if (options.apiRedirect) return void response.writeHead(302, { location: options.apiRedirect }).end();
      if (options.apiStatus) return void response.writeHead(options.apiStatus).end(`upstream ${token}`);
      if (malformed) return void response.writeHead(200).end(`invalid ${token}`);
      if (request.headers["private-token"] !== token) return void response.writeHead(401).end(token);
      if (url.pathname.endsWith("/hooks")) {
        const page = Number(url.searchParams.get("page") ?? 1);
        json(response, hookPages[page - 1] ?? [], pageHeaders ?? { "x-next-page": page < hookPages.length ? String(page + 1) : "" });
      } else if (url.pathname.endsWith("/versions")) {
        const page = Number(url.searchParams.get("page") ?? 1);
        json(response, pages[page - 1] ?? [], pageHeaders ?? { "x-next-page": page < pages.length ? String(page + 1) : "" });
      } else if (url.pathname.endsWith("/commits") || url.pathname.endsWith("/closes_issues")) {
        const source = url.pathname.endsWith("/commits") ? commitPages : issuePages;
        const page = Number(url.searchParams.get("page") ?? 1);
        json(response, source[page - 1] ?? [], pageHeaders ?? { "x-next-page": page < source.length ? String(page + 1) : "" });
      } else if (url.pathname.endsWith("/versions/11")) json(response, version);
      else if (url.pathname.endsWith("/repository/files/src%2Fvalue.ts")) json(response, file);
      else if (url.pathname.endsWith("/merge_requests/7")) json(response, metadata);
      else response.writeHead(404).end(token);
      return;
    }
    if (options.gitRedirect) return void response.writeHead(302, { location: options.gitRedirect }).end();
    if (request.headers.authorization !== `Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }).end();
      return;
    }
    serveGit(request, response, directory, prefix);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  cleanups.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试监听地址无效");
  base = `http://127.0.0.1:${address.port}`;
  metadata.web_url = `${base}${prefix}/group/project/-/merge_requests/7`;
  const repository: RepositoryCredentials = {
    id: "repository-fixture", instanceUrl: `${base}${prefix}`, projectId: 42, pathWithNamespace: "group/project",
    webUrl: `${base}${prefix}/group/project`, httpUrlToRepo: `${base}${prefix}/group/project.git`, token,
  };
  const event = {
    object_kind: "merge_request", project: { id: 42 }, user: { username: "review-author" },
    object_attributes: { action: "open", target_project_id: 42, source_project_id: 99, iid: 7,
      title: "验证 fork 的提交", last_commit: { id: headSha }, draft: true },
  };
  return { base, directory, remote, requests, repository, event, headSha, baseSha, metadata, version, diff, refs, pages, file, commitPages, issuePages, hookPages,
    platform: new GitLabPlatform(repository), git,
    setPageHeaders: (headers: Record<string, string>) => { pageHeaders = headers; },
    setMalformed: () => { malformed = true; },
  };
}

function serveGit(request: IncomingMessage, response: ServerResponse, directory: string, prefix: string) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const backend = spawn("git", ["http-backend"], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: url.pathname.slice(prefix.length), QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? "GET",
      CONTENT_TYPE: request.headers["content-type"] ?? "", REMOTE_USER: "oauth2", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    }, stdio: ["pipe", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  backend.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  backend.once("error", () => response.writeHead(500).end());
  backend.once("close", (code) => {
    if (code !== 0) { if (!response.headersSent) response.writeHead(500).end(); return; }
    const output = Buffer.concat(chunks);
    const split = output.indexOf("\r\n\r\n");
    for (const line of output.subarray(0, split).toString("utf8").split("\r\n")) {
      const separator = line.indexOf(":");
      const name = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      if (name.toLowerCase() === "status") response.statusCode = Number.parseInt(value, 10);
      else response.setHeader(name, value);
    }
    response.end(output.subarray(split + 4));
  });
  request.pipe(backend.stdin);
}

async function rejected(promise: Promise<unknown>, code: string) {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ReviewError);
  expect(error).toMatchObject({ code });
  expect(String(error)).not.toContain(token);
}

describe("GitLab 只读评审协议", () => {
  it("分页读取 MR 提交及关闭的 issue，仅发 GET 并保留子路径和跨项目 issue", async () => {
    const gitlab = await fixture({ prefix: "/gitlab" });
    const commit = { id: gitlab.headSha.toUpperCase(), title: "释放库存", message: "释放库存\n\n订单超时后回收预占。",
      web_url: `${gitlab.base}/gitlab/group/project/-/commit/${gitlab.headSha}` };
    const issue = { iid: 3, title: "订单超时释放库存", description: "订单超时后恢复可售库存。",
      web_url: `${gitlab.base}/gitlab/group/requirements/-/issues/3` };
    gitlab.commitPages.splice(0, 1, [commit], [{ ...commit, id: gitlab.baseSha, title: "", message: "" }]);
    gitlab.issuePages.splice(0, 1, [issue], [{ ...issue, iid: 4, description: null }]);
    await expect(gitlab.platform.getCommits(7)).resolves.toEqual([
      { sha: gitlab.headSha, title: commit.title, message: commit.message, webUrl: commit.web_url },
      { sha: gitlab.baseSha, title: "", message: "", webUrl: commit.web_url },
    ]);
    await expect(gitlab.platform.getClosingIssues(7)).resolves.toEqual([
      { iid: 3, title: issue.title, description: issue.description, webUrl: issue.web_url },
      { iid: 4, title: issue.title, description: "", webUrl: issue.web_url },
    ]);
    expect(gitlab.requests.map((request) => request.url)).toEqual([
      "/gitlab/api/v4/projects/42/merge_requests/7/commits?per_page=100&page=1",
      "/gitlab/api/v4/projects/42/merge_requests/7/commits?per_page=100&page=2",
      "/gitlab/api/v4/projects/42/merge_requests/7/closes_issues?per_page=100&page=1",
      "/gitlab/api/v4/projects/42/merge_requests/7/closes_issues?per_page=100&page=2",
    ]);
    expect(gitlab.requests.every((request) => request.method === "GET" && request.privateToken === token)).toBe(true);
  });

  it("提交和 issue 允许空列表，拒绝无效 MR 编号且不发请求", async () => {
    const gitlab = await fixture();
    for (const iid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      await rejected(gitlab.platform.getCommits(iid), "platform_unavailable");
      await rejected(gitlab.platform.getClosingIssues(iid), "platform_unavailable");
    }
    expect(gitlab.requests).toEqual([]);
    await expect(gitlab.platform.getCommits(7)).resolves.toEqual([]);
    await expect(gitlab.platform.getClosingIssues(7)).resolves.toEqual([]);
  });

  it("拒绝提交和 issue 中的无效身份、文本与站外链接", async () => {
    const gitlab = await fixture();
    const commit = { id: gitlab.headSha, title: "提交", message: "提交说明", web_url: `${gitlab.base}/group/project/-/commit/${gitlab.headSha}` };
    for (const patch of [{ id: "HEAD" }, { title: null }, { message: undefined }, { web_url: "javascript:alert(1)" }, { web_url: "https://other.example/commit" }]) {
      gitlab.commitPages[0] = [{ ...commit, ...patch }];
      await rejected(gitlab.platform.getCommits(7), "platform_unavailable");
    }
    const issue = { iid: 3, title: "需求", description: null, web_url: `${gitlab.base}/group/project/-/issues/3` };
    for (const patch of [{ iid: 0 }, { iid: 1.5 }, { title: " " }, { description: [] }, { web_url: "https://other.example/issue" }]) {
      gitlab.issuePages[0] = [{ ...issue, ...patch }];
      await rejected(gitlab.platform.getClosingIssues(7), "platform_unavailable");
    }
  });

  it("需求来源分页不能跳转站外或循环，第二页失败不能返回第一页面的部分结果", async () => {
    const gitlab = await fixture();
    const commit = { id: gitlab.headSha, title: "提交", message: "提交说明", web_url: `${gitlab.base}/group/project/-/commit/${gitlab.headSha}` };
    gitlab.commitPages.splice(0, 1, [commit], [{ ...commit, id: "invalid" }]);
    await rejected(gitlab.platform.getCommits(7), "platform_unavailable");
    expect(gitlab.requests).toHaveLength(2);
    gitlab.setPageHeaders({ link: '<https://other.example/api/v4/projects/42/merge_requests/7/commits?page=2>; rel="next"' });
    await rejected(gitlab.platform.getCommits(7), "platform_unavailable");
    gitlab.setPageHeaders({ "x-next-page": "1" });
    await rejected(gitlab.platform.getClosingIssues(7), "platform_unavailable");
    expect(gitlab.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("只读获取所有 webhook 页，只返回地址与 MR 事件选择", async () => {
    const gitlab = await fixture({ prefix: "/gitlab" });
    gitlab.hookPages.splice(0, 1, [{ id: 1, url: "https://ureview.example.test/first", merge_requests_events: false, token: "hidden" }],
      [{ id: 2, url: "https://ureview.example.test/second", merge_requests_events: true }]);
    await expect(gitlab.platform.getWebhooks()).resolves.toEqual([
      { url: "https://ureview.example.test/first", mergeRequestEvents: false },
      { url: "https://ureview.example.test/second", mergeRequestEvents: true },
    ]);
    expect(gitlab.requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "/gitlab/api/v4/projects/42/hooks?per_page=100&page=1"],
      ["GET", "/gitlab/api/v4/projects/42/hooks?per_page=100&page=2"],
    ]);
    expect(gitlab.requests.every((request) => request.privateToken === token)).toBe(true);
    gitlab.setPageHeaders({ link: '<https://other.example/api/v4/projects/42/hooks?page=2>; rel="next"' });
    await rejected(gitlab.platform.getWebhooks(), "platform_unavailable");
  });

  it("webhook 读取拒绝畸形字段并保留权限失败分类", async () => {
    const gitlab = await fixture();
    for (const hook of [{ url: 42, merge_requests_events: true }, { url: "https://example.test", merge_requests_events: "true" }]) {
      gitlab.hookPages.splice(0, 1, [hook]);
      await rejected(gitlab.platform.getWebhooks(), "platform_unavailable");
    }
    const denied = await fixture({ apiStatus: 403 });
    await expect(denied.platform.getWebhooks()).rejects.toMatchObject({ diagnostic: { causeCategory: "access_denied", httpStatus: 403 } });
  });
  it.each([401, 403, 404, 429, 500])("文件读取失败保留 HTTP %i，不携带令牌", async (status) => {
    const gitlab = await fixture({ apiStatus: status });
    const error: unknown = await gitlab.platform.getFileContent("HEAD", "src/value.ts").catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "platform_unavailable", diagnostic: {
      httpStatus: status, causeCategory: [401, 403, 404].includes(status) ? "access_denied" : "unavailable",
    } });
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it("默认分支文件读取保留提交身份，拒绝内容摘要、路径或提交不匹配", async () => {
    const gitlab = await fixture();
    await expect(gitlab.platform.getFileContent("HEAD", "src/value.ts")).resolves.toMatchObject({ commitSha: gitlab.headSha });
    await expect(gitlab.platform.getFileContent(gitlab.baseSha, "src/value.ts")).rejects.toMatchObject({ code: "platform_unavailable" });
    const original = { ...gitlab.file };
    for (const patch of [{ file_path: "private.txt" }, { content_sha256: "0".repeat(64) }, { content: "!!!" }, { commit_id: "HEAD" }, { encoding: "text" }]) {
      Object.assign(gitlab.file, original, patch);
      await expect(gitlab.platform.getFileContent("HEAD", "src/value.ts")).rejects.toMatchObject({ code: "platform_unavailable" });
    }
    expect(gitlab.requests.every((request) => request.method === "GET")).toBe(true);
  });
  it("解析新 MR 和草稿事件，忽略其他动作，拒绝跨项目或无效提交", async () => {
    const gitlab = await fixture();
    expect(gitlab.platform.onEvent(gitlab.event)).toEqual({ projectId: 42, iid: 7, headSha: gitlab.headSha, title: "验证 fork 的提交", author: "review-author" });
    expect(gitlab.platform.onEvent({ object_kind: "push" })).toBeNull();
    expect(gitlab.platform.onEvent({ ...gitlab.event, object_attributes: { action: "update" } })).toBeNull();
    for (const patch of [{ target_project_id: 99 }, { iid: 0 }, { last_commit: { id: "HEAD" } }]) {
      expect(() => gitlab.platform.onEvent({ ...gitlab.event, object_attributes: { ...gitlab.event.object_attributes, ...patch } })).toThrow(ReviewError);
    }
    expect(() => gitlab.platform.onEvent({ ...gitlab.event, project: { id: 99 } })).toThrow(ReviewError);
    expect(gitlab.platform.onEvent({ ...gitlab.event, object_attributes: { ...gitlab.event.object_attributes, last_commit: { id: "a".repeat(64) } } })?.headSha).toHaveLength(64);
    expect(gitlab.requests).toHaveLength(0);
  });

  it("只有带不同旧提交的代码更新产生评审，标题和审阅人更新不触发", async () => {
    const gitlab = await fixture();
    const update = { ...gitlab.event, object_attributes: { ...gitlab.event.object_attributes, action: "update", oldrev: gitlab.baseSha } };
    expect(gitlab.platform.onEvent(update)).toMatchObject({ iid: 7, headSha: gitlab.headSha });
    for (const changes of [{ title: { previous: "旧标题", current: "新标题" } }, { reviewers: { previous: [], current: [7] } }, {}]) {
      expect(gitlab.platform.onEvent({ ...update, changes, object_attributes: { ...update.object_attributes, oldrev: null } })).toBeNull();
    }
    expect(gitlab.platform.onEvent({ ...update, object_attributes: { ...update.object_attributes, oldrev: gitlab.headSha } })).toBeNull();
    expect(() => gitlab.platform.onEvent({ ...update, object_attributes: { ...update.object_attributes, oldrev: "HEAD" } })).toThrow(ReviewError);
  });

  it("按三组 SHA 读取指定 diff 版本、原文件和分组标签，保留实例子路径", async () => {
    const gitlab = await fixture({ prefix: "/gitlab" });
    const pr = await gitlab.platform.getPullRequest(7);
    expect(pr).toMatchObject({ iid: 7, description: "", headSha: gitlab.headSha, baseSha: gitlab.baseSha, startSha: gitlab.baseSha });
    await expect(gitlab.platform.getDiff(pr)).resolves.toEqual([{
      oldPath: "src/value.ts", newPath: "src/value.ts", patch: gitlab.diff.diff, newFile: false, deletedFile: false, renamedFile: false,
    }]);
    await expect(gitlab.platform.getFileContent(gitlab.headSha, "src/value.ts")).resolves.toEqual({ content: "export const value = 2;\n", commitSha: gitlab.headSha, path: "src/value.ts" });
    await expect(gitlab.platform.getGroupingSignals(7)).resolves.toEqual({ labels: ["backend", "bug"] });
    expect(gitlab.requests.some((request) => request.url === `/gitlab/api/v4/projects/42/repository/files/src%2Fvalue.ts?ref=${gitlab.headSha}`)).toBe(true);
    expect(gitlab.requests.every((request) => request.method === "GET" && request.privateToken === token)).toBe(true);
  });

  it("读取评审人与指派人的用户名和合并状态，缺省名单为空", async () => {
    const gitlab = await fixture();
    expect(await gitlab.platform.getPullRequest(7)).toMatchObject({ reviewers: [], assignees: [], state: "opened" });
    Object.assign(gitlab.metadata, { reviewers: [{ username: "zhangwei" }, { username: "zhangwei" }], assignees: [{ username: "lina" }], state: "merged" });
    expect(await gitlab.platform.getPullRequest(7)).toMatchObject({ reviewers: ["zhangwei"], assignees: ["lina"], state: "merged" });
    expect(gitlab.requests.every((request) => request.method === "GET")).toBe(true);
  });

  it("跟随版本分页查找旧快照，不会改用最新版本", async () => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    gitlab.pages.unshift([{ id: 12, ...gitlab.refs, head_commit_sha: "a".repeat(40) }]);
    await expect(gitlab.platform.getDiff(pr)).resolves.toHaveLength(1);
    expect(gitlab.requests.some((request) => request.url.endsWith("per_page=100&page=2"))).toBe(true);
    expect(gitlab.requests.some((request) => request.url.endsWith("/versions/12"))).toBe(false);
  });

  it("支持 Link 分页，拒绝跨源分页地址和循环页码", async () => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    gitlab.pages.unshift([]);
    gitlab.setPageHeaders({ link: `<${gitlab.base}/api/v4/projects/42/merge_requests/7/versions?page=2&per_page=100>; rel="next"` });
    await expect(gitlab.platform.getDiff(pr)).resolves.toHaveLength(1);
    gitlab.setPageHeaders({ link: '<https://other.example/api/v4/projects/42/merge_requests/7/versions?page=2>; rel="next"' });
    await rejected(gitlab.platform.getDiff(pr), "platform_unavailable");
    gitlab.setPageHeaders({ "x-next-page": "1" });
    await rejected(gitlab.platform.getDiff(pr), "platform_unavailable");
  });

  it.each([null, {}, { head_sha: "a".repeat(40) }])("新 MR 尚无完整 diff_refs 时等待：%j", async (diffRefs) => {
    const gitlab = await fixture();
    gitlab.metadata.diff_refs = diffRefs;
    gitlab.metadata.prepared_at = "2026-10-02T00:00:00Z";
    const pr = await gitlab.platform.getPullRequest(7);
    expect(pr).toMatchObject({ headSha: gitlab.headSha, author: "review-author", baseSha: null, startSha: null });
    await expect(gitlab.platform.getDiff(pr)).rejects.toBeInstanceOf(DiffNotReadyError);
  });

  it("源分支已更新而 diff_refs 仍是旧值时等待", async () => {
    const gitlab = await fixture();
    gitlab.metadata.sha = "a".repeat(40);
    const pr = await gitlab.platform.getPullRequest(7);
    expect(pr).toMatchObject({ headSha: "a".repeat(40), baseSha: null, startSha: null });
    await rejected(gitlab.platform.getDiff(pr), "diff_not_ready");
  });

  it("版本缺失、还在收集或异步响应的 SHA 变化都不会产生空成功", async () => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    const ready = gitlab.pages.splice(0);
    await rejected(gitlab.platform.getDiff(pr), "diff_not_ready");
    gitlab.pages.push(...ready);
    gitlab.version.state = "without_files";
    await rejected(gitlab.platform.getDiff(pr), "diff_not_ready");
    gitlab.version.state = "collected";
    gitlab.version.head_commit_sha = "b".repeat(40);
    await rejected(gitlab.platform.getDiff(pr), "diff_not_ready");
    gitlab.version.head_commit_sha = gitlab.headSha;
    gitlab.version.diffs = [];
    gitlab.version.real_size = "0";
    await rejected(gitlab.platform.getDiff(pr), "diff_not_ready");
  });

  it.each([
    { state: "overflow" }, { overflow: true }, { real_size: "1000+" }, { real_size: "2" },
    { real_size: undefined }, { diffs: [] },
  ])("拒绝不能证明完整的差异：%j", async (patch) => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    Object.assign(gitlab.version, patch);
    await rejected(gitlab.platform.getDiff(pr), "diff_incomplete");
  });

  it.each([
    { collapsed: true }, { too_large: true }, { diff: undefined },
  ])("拒绝文件级省略或缺失 patch：%j", async (patch) => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    gitlab.version.diffs = [{ ...gitlab.diff, ...patch }];
    await rejected(gitlab.platform.getDiff(pr), "diff_incomplete");
  });

  it.each([{ diff: "" }, { diff: "", renamed_file: true }, { diff: "", new_file: true }])("保留空 diff 文件供评审继续处理：%j", async (patch) => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    gitlab.version.diffs = [{ ...gitlab.diff, ...patch }];
    await expect(gitlab.platform.getDiff(pr)).resolves.toMatchObject([{ patch: "" }]);
  });

  it("保留重命名的两条路径，拒绝重复文件记录", async () => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    gitlab.version.diffs = [{ ...gitlab.diff, renamed_file: true, old_path: "src/old.ts" }];
    await expect(gitlab.platform.getDiff(pr)).resolves.toMatchObject([{ oldPath: "src/old.ts", newPath: "src/value.ts", renamedFile: true }]);
    gitlab.version.diffs = [gitlab.diff, gitlab.diff];
    gitlab.version.real_size = "2";
    await rejected(gitlab.platform.getDiff(pr), "diff_incomplete");
  });

  it("从目标仓库 MR ref 拉取 fork 提交，检出指定代码，只发 REST GET 与 Git upload-pack", async () => {
    const gitlab = await fixture({ prefix: "/gitlab" });
    const pr = await gitlab.platform.getPullRequest(7);
    await gitlab.platform.getDiff(pr);
    const cwd = await gitlab.platform.cloneOrUpdate(pr, join(gitlab.directory, "review"));
    expect(await readFile(join(cwd, "src/value.ts"), "utf8")).toBe("export const value = 2;\n");
    expect((await gitlab.git(["-C", cwd, "rev-parse", "HEAD"])).stdout.trim()).toBe(gitlab.headSha);
    expect((await gitlab.git(["-C", cwd, "branch", "--show-current"])).stdout.trim()).toBe("");
    expect(await readFile(join(cwd, ".git/config"), "utf8")).not.toContain(token);
    expect(await readdir(join(cwd, "external"))).toEqual([]);
    expect(gitlab.requests.some((request) => request.method === "POST" && request.url.endsWith("/git-upload-pack"))).toBe(true);
    expect(gitlab.requests.every((request) => request.method === "GET" || (request.method === "POST" && request.url.endsWith("/git-upload-pack")))).toBe(true);
    expect(gitlab.requests.every((request) => !request.url.includes(token) && !request.url.includes("receive-pack"))).toBe(true);
    expect(gitlab.requests.filter((request) => !request.url.includes("/api/")).every((request) => request.url.startsWith("/gitlab/group/project.git/"))).toBe(true);
  });

  it("fetch 时 MR ref 已变更会明确失败并移除不匹配工作副本", async () => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    await gitlab.git(["--git-dir", gitlab.remote, "update-ref", "refs/merge-requests/7/head", gitlab.baseSha]);
    const directory = join(gitlab.directory, "review");
    await rejected(gitlab.platform.cloneOrUpdate(pr, directory), "head_changed");
    expect(await readdir(directory)).toEqual([]);
  });

  it("Git 不继承宿主配置和模板，重试不会复用含 hook 的旧 checkout", async () => {
    const gitlab = await fixture();
    const pr = await gitlab.platform.getPullRequest(7);
    const config = join(gitlab.directory, "host.gitconfig");
    const templates = join(gitlab.directory, "templates");
    await mkdir(join(templates, "hooks"), { recursive: true });
    const hook = `#!/bin/sh\nprintf executed > '${join(gitlab.directory, "hook-ran")}'\n`;
    await writeFile(join(templates, "hooks/post-checkout"), hook, { mode: 0o700 });
    await writeFile(config, `[url "https://unreachable.invalid/"]\n  insteadOf = ${gitlab.base}/\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", config);
    vi.stubEnv("GIT_TEMPLATE_DIR", templates);
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "http.extraHeader");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "Authorization: Basic wrong");
    const directory = join(gitlab.directory, "review");
    const first = await gitlab.platform.cloneOrUpdate(pr, directory);
    await mkdir(join(first, ".git/hooks"));
    await writeFile(join(first, ".git/hooks/post-checkout"), hook, { mode: 0o700 });
    const second = await gitlab.platform.cloneOrUpdate(pr, directory);
    expect(second).not.toBe(first);
    expect(await readdir(gitlab.directory)).not.toContain("hook-ran");
    expect(gitlab.requests.every((request) => request.authorization !== "Basic wrong")).toBe(true);
  });

  it.each([401, 403, 404, 500])("平台返回 %i 时隐藏上游正文并统一错误", async (apiStatus) => {
    const gitlab = await fixture({ apiStatus });
    await rejected(gitlab.platform.getPullRequest(7), "platform_unavailable");
  });

  it("无效 JSON、超时以及 API/Git 重定向不会泄露令牌", async () => {
    const gitlab = await fixture();
    gitlab.setMalformed();
    await rejected(gitlab.platform.getPullRequest(7), "platform_unavailable");
    const hanging = await fixture({ hang: true });
    await rejected(new GitLabPlatform(hanging.repository, { timeoutMs: 100 }).getPullRequest(7), "platform_unavailable");
    const receiver = await fixture();
    const redirect = await fixture({ apiRedirect: receiver.base });
    await rejected(redirect.platform.getPullRequest(7), "platform_unavailable");
    const gitRedirect = await fixture({ gitRedirect: `${receiver.base}/group/project.git/info/refs?service=git-upload-pack` });
    const pr = await gitRedirect.platform.getPullRequest(7);
    await rejected(gitRedirect.platform.cloneOrUpdate(pr, join(gitRedirect.directory, "review")), "platform_unavailable");
    expect(receiver.requests).toHaveLength(0);
  }, 15_000);
});
