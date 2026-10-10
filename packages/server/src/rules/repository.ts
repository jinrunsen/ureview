import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchesRuleLanguage, layerLabels, ruleLayers, ruleLanguages, validOverrides, type RuleLayer, type RuleRelation } from "./metadata.js";
import { resolveRuleEffects, effectivePaths } from "./effect.js";
import type { ReviewRule, RepositoryCredentials, RepositoryRuleSession, GitReviewRule } from "../reviews/types.js";

const HEAD_BYTES = 16 * 1024;
const HEAD_LINES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const SCAN_DEPTH = 8;
const CONFIG_PATH = ".sase-rule-inject.json";
const defaults = { enabled: true, rulesRoot: ".agents/rules/", maxRuleChars: 9400, maxTotalChars: 9500,
  refreshWindowTurns: 30, refreshWindowSeconds: 2700 };
type Configuration = typeof defaults;
type Warn = (message: string) => void;
type RuleFile = { path: string; absolute: string; name: string; description: string; endLine: number;
  judgement: boolean; layer: RuleLayer; languages: string[]; overrides: string[]; layerDepth: number; score: number; matchedPaths: string[] };
type Delivery = { hash: string; turn: number; time: number; rule: GitReviewRule };
type Content = { body: string; hash: string };

const lexical = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const slash = (path: string) => path.split(sep).join("/");
const within = (root: string, path: string) => {
  const part = relative(root, path);
  return part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unquote = (value: string) => {
  const text = value.trim();
  return text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
    ? text.slice(1, -1) : text;
};

export function glob(pattern: string): RegExp | null {
  if (!pattern || pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern) || /[\\\x00-\x1f\x7f]/.test(pattern) || pattern.split("/").includes("..")) return null;
  const source = pattern.endsWith("/") ? `${pattern}**` : pattern;
  let expression = "";
  for (let index = 0; index < source.length; index++) {
    const character = source[index]!;
    if (character === "*" && source[index + 1] === "*") {
      const segmentStart = index === 0 || source[index - 1] === "/";
      index++;
      if (segmentStart && source[index + 1] === "/") { expression += "(?:[^/]+/)*"; index++; }
      else expression += ".*";
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += ".+^${}()|[]\\".includes(character) ? `\\${character}` : character;
  }
  return new RegExp(`^${expression}$`);
}

export function frontmatter(text: string, complete: boolean, warn: Warn = () => {}): { paths: string[]; name: string; description: string; endLine: number; judgement: boolean; layer: RuleLayer; languages: string[]; overrides: string[] } | null {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const endLine = lines.findIndex((line, index) => index > 0 && index <= HEAD_LINES && line.trim() === "---");
  if (endLine < 0) {
    if (!complete || lines.length > HEAD_LINES) throw new Error("frontmatter 未在 16 KiB / 200 行内闭合");
    return null;
  }
  const result = { paths: [] as string[], name: "", description: "", endLine, judgement: false, layer: "team" as RuleLayer, languages: [] as string[], overrides: [] as string[] };
  for (let index = 1; index < endLine; index++) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(lines[index]!);
    if (!match) continue;
    const key = match[1];
    const value = (match[2] ?? "").trim();
    if (key === "name" || key === "description") result[key] = unquote(value);
    else if (key === "judgement") {
      if (value === "true" || value === "false") result.judgement = value === "true";
      else warn("judgement 必须是 true 或 false，使用非判断题");
    } else if (key === "layer") {
      if (ruleLayers.includes(unquote(value) as RuleLayer)) result.layer = unquote(value) as RuleLayer;
      else warn("layer 无效，使用团队层");
    } else if (key === "paths" || key === "languages" || key === "overrides") {
      if (value.startsWith("[") && value.endsWith("]")) result[key] = value.slice(1, -1).split(",").map(unquote).filter(Boolean);
      else if (!value) {
        const paths: string[] = [];
        for (let item = index + 1; item < endLine; item++) {
          const line = lines[item]!;
          if (!line.trim()) continue;
          const entry = /^\s+-\s*(.*)$/.exec(line);
          if (entry) { paths.push(unquote(entry[1]!)); continue; }
          if (/^[A-Za-z_][A-Za-z0-9_-]*:/.test(line)) break;
          if (key === "paths" && !paths.length) throw new Error("paths 必须是 glob 列表");
          if (key !== "paths") {
            warn(`${key} 必须是列表，已忽略`);
            if (key === "languages") paths.push("invalid");
          }
          break;
        }
        result[key] = paths;
      } else if (key === "paths") throw new Error("paths 必须是 glob 列表");
      else { warn(`${key} 必须是列表，已忽略`); if (key === "languages") result.languages = ["invalid"]; }
    }
  }
  if (result.languages.some((language) => !ruleLanguages.includes(language))) {
    warn("languages 含未知语言，该规范仅匹配已声明的有效语言");
  }
  return result;
}

