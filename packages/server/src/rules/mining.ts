import { createHash } from "node:crypto";
import type { RepositoryCredentials } from "../reviews/types.js";
import { GitLabPlatform } from "../platform/gitlab.js";
import { GitLabHistoryReader, type HistoricalCommit } from "./history.js";
import { readCatalogLocation } from "./catalog-source.js";

export interface AdoptionEvidence {
  iid: number; pullRequestUrl: string; commentUrl: string; author: string; path: string;
  before: string; after: string; beforeSha: string; afterSha: string; commitUrl: string;
}
export interface MinedCandidate { key: string; body: string; suggestedPath: string; markdown: string; evidence: AdoptionEvidence[] }
export interface MiningResult { candidates: MinedCandidate[]; scanned: number; skippedNoAdoption: number }

export function groupCandidates(evidence: Array<{ body: string; evidence: AdoptionEvidence }>, rulesRoot = ".agents/rules/"): MinedCandidate[] {
  const groups = new Map<string, { body: string; evidence: AdoptionEvidence[] }>();
  for (const item of evidence) {
    const body = item.body.trim().replace(/\r\n/g, "\n");
    if (body.length < 12 || body.length > 4000) continue;
    const key = createHash("sha256").update(body).digest("hex");
    const group = groups.get(key) ?? { body, evidence: [] };
    if (!group.evidence.some((entry) => entry.iid === item.evidence.iid)) group.evidence.push(item.evidence);
    groups.set(key, group);
  }
  return [...groups].filter(([, group]) => group.evidence.length >= 2).map(([key, group]) => {
    const paths = [...new Set(group.evidence.map((entry) => entry.path))].sort();
    const suggestedPath = `${rulesRoot}candidate-${key.slice(0, 12)}.md`;
    const markdown = `---\nname: 候选规范 ${key.slice(0, 12)}\npaths:\n${paths.map((path) => `  - ${JSON.stringify(path)}`).join("\n")}\n---\n${group.body}\n`;
    return { key, body: group.body, evidence: group.evidence, suggestedPath, markdown };
  }).sort((left, right) => right.evidence.length - left.evidence.length || left.key.localeCompare(right.key));
}

export async function mineHistory(repository: RepositoryCredentials, history: GitLabHistoryReader): Promise<MiningResult> {
  const { rulesRoot } = await readCatalogLocation(repository, history);
  const requests = await history.pullRequests(repository);
  const platform = new GitLabPlatform(repository);
  const result: MiningResult = { candidates: [], scanned: requests.length, skippedNoAdoption: 0 };
  const evidence: Array<{ body: string; evidence: AdoptionEvidence }> = [];
  for (const request of requests) {
    let commits: HistoricalCommit[] | undefined;
    let adopted = false;
    for (const discussion of await history.getDiscussions(repository.id, request.iid)) {
      for (const note of discussion.notes) {
        if (!note.position || note.authorId === request.authorId) continue;
        const body = note.body.replace(/```suggestion[^\n]*\n[\s\S]*?```/g, "").trim();
        if (body.length < 12) continue;
        for (const suggestion of note.suggestions) {
          if (!suggestion.before.trim() || !suggestion.after.trim() || suggestion.before === suggestion.after) continue;
          commits ??= await history.commits(repository, request.iid);
          for (const commit of commits.filter((commit) => Date.parse(commit.createdAt) > Date.parse(note.createdAt))) {
            const before = (await platform.getFileContent(commit.parentSha, note.position.path)).content;
            const after = (await platform.getFileContent(commit.sha, note.position.path)).content;
            const lines = before.split(/\r?\n/);
            const original = lines.slice(suggestion.fromLine - 1, suggestion.toLine).join("\n");
            if (original !== suggestion.before.replace(/\n$/, "")) continue;
            const replacement = suggestion.after.replace(/\n$/, "").split("\n");
            const expected = [...lines.slice(0, suggestion.fromLine - 1), ...replacement, ...lines.slice(suggestion.toLine)].join("\n");
            // 整文件精确替换排除同一提交里无法归因的其他变化；resolved 字段不参与判断。
            if (expected !== after.replace(/\r\n/g, "\n")) continue;
            evidence.push({ body, evidence: { iid: request.iid, pullRequestUrl: request.url, commentUrl: note.url,
              author: commit.authorEmail, path: note.position.path, before: original, after: suggestion.after,
              beforeSha: commit.parentSha, afterSha: commit.sha, commitUrl: `${repository.webUrl}/-/commit/${commit.sha}` } });
            adopted = true; break;
          }
        }
      }
    }
    if (!adopted) result.skippedNoAdoption++;
  }
  result.candidates = groupCandidates(evidence, rulesRoot);
  return result;
}
