import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DiffNotReadyError, ReviewError, type FilePatch, type PlatformPort, type PullRequest,
  type PullRequestOpened, type RepositoryCredentials, type RepositoryFile,
  type PullRequestCommit, type PullRequestIssue,
} from "../reviews/types.js";
import { authenticatedGitUrl, getResponse, parseJson, PlatformTransportError, runReadOnlyGit, withGitCredentials } from "./transport.js";

const unavailable = (error?: unknown) => new ReviewError("platform_unavailable", "无法访问代码平台，请检查网络或令牌",
  error instanceof PlatformTransportError ? { causeCategory: error.failure ?? error.code, ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }) }
    : error instanceof ReviewError ? error.diagnostic : { causeCategory: "invalid_response" });
const incomplete = () => new ReviewError("diff_incomplete", "代码平台未提供完整差异，评审未能完成");
const invalidEvent = () => new ReviewError("invalid_event", "GitLab 事件与接入仓库不匹配或缺少有效提交");
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isSha = (value: unknown): value is string => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw unavailable();
  return value;
}

function safePath(value: unknown): string {
  const path = text(value);
  if (path.includes("\0") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw unavailable();
  }
  return path;
}

function safeUrl(value: string, instanceUrl?: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw unavailable(); }
  if (/[\s\\]/.test(value) || !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash) throw unavailable();
  if (instanceUrl) {
    const instance = new URL(instanceUrl);
    if (url.origin !== instance.origin || !url.pathname.startsWith(instance.pathname.replace(/\/+$/, "") + "/")) {
      throw unavailable();
    }
  }
  return url.href.replace(/\/+$/, "");
}