async function safePath(root: string, path: string): Promise<boolean> {
  if (!within(root, path)) return false;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) return false;
  }
  return within(root, await realpath(path));
}

async function readBounded(root: string, path: string, headOnly: boolean): Promise<{ raw: Buffer; text: string; complete: boolean }> {
  if (!await safePath(root, path)) throw new Error("规则文件不能是符号链接或位于工作副本之外");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error("规则文件必须是大小不超过 1 MiB 的普通 UTF-8 文件");
    const length = headOnly ? Math.min(HEAD_BYTES, info.size) : info.size;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const raw = buffer.subarray(0, offset);
    const complete = offset >= info.size;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw, { stream: !complete });
    return { raw, text, complete };
  } finally { await handle.close(); }
}

async function configuration(root: string, warn: Warn): Promise<Configuration> {
  const config = { ...defaults };
  try {
    const document: unknown = JSON.parse((await readBounded(root, join(root, CONFIG_PATH), false)).text);
    if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("配置必须是对象");
    for (const [key, value] of Object.entries(document)) {
      if (key === "enabled" && typeof value === "boolean") config.enabled = value;
      else if (key === "rulesRoot" && typeof value === "string" && value.trim() && !isAbsolute(value) && !/^[A-Za-z]:/.test(value)
        && !/[\\\x00-\x1f\x7f]/.test(value) && !value.split("/").includes("..")) config.rulesRoot = value;
      else if (["maxRuleChars", "maxTotalChars", "refreshWindowTurns", "refreshWindowSeconds"].includes(key)
        && typeof value === "number" && Number.isSafeInteger(value) && value >= 0) config[key as "maxRuleChars"] = value;
      else if (Object.hasOwn(defaults, key)) warn(`${CONFIG_PATH} 的 ${key} 无效，使用默认值`);
    }
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) warn(`${CONFIG_PATH} 无法读取或解析，使用默认配置`);
  }
  return config;
}

