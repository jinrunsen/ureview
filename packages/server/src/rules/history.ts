import type { RepositoryService } from "../repositories/service.js";
import type { RepositoryCredentials } from "../reviews/types.js";
import { getResponse, parseJson, PlatformTransportError } from "../platform/transport.js";

export class HistoryReadError extends Error {
  constructor(message = "无法完整读取 GitLab 历史，请检查仓库连接后重试") { super(message); }
}
export class HistoryRateLimitError extends HistoryReadError {
  constructor() { super("GitLab 请求限流，未生成新候选；请稍后重试"); }
}
export interface HistoricalSuggestion { fromLine: number; toLine: number; before: string; after: string }
export interface PlatformNote {
  id: string; author: string; authorId: number; body: string; createdAt: string; url: string;
  position?: { path: string; headSha: string };
  suggestions: HistoricalSuggestion[];
}
export interface PlatformDiscussion { id: string; resolved: boolean; notes: PlatformNote[] }
export interface HistoricalPullRequest { iid: number; authorId: number; title: string; headSha: string; url: string }
export interface HistoricalCommit { sha: string; parentSha: string; authorEmail: string; createdAt: string }
export interface RepositoryTreeEntry { path: string; mode: string; type: string }

export const historyObject = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HistoryReadError();
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || !value.trim()) throw new HistoryReadError();
  return value;
};
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new HistoryReadError();
  return value;
};
export const historySha = (value: unknown): string => {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)) throw new HistoryReadError();
  return value.toLowerCase();
};
const date = (value: unknown) => {
  const result = text(value);
  if (!Number.isFinite(Date.parse(result))) throw new HistoryReadError();
  return result;
};
export const historyPath = (value: unknown): string => {
  const path = text(value);
  if (/[\\\x00-\x1f\x7f]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) throw new HistoryReadError();
  return path;
};

// 请求地址只由已校验的仓库配置生成；分页链接只用于提取同一端点的页号。
export class GitLabHistoryReader {
  constructor(private readonly repositories: Pick<RepositoryService, "getCredentials">) {}

  async json(repository: RepositoryCredentials, path: string, global = false): Promise<unknown> {
    return (await this.response(repository, path, global)).value;
  }

  private async response(repository: RepositoryCredentials, path: string, global = false) {
    try {
      const instance = new URL(repository.instanceUrl);
      if (!["http:", "https:"].includes(instance.protocol) ||
        instance.username || instance.password || instance.search || instance.hash || !path.startsWith("/")) throw new HistoryReadError();
      const url = `${repository.instanceUrl.replace(/\/+$/, "")}/api/v4${global ? "" : `/projects/${repository.projectId}`}${path}`;
      const { body, headers } = await getResponse(url, repository.token, 10_000, 16 * 1024 * 1024);
      return { value: parseJson(body), headers, url };
    } catch (error) {
      if (error instanceof PlatformTransportError && error.httpStatus === 429) throw new HistoryRateLimitError();
      throw new HistoryReadError();
    }
  }