function gitBlobId(bytes: Buffer, length: number): string {
  return createHash(length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export interface ProjectWebhook { url: string; mergeRequestEvents: boolean }
export interface WebhookReader { getWebhooks(): Promise<ProjectWebhook[]> }

export class GitLabPlatform implements PlatformPort, WebhookReader {
  private readonly apiUrl: string;
  private readonly cloneUrl: string;
  private readonly timeoutMs: number;

  constructor(private readonly repository: RepositoryCredentials, options: { timeoutMs?: number } = {}) {
    const instanceUrl = safeUrl(repository.instanceUrl);
    if (!isId(repository.projectId) || !/^[\x21-\x7e]{1,4096}$/.test(repository.token)) throw unavailable();
    this.apiUrl = `${instanceUrl}/api/v4/projects/${repository.projectId}`;
    this.cloneUrl = safeUrl(repository.httpUrlToRepo, instanceUrl);
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("GitLab 连接超时必须是正整数毫秒");
  }

  onEvent(payload: unknown): PullRequestOpened | null {
    try {
      const event = object(payload);
      if (event.object_kind !== "merge_request") return null;
      const attributes = object(event.object_attributes);
      if (attributes.action !== "open" && attributes.action !== "update") return null;
      if (attributes.action === "update" && attributes.oldrev == null) return null;
      const project = object(event.project);
      const commit = object(attributes.last_commit);
      const user = object(event.user);
      if (project.id !== this.repository.projectId || attributes.target_project_id !== this.repository.projectId ||
        !isId(attributes.iid) || !isSha(commit.id)) throw invalidEvent();
      if (attributes.action === "update") {
        if (!isSha(attributes.oldrev)) throw invalidEvent();
        if (attributes.oldrev.toLowerCase() === commit.id.toLowerCase()) return null;
      }
      return {
        projectId: this.repository.projectId, iid: attributes.iid, headSha: commit.id.toLowerCase(),
        title: text(attributes.title), author: text(user.username ?? user.name),
        ...(attributes.action === "update" ? { previousHeadSha: String(attributes.oldrev).toLowerCase() } : {}),
      };
    } catch { throw invalidEvent(); }
  }

  async getWebhooks(): Promise<ProjectWebhook[]> {
    const url = `${this.apiUrl}/hooks`;
    const hooks: ProjectWebhook[] = [];
    let page = 1;
    for (let count = 0; count < 100; count++) {
      const { value, headers } = await this.getJson(`${url}?per_page=100&page=${page}`);
      if (!Array.isArray(value)) throw unavailable();
      for (const item of value) {
        const hook = object(item);
        if (typeof hook.url !== "string" || typeof hook.merge_requests_events !== "boolean") throw unavailable();
        hooks.push({ url: hook.url, mergeRequestEvents: hook.merge_requests_events });
      }
      const next = this.nextPage(headers, url, page, value.length);
      if (next === null) return hooks;
      page = next;
    }
    throw unavailable();
  }

  async getPullRequest(iid: number): Promise<PullRequest> {
    const data = object((await this.getJson(this.mergeRequestUrl(iid))).value);
    if (data.iid !== iid || data.project_id !== this.repository.projectId || data.target_project_id !== this.repository.projectId) {
      throw unavailable();
    }
    const refs = data.diff_refs && typeof data.diff_refs === "object" ? object(data.diff_refs) : {};
    if (!isSha(data.sha)) throw new DiffNotReadyError();
    const ready = isSha(refs.head_sha) && isSha(refs.base_sha) && isSha(refs.start_sha) &&
      data.sha.toLowerCase() === refs.head_sha.toLowerCase();
    if (data.description !== null && typeof data.description !== "string") throw unavailable();
    return {
      reviewers: usernames(data.reviewers), assignees: usernames(data.assignees),
      state: data.state === "merged" || data.state === "closed" ? data.state : "opened",
      iid, title: text(data.title), description: data.description ?? "", author: text(object(data.author).username),
      webUrl: safeUrl(text(data.web_url), this.repository.instanceUrl),
      sourceBranch: text(data.source_branch), targetBranch: text(data.target_branch),
      headSha: data.sha.toLowerCase(), baseSha: ready ? String(refs.base_sha).toLowerCase() : null,
      startSha: ready ? String(refs.start_sha).toLowerCase() : null,
    };
  }

  async getDiff(pullRequest: PullRequest): Promise<FilePatch[]> {
    if (!pullRequest.baseSha || !pullRequest.startSha) throw new DiffNotReadyError();
    const versionsUrl = `${this.mergeRequestUrl(pullRequest.iid)}/versions`;
    let page = 1;
    // 版本按页查找，只使用对应这份 PR 快照的三组 SHA。
    for (let count = 0; count < 100; count++) {
      const { value, headers } = await this.getJson(`${versionsUrl}?per_page=100&page=${page}`);
      if (!Array.isArray(value)) throw unavailable();
      for (const item of value) {
        const version = object(item);
        if (version.head_commit_sha !== pullRequest.headSha || version.base_commit_sha !== pullRequest.baseSha ||
          version.start_commit_sha !== pullRequest.startSha) continue;
        if (!isId(version.id)) throw unavailable();
        return this.readVersion(`${versionsUrl}/${version.id}`, pullRequest, version.id);
      }
      const next = this.nextPage(headers, versionsUrl, page, value.length);
      if (next === null) throw new DiffNotReadyError();
      page = next;
    }
    throw unavailable();
  }

  async getFileContent(ref: string, path: string): Promise<RepositoryFile> {
    if (!ref || ref.length > 1024 || ref.includes("\0")) throw unavailable();
    const url = `${this.apiUrl}/repository/files/${encodeURIComponent(safePath(path))}?ref=${encodeURIComponent(ref)}`;
    try {
      const { value } = await this.getJson(url);
      const file = object(value);
      if (file.encoding !== "base64" || file.file_path !== path || !isSha(file.commit_id) ||
        typeof file.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw unavailable();
      const bytes = Buffer.from(file.content, "base64");
      // GitLab 10.x 不返回 content_sha256，改用 blob_id（git 对象哈希）校验内容。
      if (file.content_sha256 !== undefined) {
        if (file.content_sha256 !== createHash("sha256").update(bytes).digest("hex")) throw unavailable();
      } else if (!isSha(file.blob_id) || file.blob_id.toLowerCase() !== gitBlobId(bytes, file.blob_id.length)) throw unavailable();
      if (isSha(ref) && ref.toLowerCase() !== file.commit_id.toLowerCase()) throw unavailable();
      return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), commitSha: file.commit_id.toLowerCase(), path };
    } catch (error) { throw unavailable(error); }
  }

  async getGroupingSignals(iid: number): Promise<{ labels: string[] }> {
    const data = object((await this.getJson(this.mergeRequestUrl(iid))).value);
    if (data.iid !== iid || data.project_id !== this.repository.projectId || data.target_project_id !== this.repository.projectId ||
      !Array.isArray(data.labels) || data.labels.some((label) => typeof label !== "string")) throw unavailable();
    return { labels: data.labels as string[] };
  }

  async getCommits(iid: number): Promise<PullRequestCommit[]> {
    return this.readCollection(`${this.mergeRequestUrl(iid)}/commits`, (value) => {
      const commit = object(value);
      if (!isSha(commit.id) || typeof commit.title !== "string" || typeof commit.message !== "string") throw unavailable();
      return {
        sha: commit.id.toLowerCase(), title: commit.title, message: commit.message,
        // GitLab 13.2 之前的提交没有 web_url，按项目地址拼出。
        webUrl: safeUrl(commit.web_url === undefined ? `${this.repository.webUrl.replace(/\/+$/, "")}/commit/${commit.id.toLowerCase()}` : text(commit.web_url),
          this.repository.instanceUrl),
      };
    });
  }

  async getClosingIssues(iid: number): Promise<PullRequestIssue[]> {
    return this.readCollection(`${this.mergeRequestUrl(iid)}/closes_issues`, (value) => {
      const issue = object(value);
      if (!isId(issue.iid) || (issue.description !== null && typeof issue.description !== "string")) throw unavailable();
      return {
        iid: issue.iid, title: text(issue.title), description: issue.description ?? "",
        webUrl: safeUrl(text(issue.web_url), this.repository.instanceUrl),
      };
    });
  }

  async cloneOrUpdate(pullRequest: PullRequest, directory: string): Promise<string> {
    if (!isId(pullRequest.iid) || !isSha(pullRequest.headSha)) throw unavailable();
    let cwd: string | undefined;
    try {
      await mkdir(directory, { recursive: true });
      // 每次拉取从空目录开始，仓库内容不能提供本地配置、模板或 hook。
      cwd = await mkdtemp(join(directory, "checkout-"));
      const checkout = cwd;
      await withGitCredentials(this.repository.token, async (credentials) => {
        const run = (command: Parameters<typeof runReadOnlyGit>[0], args: string[]) =>
          runReadOnlyGit(command, args, checkout, credentials, this.timeoutMs);
        await run("init", ["--quiet", "--template=", ...(pullRequest.headSha.length === 64 ? ["--object-format=sha256"] : [])]);
        await run("fetch", ["--quiet", "--no-tags", "--no-recurse-submodules", "--depth=1", authenticatedGitUrl(this.cloneUrl),
          `refs/merge-requests/${pullRequest.iid}/head`]);
        const sha = await run("rev-parse", ["--verify", "FETCH_HEAD^{commit}"]);
        if (sha !== pullRequest.headSha.toLowerCase()) {
          throw new ReviewError("head_changed", "PR 提交已变化，本次评审未能完成");
        }
        await run("checkout", ["--quiet", "--detach", sha]);
      });
      return cwd;
    } catch (error) {
      if (cwd) await rm(cwd, { recursive: true, force: true });
      if (error instanceof ReviewError) throw error;
      throw unavailable();
    }
  }

  private mergeRequestUrl(iid: number): string {
    if (!isId(iid)) throw unavailable();
    return `${this.apiUrl}/merge_requests/${iid}`;
  }

  private async getJson(url: string, isDiff = false): Promise<{ value: unknown; headers: Headers }> {
    try {
      const { body, headers } = await getResponse(url, this.repository.token, this.timeoutMs, 16 * 1024 * 1024);
      return { value: parseJson(body), headers };
    } catch (error) {
      if (isDiff && error instanceof PlatformTransportError && error.code === "response_too_large") throw incomplete();
      throw unavailable(error);
    }
  }

  private async readCollection<T>(url: string, parse: (value: unknown) => T): Promise<T[]> {
    const result: T[] = [];
    let page = 1;
    for (let count = 0; count < 100; count++) {
      const { value, headers } = await this.getJson(`${url}?per_page=100&page=${page}`);
      if (!Array.isArray(value)) throw unavailable();
      result.push(...value.map(parse));
      const next = this.nextPage(headers, url, page, value.length);
      if (next === null) return result;
      page = next;
    }
    throw unavailable();
  }

  private nextPage(headers: Headers, versionsUrl: string, current: number, length: number): number | null {
    const nextHeader = headers.get("x-next-page");
    const nextLink = headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
    let next: string | null;
    if (nextLink?.[1]) {
      let url: URL;
      try { url = new URL(nextLink[1]); } catch { throw unavailable(); }
      const expected = new URL(versionsUrl);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw unavailable();
      next = url.searchParams.get("page");
    } else if (nextHeader !== null) {
      if (nextHeader === "") return null;
      next = nextHeader;
    } else {
      return length === 100 ? current + 1 : null;
    }
    if (!next || !/^[1-9]\d*$/.test(next) || !Number.isSafeInteger(Number(next)) || Number(next) <= current) throw unavailable();
    return Number(next);
  }

  private async readVersion(url: string, pullRequest: PullRequest, versionId: number): Promise<FilePatch[]> {
    const version = object((await this.getJson(url, true)).value);
    if (version.id !== versionId) throw unavailable();
    if (version.head_commit_sha !== pullRequest.headSha || version.base_commit_sha !== pullRequest.baseSha ||
      version.start_commit_sha !== pullRequest.startSha) throw new DiffNotReadyError();
    if (version.state === null || version.state === "without_files" || version.state === "collecting") throw new DiffNotReadyError();
    if (version.state !== "collected" || version.overflow === true || !Array.isArray(version.diffs) ||
      typeof version.real_size !== "string" || !/^\d+$/.test(version.real_size) ||
      Number(version.real_size) !== version.diffs.length) throw incomplete();
    if (version.diffs.length === 0) throw new DiffNotReadyError();
    const seen = new Set<string>();
    return version.diffs.map((item) => {
      const diff = object(item);
      if (diff.collapsed === true || diff.too_large === true || diff.overflow === true ||
        typeof diff.diff !== "string" || typeof diff.new_file !== "boolean" || typeof diff.deleted_file !== "boolean" ||
        typeof diff.renamed_file !== "boolean") throw incomplete();
      const oldPath = safePath(diff.old_path);
      const newPath = safePath(diff.new_path);
      if (seen.has(newPath)) throw incomplete();
      seen.add(newPath);
      return { oldPath, newPath, patch: diff.diff, newFile: diff.new_file, deletedFile: diff.deleted_file, renamedFile: diff.renamed_file };
    });
  }
}

function usernames(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw unavailable();
  return [...new Set(value.map((user) => text(object(user).username)))];
}