async function discover(root: string, paths: string[], config: Configuration, warn: Warn, includeUnmatched = false): Promise<RuleFile[]> {
  const files: string[] = [];
  for (const path of new Set(paths)) {
    if (!path || path.includes("\0")) continue;
    const absolute = resolve(root, path);
    try { if (await safePath(root, absolute) && (await lstat(absolute)).isFile()) files.push(absolute); } catch { /* 读取后已消失的路径不参与匹配。 */ }
  }
  const layers = new Set<string>();
  for (const file of files) {
    for (let layer = dirname(file); within(root, layer); layer = dirname(layer)) {
      layers.add(layer);
      if (layer === root) break;
    }
  }
  const rules: RuleFile[] = [];
  for (const layer of layers) {
    const ruleRoot = resolve(layer, config.rulesRoot);
    try { if (!await safePath(root, ruleRoot) || !(await lstat(ruleRoot)).isDirectory()) continue; } catch { continue; }
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > SCAN_DEPTH) return;
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); } catch { warn(`${slash(relative(root, directory))} 无法读取，跳过规则目录`); return; }
      for (const entry of entries.sort((left, right) => lexical(left.name, right.name))) {
        const absolute = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) { await walk(absolute, depth + 1); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const path = slash(relative(root, absolute));
        try {
          const head = await readBounded(root, absolute, true);
          const metadata = frontmatter(head.text, head.complete, (message) => warn(`${path} 的 ${message}`));
          if (!metadata) continue;
          const patterns = metadata.paths.flatMap((pattern) => {
            const expression = glob(pattern);
            if (!expression) { warn(`${path} 含无效 glob，已跳过该项`); return []; }
            return [{ expression, score: pattern.replace(/[*?]/g, "").length }];
          });
          let score = -1;
          const matchedPaths: string[] = [];
          for (const file of files) {
            if (!within(layer, file) || !matchesRuleLanguage(metadata.languages, slash(relative(root, file)))) continue;
            const matched = patterns.filter(({ expression }) => expression.test(slash(relative(layer, file))));
            if (matched.length) {
              score = Math.max(score, ...matched.map((pattern) => pattern.score));
              matchedPaths.push(slash(relative(root, file)));
            }
          }
          if (score >= 0 || includeUnmatched) rules.push({ path, absolute, ...metadata, name: metadata.name || basename(path, ".md"),
            layerDepth: relative(root, layer).split(sep).filter(Boolean).length, score, matchedPaths });
        } catch (error) { warn(`${path} 无法加载：${error instanceof Error ? error.message : "规则文件无效"}`); }
      }
    };
    await walk(ruleRoot, 0);
  }
  return [...new Map(rules.map((rule) => [rule.path, rule])).values()].sort((left, right) =>
    ruleLayers.indexOf(left.layer) - ruleLayers.indexOf(right.layer) || right.layerDepth - left.layerDepth || right.score - left.score || lexical(left.path, right.path));
}

function renderFull(rule: RuleFile, content: Content, limit: number): string | null {
  const opening = `<rule-context id="${attribute(`repository:${rule.path}`)}" file="${attribute(rule.path)}" rule="${attribute(rule.name)}" sha256="${content.hash}" paths="${attribute(rule.matchedPaths.join(","))}"${rule.judgement ? ' judgement="true"' : ""}>${rule.judgement ? "\n判断题规范" : ""}`;
  const closing = "</rule-context>";
  const full = `${opening}\n${content.body}\n${closing}`;
  if (!limit || full.length <= limit) return full;
  const notice = `\n…（已截断：全文请读 ${rule.path}）`;
  const room = limit - opening.length - closing.length - notice.length - 2;
  return room > 0 ? `${opening}\n${content.body.slice(0, room)}${notice}\n${closing}` : null;
}

function renderTicket(rule: RuleFile): string {
  return `<rule-ticket id="${attribute(`repository:${rule.path}`)}" file="${attribute(rule.path)}"${rule.judgement ? ' judgement="true"' : ""}>${rule.judgement ? "判断题规范。" : ""}本会话已注入过此规则；它仍适用于本次读取的文件。如需完整内容，请读取 ${rule.path}。</rule-ticket>`;
}

function renderIndex(rules: RuleFile[], limit: number): string {
  const opening = "<rule-index>\n以下规范因预算不足尚未注入，不能引用其 ID。再次读取适用代码时会继续尝试注入：";
  const closing = "\n</rule-index>";
  const lines = rules.map((rule) => `\n<rule-ref id="${attribute(`repository:${rule.path}`)}" file="${attribute(rule.path)}">${rule.path}${rule.description ? ` — ${rule.description}` : ""}</rule-ref>`);
  for (let count = lines.length; count >= 0; count--) {
    const remainder = count < lines.length ? `\n（另有 ${lines.length - count} 条）` : "";
    const index = opening + lines.slice(0, count).join("") + remainder + closing;
    if (index.length <= limit) return index;
  }
  const summary = `规则预算不足，另有 ${rules.length} 条未注入。`;
  return summary.length <= limit ? summary : "";
}

