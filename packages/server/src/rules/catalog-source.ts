import { validOverrides, type RuleLayer, type RuleRelation } from "./metadata.js";
import type { RepositoryCredentials, ReviewRule, GitRuleFile } from "../reviews/types.js";
import { posix } from "node:path";
import { GitLabPlatform } from "../platform/gitlab.js";
import { GitLabHistoryReader } from "./history.js";
import { frontmatter, glob } from "./repository.js";
import { readLintCatalog, type CatalogLint } from "./lint-catalog.js";

export type { CatalogLint } from "./lint-catalog.js";

export interface CatalogRule {
  id: string; name: string; body: string; scope: "global" | "repository";
  source: ReviewRule["source"]; file: GitRuleFile;
  judgement: boolean; layer: RuleLayer; overrides: string[]; paths: string[]; languages: string[]; lazy: boolean; enabled: boolean;
}
export interface CatalogSnapshot { rules: CatalogRule[]; lints: CatalogLint[]; warnings: string[]; commitSha: string }

export async function readCatalogLocation(repository: RepositoryCredentials, history: GitLabHistoryReader) {
  const commitSha = await history.defaultHead(repository);
  const entries = await history.tree(repository, commitSha);
  const regular = new Set(entries.filter((entry) => entry.type === "blob" && ["100644", "100755"].includes(entry.mode)).map((entry) => entry.path));
  const platform = new GitLabPlatform(repository);
  const warnings: string[] = [];
  let rulesRoot = ".agents/rules/", enabled = true;
  if (regular.has(".sase-rule-inject.json")) {
    const content = (await platform.getFileContent(commitSha, ".sase-rule-inject.json")).content;
    try {
      const configuration: unknown = JSON.parse(content);
      if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new Error();
      const config = configuration as Record<string, unknown>;
      if (typeof config.enabled === "boolean") enabled = config.enabled;
      if (typeof config.rulesRoot === "string" && config.rulesRoot.trim() && !config.rulesRoot.startsWith("/") &&
        !/^[A-Za-z]:/.test(config.rulesRoot) && !/[\\\x00-\x1f\x7f]/.test(config.rulesRoot) && !config.rulesRoot.split("/").includes("..")) {
        const normalized = posix.normalize(config.rulesRoot).replace(/\/+$/, "");
        rulesRoot = normalized === "." ? "" : normalized + "/";
      }
    } catch { warnings.push("仓库规则配置无效，目录按默认规则位置显示"); }
  }
  return { commitSha, regular, rulesRoot, enabled, warnings };
}

export async function readCatalog(repository: RepositoryCredentials, history: GitLabHistoryReader, managed: RuleRelation[] = []): Promise<CatalogSnapshot> {
  const { commitSha, regular, rulesRoot, enabled, warnings } = await readCatalogLocation(repository, history);
  const platform = new GitLabPlatform(repository);
  const file = (path: string, kind: "global" | "repository"): GitRuleFile => ({ kind,
    repositoryId: repository.id, repositoryName: repository.pathWithNamespace, path, commitSha,
    url: `${repository.webUrl}/-/blob/${commitSha}/${path.split("/").map(encodeURIComponent).join("/")}` });
  const rules: CatalogRule[] = [];
  for (const path of [...regular].sort()) {
    const marker = path.startsWith(rulesRoot) ? 0 : path.indexOf(`/${rulesRoot}`) + 1;
    if ((!marker && !path.startsWith(rulesRoot)) || !path.endsWith(".md")) continue;
    if (path.slice(marker + rulesRoot.length).split("/").length > 9) continue;
    const content = (await platform.getFileContent(commitSha, path)).content;
    try {
      if (Buffer.byteLength(content) > 1024 * 1024) throw new Error();
      const metadata = frontmatter(Buffer.from(content).subarray(0, 16 * 1024).toString("utf8"), Buffer.byteLength(content) <= 16 * 1024, (message) => warnings.push(`${path} 的 ${message}`));
      if (!metadata) continue;
      const paths = metadata.paths.filter((pattern) => {
        if (glob(pattern)) return true;
        warnings.push(`${path} 的无效路径条件已跳过`); return false;
      });
      rules.push({ id: `repository:${path}`, name: metadata.name || path.split("/").at(-1)!.slice(0, -3),
        body: content.split(/\r?\n/).slice(metadata.endLine + 1).join("\n").trim(), scope: "repository",
        source: { kind: "manual" }, file: file(path, "repository"), paths, judgement: metadata.judgement, layer: metadata.layer, overrides: metadata.overrides, languages: metadata.languages, lazy: paths.length === 0, enabled });
    } catch { warnings.push(`${path} 无法作为规范读取，已跳过`); }
  }
  const relations = [...managed, ...rules];
  const validated = rules.map((rule) => validOverrides(rule, relations, (message) => warnings.push(message)));
  rules.forEach((rule, index) => { rule.overrides = validated[index]!; });
  const lints = await readLintCatalog(regular, async (path) => (await platform.getFileContent(commitSha, path)).content,
    (path) => file(path, "repository"), warnings);
  return { rules, lints, warnings, commitSha };
}
