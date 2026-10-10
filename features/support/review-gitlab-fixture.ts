import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const run = promisify(execFile);
export const releasePath = "internal/inventory/release.go";
export const lockPath = "internal/inventory/lock.go";
export const releaseCode = "package inventory\n\nfunc ReleaseInventory(orderID string) {\n  restoreStock(orderID)\n}\n";
export const lockCode = "package inventory\n\nfunc ReleaseInventoryLock(orderID string) {\n  lock(orderID)\n}\n";

// 按 GitLab v4 协议构造的人工数据；Git 请求由真实 http-backend 处理。
export async function startReviewGitLab(directory: string, name = "payment-gateway") {
  const token = "glpat-review-scenario-fixture";
  const projectId = 42;
  let iid = 7;
  const repositoryPath = `commerce/${name}`;
  const work = join(directory, "source");
  const remote = join(directory, `${repositoryPath}.git`);
  const git = (args: string[]) => run("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  await mkdir(join(directory, "commerce"), { recursive: true });
  await git(["init", "--initial-branch=main", "--template=", work]);
  await mkdir(join(work, "internal/inventory"), { recursive: true });
  await writeFile(join(work, releasePath), releaseCode.replace("restoreStock(orderID)", "lockInventory(orderID)"));
  await writeFile(join(work, lockPath), lockCode);
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base"]);
  const baseSha = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", work, "checkout", "-b", "release-inventory"]);
  await writeFile(join(work, releasePath), releaseCode);
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "head"]);
  let headSha = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
  await git(["clone", "--bare", "--template=", work, remote]);
  await git(["--git-dir", remote, "update-ref", `refs/merge-requests/${iid}/head`, headSha]);
  await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  const requests: Array<{ method: string; path: string }> = [];
  const children = new Map<ChildProcess, Promise<void>>();
  const state = {
    title: "修复订单超时未释放库存",
    author: "lina",
    authorName: "李娜",
    reviewers: [] as string[],
    assignees: [] as string[],
    prState: "opened" as "opened" | "merged" | "closed",
    description: "订单超时后恢复库存。",
    commits: [{ id: headSha, title: "释放超时订单库存", message: "释放超时订单库存\n\n超时事件触发后恢复订单占用的库存。" }],
    closingIssues: [{ id: 84, iid: 12, title: "超时订单库存未恢复", description: "订单超时后需要恢复占用库存。" }],
    diffReady: true,
    unavailable: false,
    hooksStatus: 200,
    hooks: [] as Array<{ id: number; url: string; merge_requests_events: boolean }>,
    writes: [] as Array<{ method: string; path: string }>,
    diffs: [{ old_path: releasePath, new_path: releasePath, new_file: false, deleted_file: false, renamed_file: false,
      diff: "@@ -3,3 +3,3 @@\n func ReleaseInventory(orderID string) {\n-  lockInventory(orderID)\n+  restoreStock(orderID)\n }\n" }],
  };
  let baseUrl = "";
  const refs = { head_commit_sha: headSha, base_commit_sha: baseSha, start_commit_sha: baseSha };
  const json = (response: ServerResponse, status: number, body: unknown) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const entry = { method: request.method ?? "", path: request.url ?? "" };
    requests.push(entry);
    if (state.unavailable) { json(response, 503, { message: "平台暂不可用" }); return; }
    if (url.pathname.startsWith("/api/v4/")) {
      if (request.headers["private-token"] !== token) { json(response, 401, { message: "无效令牌" }); return; }
      if (request.method !== "GET") { state.writes.push(entry); json(response, 200, {}); return; }
      if (url.pathname === "/api/v4/personal_access_tokens/self") {
        json(response, 200, { active: true, revoked: false, scopes: ["read_api", "read_repository"] });
      } else if ([`/api/v4/projects/${projectId}`, `/api/v4/projects/${encodeURIComponent(repositoryPath)}`].includes(url.pathname)) {
        json(response, 200, { id: projectId, name, path_with_namespace: repositoryPath,
          web_url: `${baseUrl}/${repositoryPath}`, http_url_to_repo: `${baseUrl}/${repositoryPath}.git` });
      } else if (url.pathname === `/api/v4/projects/${projectId}/hooks`) {
        response.setHeader("x-next-page", "");
        json(response, state.hooksStatus, state.hooksStatus === 200 ? state.hooks : { message: "无权读取项目 webhook 配置" });
      } else if (url.pathname === `/api/v4/projects/${projectId}/repository/commits/HEAD`) {
        void git(["--git-dir", remote, "rev-parse", "refs/heads/main"]).then((result) => json(response, 200, { id: result.stdout.trim() }))
          .catch(() => json(response, 404, { message: "默认分支不存在" }));
      } else if (url.pathname === `/api/v4/projects/${projectId}/repository/tree`) {
        const ref = url.searchParams.get("ref") ?? "refs/heads/main";
        void git(["--git-dir", remote, "ls-tree", "-r", ref]).then((result) => {
          response.setHeader("x-next-page", "");
          json(response, 200, result.stdout.trim().split("\n").filter(Boolean).map((line) => {
            const [metadata, path] = line.split("\t");
            const [mode, type] = metadata!.split(" ");
            return { path, mode, type };
          }));
        }).catch(() => json(response, 404, { message: "目录不存在" }));
      } else if (url.pathname.startsWith(`/api/v4/projects/${projectId}/repository/files/`)) {
        const path = decodeURIComponent(url.pathname.split("/repository/files/")[1]!);
        const ref = url.searchParams.get("ref") === "HEAD" ? "refs/heads/main" : url.searchParams.get("ref")!;
        void (async () => {
          const commitSha = (await git(["--git-dir", remote, "rev-parse", ref])).stdout.trim();
          const content = (await git(["--git-dir", remote, "show", `${commitSha}:${path}`])).stdout;
          json(response, 200, { file_path: path, commit_id: commitSha, encoding: "base64", content: Buffer.from(content).toString("base64"),
            content_sha256: createHash("sha256").update(content).digest("hex") });
        })().catch(() => json(response, 404, { message: "文件不存在" }));
      } else if (url.pathname === `/api/v4/projects/${projectId}/merge_requests/${iid}`) {
        json(response, 200, { iid, project_id: projectId, target_project_id: projectId, source_project_id: projectId,
          reviewers: state.reviewers.map((username) => ({ username })), assignees: state.assignees.map((username) => ({ username })), state: state.prState,
          title: state.title, description: state.description, author: { username: state.author, name: state.authorName }, sha: headSha,
          web_url: `${baseUrl}/${repositoryPath}/-/merge_requests/${iid}`, source_branch: "release-inventory", target_branch: "main",
          diff_refs: state.diffReady ? { head_sha: headSha, base_sha: baseSha, start_sha: baseSha } : null, labels: [] });
      } else if (url.pathname.endsWith(`/merge_requests/${iid}/commits`)) {
        response.setHeader("x-next-page", "");
        json(response, 200, state.commits.map((commit) => ({ ...commit, web_url: `${baseUrl}/${repositoryPath}/-/commit/${commit.id}` })));
      } else if (url.pathname.endsWith(`/merge_requests/${iid}/closes_issues`)) {
        response.setHeader("x-next-page", "");
        json(response, 200, state.closingIssues.map((issue) => ({ ...issue, web_url: `${baseUrl}/${repositoryPath}/-/issues/${issue.iid}` })));
      } else if (url.pathname.endsWith(`/merge_requests/${iid}/versions`)) {
        response.setHeader("x-next-page", "");
        json(response, 200, [{ id: 11, ...refs }]);
      } else if (url.pathname.endsWith(`/merge_requests/${iid}/versions/11`)) {
        json(response, 200, { id: 11, ...refs, state: "collected", real_size: String(state.diffs.length), diffs: state.diffs });
      } else json(response, 404, { message: "接口不存在" });
      return;
    }
    if (request.headers.authorization !== `Basic ${Buffer.from(`oauth2:${token}`).toString("base64")}`) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="fixture"' }).end();
      return;
    }
    if (url.pathname.includes("git-receive-pack") || url.searchParams.get("service") === "git-receive-pack") {
      state.writes.push(entry);
      response.writeHead(403).end();
      return;
    }
    serveGit(request, response, directory, children);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("GitLab fixture 监听地址无效");
  baseUrl = `http://127.0.0.1:${address.port}`;
  let stopped = false;
  return {
    baseUrl, get headSha() { return headSha; }, baseSha, get iid() { return iid; }, repositoryPath, state, requests,
    commitFiles: async (files: Record<string, string>, target: "review" | "global" = "review") => {
      const branch = target === "global" ? "main" : "release-inventory";
      await git(["-C", work, "checkout", branch]);
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(work, path)), { recursive: true });
        await writeFile(join(work, path), content);
      }
      await git(["-C", work, "add", "."]);
      await git(["-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "update rules"]);
      const sha = (await git(["-C", work, "rev-parse", "HEAD"])).stdout.trim();
      await git(["--git-dir", remote, "fetch", work, `${branch}:refs/heads/${branch}`]);
      if (target === "global") return sha;
      headSha = sha;
      refs.head_commit_sha = sha;
      await git(["--git-dir", remote, "update-ref", `refs/merge-requests/${iid}/head`, sha]);
      const entries = (await git(["-C", work, "diff", "--name-status", "--no-renames", baseSha, sha])).stdout.trim().split("\n");
      state.diffs = await Promise.all(entries.filter(Boolean).map(async (entry) => {
        const [status, path] = entry.split("\t");
        if (!path) throw new Error("测试 Git 差异缺少路径");
        return {
          old_path: path, new_path: path, new_file: status === "A", deleted_file: status === "D", renamed_file: false,
          diff: (await git(["-C", work, "diff", "--no-ext-diff", baseSha, sha, "--", path])).stdout,
        };
      }));
      return sha;
    },
    nextPullRequest: async () => {
      iid++;
      await git(["--git-dir", remote, "update-ref", `refs/merge-requests/${iid}/head`, headSha]);
    },
    input: { instanceUrl: baseUrl, projectPath: repositoryPath, token },
    event: () => ({
      object_kind: "merge_request", project: { id: projectId }, user: { username: state.author, name: state.authorName },
      object_attributes: { action: "open", target_project_id: projectId, source_project_id: projectId, iid,
        title: state.title, last_commit: { id: headSha } },
    }),
    dispose: async () => {
      if (stopped) return;
      stopped = true;
      server.closeAllConnections();
      for (const child of children.keys()) child.kill();
      await Promise.all([...children.values(), new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      })]);
    },
  };
}

