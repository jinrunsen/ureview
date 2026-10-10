import { ReviewError } from "./types.js";

export interface GitLabReviewUrl {
  origin: string;
  repositoryPath: string;
  iid: number;
}

export function parseGitLabReviewUrl(value: string): GitLabReviewUrl {
  const invalid = () => new ReviewError("invalid_pull_request_url", "请填写有效的 GitLab Merge Request 链接");
  const input = value.trim();
  if (!input || /[\s\\]/.test(input)) throw invalid();
  let url: URL;
  try { url = new URL(input); } catch { throw invalid(); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalid();
  // GitLab 12 之前的 MR 链接没有 /-/ 段。
  const match = /^\/(.+?)(?:\/-)?\/merge_requests\/([1-9]\d*)(?:\/(?:diffs|commits|pipelines|activity))?\/?$/.exec(url.pathname);
  if (!match) throw invalid();
  const iid = Number(match[2]);
  if (!Number.isSafeInteger(iid)) throw invalid();
  let segments: string[];
  try { segments = match[1]!.split("/").map(decodeURIComponent); } catch { throw invalid(); }
  if (segments.length < 2 || segments.some((segment) => !segment || segment === "." || segment === ".." || /[\s/\\\x00-\x1f\x7f]/.test(segment))) throw invalid();
  return { origin: url.origin, repositoryPath: segments.join("/"), iid };
}