function ruleSnapshot(rule: RuleFile, body: string, repository: RepositoryCredentials, commitSha: string): GitReviewRule {
  return { id: `repository:${rule.path}`, body, judgement: rule.judgement, layer: rule.layer, languages: rule.languages, overrides: rule.overrides,
    source: { kind: "manual" }, file: { kind: "repository", repositoryId: repository.id, repositoryName: repository.pathWithNamespace,
      path: rule.path, commitSha, url: `${repository.webUrl}/-/blob/${encodeURIComponent(commitSha)}/${rule.path.split("/").map(encodeURIComponent).join("/")}` },
    matchedPaths: rule.matchedPaths };
}

async function validateRelations(root: string, config: Configuration, rules: RuleFile[], managed: RuleRelation[], warn: Warn): Promise<void> {
  const relations: RuleRelation[] = [...managed, ...rules.map((rule) => ({ ...rule, id: `repository:${rule.path}` }))];
  const known = new Set(relations.map((rule) => rule.id));
  const pending = relations.flatMap((rule) => rule.overrides ?? []);
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]!;
    if (known.has(id) || !id.startsWith("repository:")) continue;
    known.add(id);
    const path = id.slice("repository:".length);
    const rulesRoot = config.rulesRoot.replace(/\/+$/, "") + "/";
    if ((!path.startsWith(rulesRoot) && !path.includes(`/${rulesRoot}`)) || !path.endsWith(".md") || path.split("/").includes("..")) continue;
    try {
      const head = await readBounded(root, resolve(root, path), true);
      const metadata = frontmatter(head.text, head.complete, (message) => warn(`${path} 的 ${message}`));
      if (metadata) {
        relations.push({ id, layer: metadata.layer, overrides: metadata.overrides });
        pending.push(...metadata.overrides);
      }
    } catch { /* 缺失或不可读的目标由关系校验统一告警。 */ }
  }
  const overrides = rules.map((rule) => validOverrides({ ...rule, id: `repository:${rule.path}` }, relations, warn));
  rules.forEach((rule, index) => { rule.overrides = overrides[index]!; });
}

/** 预注入前只读取仓库规范的元数据；正文仍由实际代码读取触发。 */
export async function prepareManagedRuleEffects(cwd: string, repository: RepositoryCredentials, commitSha: string,
  paths: string[], managed: ReviewRule[], warn: Warn = (message) => console.warn(`[ureview-rules] ${message}`), relations: RuleRelation[] = managed): Promise<ReviewRule[]> {
  const root = await realpath(cwd);
  const config = await configuration(root, warn);
  if (!config.enabled) return managed;
  const rules = await discover(root, paths, config, warn, true);
  await validateRelations(root, config, rules, relations, warn);
  const candidates = rules.filter((rule) => rule.matchedPaths.length).map((rule) => ruleSnapshot(rule, "", repository, commitSha));
  return resolveRuleEffects([...managed, ...candidates]).filter((rule) => rule.file.kind === "database");
}