  async pages(repository: RepositoryCredentials, path: string): Promise<unknown[]> {
    const output: unknown[] = [];
    let page = 1;
    for (let count = 0; count < 100; count++) {
      const result = await this.response(repository, `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
      if (!Array.isArray(result.value)) throw new HistoryReadError();
      output.push(...result.value);
      let next = result.headers.get("x-next-page");
      const linked = result.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/);
      if (linked?.[1]) {
        const url = new URL(linked[1]);
        const expected = new URL(result.url);
        if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash) throw new HistoryReadError();
        next = url.searchParams.get("page");
      }
      if (next === "" || next === null && result.value.length < 100) return output;
      if (next === null) { page++; continue; }
      if (!/^[1-9]\d*$/.test(next) || !Number.isSafeInteger(Number(next)) || Number(next) <= page) throw new HistoryReadError();
      page = Number(next);
    }
    throw new HistoryReadError("GitLab 历史超过本次读取上限，未保存不完整的结果");
  }

  async getDiscussions(repositoryId: string, iid: number): Promise<PlatformDiscussion[]> {
    integer(iid);
    const repository = await this.repositories.getCredentials(repositoryId);
    const values = await this.pages(repository, `/merge_requests/${iid}/discussions`);
    const users = new Map<number, boolean>();
    const output: PlatformDiscussion[] = [];
    for (const value of values) {
      const discussion = historyObject(value);
      if (!Array.isArray(discussion.notes)) throw new HistoryReadError();
      const notes: PlatformNote[] = [];
      for (const item of discussion.notes) {
        const note = historyObject(item);
        if (note.system === true) continue;
        if (note.system !== false) throw new HistoryReadError();
        const author = historyObject(note.author);
        const authorId = integer(author.id);
        let bot = users.get(authorId);
        if (bot === undefined) {
          if (typeof author.bot === "boolean") bot = author.bot;
          else {
            const user = historyObject(await this.json(repository, `/users/${authorId}`, true));
            if (user.id !== authorId || typeof user.bot !== "boolean") throw new HistoryReadError();
            bot = user.bot;
          }
          users.set(authorId, bot);
        }
        if (bot) continue;
        const id = String(integer(note.id));
        const position = note.position ? historyObject(note.position) : undefined;
        const suggestions = Array.isArray(note.suggestions) ? note.suggestions.map((item) => {
          const suggestion = historyObject(item);
          const fromLine = integer(suggestion.from_line), toLine = integer(suggestion.to_line);
          if (toLine < fromLine || typeof suggestion.from_content !== "string" || typeof suggestion.to_content !== "string") throw new HistoryReadError();
          return { fromLine, toLine, before: suggestion.from_content, after: suggestion.to_content };
        }) : [];
        notes.push({ id, author: text(author.username), authorId, body: text(note.body), createdAt: date(note.created_at),
          url: `${repository.webUrl}/-/merge_requests/${iid}#note_${id}`, suggestions,
          ...(position && position.position_type === "text" ? { position: { path: historyPath(position.new_path), headSha: historySha(position.head_sha) } } : {}) });
      }
      if (notes.length) output.push({ id: text(discussion.id), resolved: discussion.notes.some((note) => historyObject(note).resolved === true), notes });
    }
    return output;
  }

  async pullRequests(repository: RepositoryCredentials): Promise<HistoricalPullRequest[]> {
    const values = await this.pages(repository, "/merge_requests?scope=all&state=merged&order_by=updated_at&sort=desc");
    return values.map((value) => {
      const pr = historyObject(value), iid = integer(pr.iid);
      return { iid, authorId: integer(historyObject(pr.author).id), title: text(pr.title), headSha: historySha(pr.sha),
        url: `${repository.webUrl}/-/merge_requests/${iid}` };
    });
  }

  async commits(repository: RepositoryCredentials, iid: number): Promise<HistoricalCommit[]> {
    return (await this.pages(repository, `/merge_requests/${integer(iid)}/commits`)).flatMap((value) => {
      const commit = historyObject(value);
      if (!Array.isArray(commit.parent_ids) || commit.parent_ids.length !== 1) return [];
      return [{ sha: historySha(commit.id), parentSha: historySha(commit.parent_ids[0]),
        authorEmail: typeof commit.author_email === "string" ? commit.author_email : "", createdAt: date(commit.committed_date) }];
    });
  }

  async tree(repository: RepositoryCredentials, sha: string): Promise<RepositoryTreeEntry[]> {
    return (await this.pages(repository, `/repository/tree?recursive=true&ref=${historySha(sha)}`)).map((item) => {
      const entry = historyObject(item);
      return { path: historyPath(entry.path), mode: text(entry.mode), type: text(entry.type) };
    });
  }

  async defaultHead(repository: RepositoryCredentials): Promise<string> {
    return historySha(historyObject(await this.json(repository, "/repository/commits/HEAD")).id);
  }
}