function serveGit(request: IncomingMessage, response: ServerResponse, directory: string,
  children: Map<ChildProcess, Promise<void>>): void {
  const url = new URL(request.url ?? "/", "http://localhost");
  const child = spawn("git", ["http-backend"], { env: {
    PATH: process.env.PATH, GIT_PROJECT_ROOT: directory, GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method ?? "GET",
    CONTENT_TYPE: request.headers["content-type"] ?? "", REMOTE_USER: "oauth2",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  }, stdio: ["pipe", "pipe", "ignore"] });
  children.set(child, new Promise((resolve) => child.once("close", () => { children.delete(child); resolve(); })));
  const chunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stdin.on("error", () => {});
  child.once("error", () => { if (!response.headersSent) response.writeHead(500).end(); });
  child.once("close", (code) => {
    if (response.destroyed) return;
    if (code !== 0) { if (!response.headersSent) response.writeHead(500).end(); return; }
    const output = Buffer.concat(chunks);
    const separator = output.indexOf("\r\n\r\n");
    if (separator < 0) { response.writeHead(500).end(); return; }
    for (const line of output.subarray(0, separator).toString().split("\r\n")) {
      const colon = line.indexOf(":");
      const name = line.slice(0, colon);
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") response.statusCode = Number.parseInt(value, 10);
      else response.setHeader(name, value);
    }
    response.end(output.subarray(separator + 4));
  });
  request.pipe(child.stdin);
}