export function createRepositoryRuleSession(cwd: string, repository: RepositoryCredentials, commitSha: string,
  warning: Warn = (message) => console.warn(`[ureview-rules] ${message}`), managed: ReviewRule[] = [], relations: RuleRelation[] = managed): RepositoryRuleSession<GitReviewRule> {
  const delivered = new Map<string, Delivery>();
  const suppressed = new Map<string, GitReviewRule>();
  const warnings = new Set<string>();
  const warn: Warn = (message) => { if (!warnings.has(message)) { warnings.add(message); warning(message); } };
  const snapshot = () => structuredClone([...delivered.values()].map((item) => item.rule).concat([...suppressed.values()]));
  let pending = Promise.resolve();
  const run = async (paths: string[], turn: number): Promise<{ context: string; rules: GitReviewRule[] }> => {
    const root = await realpath(cwd);
    const config = await configuration(root, warn);
    if (!config.enabled) return { context: "", rules: snapshot() };
    const discovered = await discover(root, paths, config, warn, true);
    await validateRelations(root, config, discovered, relations, warn);
    const contents = new Map<string, Content>();
    const candidates = new Map(snapshot().map((rule) => [rule.id, rule]));
    const rules: RuleFile[] = [];
    for (const rule of discovered.filter((rule) => rule.matchedPaths.length)) {
      try {
        const { raw, text } = await readBounded(root, rule.absolute, false);
        const content = { hash: createHash("sha256").update(raw).digest("hex"), body: text.split(/\r?\n/).slice(rule.endLine + 1).join("\n").trim() };
        contents.set(rule.path, content);
        const candidate = ruleSnapshot(rule, content.body, repository, commitSha);
        candidate.matchedPaths = [...new Set([...(candidates.get(candidate.id)?.matchedPaths ?? []), ...rule.matchedPaths])];
        candidates.set(candidate.id, candidate);
        rules.push(rule);
      } catch (error) { warn(`${rule.path} 命中但无法读取：${error instanceof Error ? error.message : "规则文件无效"}`); }
    }
    const effects = new Map(resolveRuleEffects([...managed, ...candidates.values()]).map((rule) => [rule.id, rule]));
    const parts: string[] = [];
    const overflow: RuleFile[] = [];
    const now = Date.now();
    let used = 0;
    let lastLayer: RuleLayer | undefined;
    const budget = config.maxTotalChars || Infinity;
    for (const rule of rules) {
      const candidate = effects.get(`repository:${rule.path}`)! as GitReviewRule;
      if (!effectivePaths(candidate).length) { suppressed.set(rule.path, candidate); delivered.delete(rule.path); continue; }
      suppressed.delete(rule.path);
      const content = contents.get(rule.path)!;
      const previous = delivered.get(rule.path);
      const changed = !previous || previous.hash !== content.hash;
      const delta = previous && Number.isFinite(turn) && Number.isFinite(previous.turn) ? turn - previous.turn : null;
      const elapsed = previous ? (now - previous.time) / 1000 : 0;
      const fresh = !changed && (delta !== null
        ? config.refreshWindowTurns === 0 || delta >= 0 && delta < config.refreshWindowTurns
        : config.refreshWindowSeconds === 0 || elapsed >= 0 && elapsed < config.refreshWindowSeconds);
      if (previous && !changed) previous.rule = candidate;
      if (fresh) continue;
      const heading = lastLayer === rule.layer ? "" : `${layerLabels[rule.layer]}：\n`;
      const rendered = changed ? renderFull({ ...rule, matchedPaths: effectivePaths(candidate) }, content, config.maxRuleChars ? Math.max(1, config.maxRuleChars - heading.length) : 0) : renderTicket(rule);
      const block = rendered === null ? null : heading + rendered;
      const cost = (parts.length ? 2 : 0) + (block?.length ?? 0);
      if (block === null || used + cost > budget) { overflow.push(rule); continue; }
      parts.push(block);
      lastLayer = rule.layer;
      used += cost;
      delivered.set(rule.path, { hash: content.hash, turn, time: now, rule: candidate });
    }
    if (overflow.length) {
      const index = renderIndex(overflow, budget - used - (parts.length ? 2 : 0));
      if (index) parts.push(index);
    }
    return { context: parts.join("\n\n"), rules: snapshot() };
  };
  return { resolve(paths, turn) {
    const result = pending.then(() => run(paths, turn)).catch(() => {
      warn("仓库规范发现失败，本次读取继续执行");
      return { context: "", rules: snapshot() };
    });
    pending = result.then(() => undefined);
    return result;
  } };
}
