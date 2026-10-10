import { loadImportedRuleLibrary } from "./import-publication.js";
import { readdir, readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAdmin, requireIdentity } from "../auth/context.js";
import { ManagedRuleService } from "./managed.js";
import { ManagedRuleError, type ManagedRule, type ManagedRuleInput } from "./managed-types.js";
import { lockRuleHierarchy } from "./managed/relations.js";
import { ruleLayers, ruleLanguages } from "./metadata.js";
import type { LibrarySummary, AppliedLibrarySet, LibraryEntry, LibrarySet, LibrarySource, LibraryUpdate } from "./library-types.js";

const entryAliases: Record<string, string> = {
  "design-principles-identical-branches": "design-principles-simplicity",
  "design-principles-derived-state": "design-principles-parsimony",
  "c-traps-and-pitfalls-input-sentinel": "c-traps-and-pitfalls-getchar-int",
  "dpdk-data-plane-ring-concurrency": "dpdk-data-plane-ring-sync-mode",
  "refactoring-smells-owned-calculation": "refactoring-smells-feature-envy",
  "power-of-ten-checked-parameters": "power-of-ten-checked-results",
  "google-code-review-concurrent-updates": "google-code-review-boundary-inputs",
  "google-code-review-reachable-recovery": "google-code-review-boundary-inputs",
  "google-code-review-meaningful-test-oracle": "google-code-review-regression-assertion",
};
const canonicalEntryId = (id: string) => entryAliases[id] ?? id;
const rejectedLibraryDraft = `rule.status='draft' AND coalesce((SELECT proposal.status='rejected' FROM rule_proposals proposal
  WHERE proposal.managed_rule_id=rule.id AND proposal.source IN ('generation','library')
  ORDER BY proposal.created_at DESC,proposal.id DESC LIMIT 1),false)`;

export async function loadRuleLibrary(): Promise<LibrarySet[]> {
  let directory = new URL("../rule-library/", import.meta.url);
  let filenames: string[];
  try { filenames = await readdir(directory); }
  catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    directory = new URL("../../rule-library/", import.meta.url);
    filenames = await readdir(directory);
  }
  return Promise.all(filenames.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
    const set = JSON.parse(await readFile(new URL(name, directory), "utf8")) as LibrarySet;
    return { ...set, entries: set.entries.map((entry) => ({ ...entry, judgement: entry.judgement ?? set.judgement ?? false })) };
  }));
}
export function managedRuleInput(rule: ManagedRule): ManagedRuleInput {
  return { name: rule.name, body: rule.body, goodExample: rule.goodExample, badExample: rule.badExample,
    judgement: rule.judgement, category: rule.category, severity: rule.severity, layer: rule.layer, languages: rule.languages,
    overrides: rule.overrides, scope: rule.scope, repositories: rule.repositories, status: rule.status };
}
function libraryEntryBody(entry: LibraryEntry): string {
  return [`原文名称：${entry.originalName}`, `摘要：${entry.summary}`, entry.body, `## 检查什么\n\n${entry.check}`, `## 为什么\n\n${entry.why}`, `## 怎么改\n\n${entry.fix}`].join("\n\n");
}
const invalid = (message: string) => new ManagedRuleError(400, "invalid_input", message);
export class RuleLibraryService {
  private readonly managed: ManagedRuleService;
  constructor(private readonly pool: pg.Pool, private readonly builtin: () => Promise<LibrarySet[]> = loadRuleLibrary) { this.managed = new ManagedRuleService(pool); }

  private async load(setId?: string): Promise<LibrarySet[]> {
    return [...(await this.builtin()).filter((set) => !setId || set.id === setId), ...await loadImportedRuleLibrary(this.pool, setId)];
  }
  private async appliedLinks() {
    const links = await this.pool.query<{ id: string; library_source: LibrarySource }>(`SELECT id,
      jsonb_build_object('setId',library_source->>'setId','entryId',library_source->>'entryId',
        'version',library_source->>'version','judgement',library_source->'judgement') AS library_source
      FROM managed_rules rule WHERE library_source IS NOT NULL AND NOT (${rejectedLibraryDraft})`);
    const applied = new Map<string, typeof links.rows[number]>();
    for (const row of links.rows) {
      const entryId = canonicalEntryId(row.library_source.entryId);
      if (!applied.has(entryId) || row.library_source.entryId === entryId) applied.set(entryId, row);
    }
    return applied;
  }

  async list(filters: { layer?: string; language?: string } = {}): Promise<LibrarySummary[]> {
    requireIdentity();
    if (filters.layer && !ruleLayers.includes(filters.layer as typeof ruleLayers[number]) || filters.language && !ruleLanguages.includes(filters.language as typeof ruleLanguages[number])) throw invalid("请选择有效的层级和语言");
    const applied = await this.appliedLinks();
    const sets = [...(await this.builtin()).map((set) => ({ ...set, entryCount: set.entries.length })),
      ...await loadImportedRuleLibrary(this.pool, undefined, false)];
    return sets.filter((set) => (!filters.layer || set.layer === filters.layer)
      && (!filters.language || set.languages.length === 0 || set.languages.includes(filters.language))).map(({ entries, ...set }) => ({ ...set,
        appliedCount: set.sourceType === "imported" ? [...applied.values()].filter((rule) => rule.library_source.setId === set.id).length
          : entries.filter((entry) => applied.has(entry.id)).length }));
  }
  async entries(setId: string): Promise<AppliedLibrarySet["entries"]> {
    requireIdentity();
    const set = (await this.load(setId))[0];
    if (!set) throw new ManagedRuleError(404, "not_found", "规范集不存在");
    const applied = await this.appliedLinks();
    return set.entries.map((entry) => { const rule = applied.get(entry.id); return { ...entry, judgement: entry.judgement ?? set.judgement ?? false,
      appliedRuleId: rule?.id ?? null, appliedVersion: rule?.library_source.version ?? null,
      hasUpdate: Boolean(rule && (rule.library_source.version !== set.libraryVersion || (rule.library_source.judgement ?? false) !== (entry.judgement ?? set.judgement ?? false))) }; });
  }
  async apply(setId: string, value: unknown): Promise<{ rules: ManagedRule[]; created: number }> {
    const actor = requireAdmin();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("请选择规范库条目");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "entryIds") || input.entryIds !== undefined && (!Array.isArray(input.entryIds) || input.entryIds.length === 0
      || input.entryIds.some((id: unknown) => typeof id !== "string") || new Set(input.entryIds).size !== input.entryIds.length)) throw invalid("请选择不重复的规范库条目");
    const set = (await this.load(setId))[0];
    if (!set) throw new ManagedRuleError(404, "not_found", "规范集不存在");
    const ids = input.entryIds as string[] | undefined;
    if (ids?.some((id) => !set.entries.some((entry) => entry.id === id))) throw invalid("所选条目不属于该规范集");
    const entries = set.entries.filter((entry) => !ids || ids.includes(entry.id));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRuleHierarchy(client, actor.teamId);
      const rules: ManagedRule[] = [];
      let created = 0;
      for (const entry of entries) {
        const aliases = Object.keys(entryAliases).filter((id) => entryAliases[id] === entry.id);
        const found = await client.query<{ id: string; version: number; rejected: boolean }>(`SELECT id,version,(${rejectedLibraryDraft}) AS rejected
          FROM managed_rules rule WHERE library_source->>'entryId'=ANY($1::text[])
          ORDER BY rejected ASC,(library_source->>'entryId'=$2) DESC,id LIMIT 1`, [[entry.id, ...aliases], entry.id]);
        const existing = found.rows[0];
        if (existing && !existing.rejected) { rules.push(await this.managed.get(existing.id, client)); continue; }
        if (existing) await this.managed.deleteInTransaction(client, existing.id, existing.version);
        const body = libraryEntryBody(entry);
        const rule = await this.managed.saveInTransaction(client, { name: entry.title, body, goodExample: entry.goodExample, badExample: entry.badExample,
          judgement: entry.judgement ?? set.judgement ?? false, layer: set.layer, languages: set.languages, category: entry.category, severity: entry.severity, scope: "global", repositories: [], overrides: [], status: "active" });
        const source: LibrarySource = { setId: set.id, setName: set.name, sourceFilename: set.sourceFilename ?? set.sources.map((source) => source.title).join("、"), entryId: entry.id, version: set.libraryVersion, body, judgement: entry.judgement ?? set.judgement ?? false, exampleLanguage: entry.exampleLanguage };
        await client.query("UPDATE managed_rules SET library_source=$2 WHERE id=$1", [rule.id, JSON.stringify(source)]);
        rules.push(await this.managed.get(rule.id, client)); created++;
      }
      await client.query("COMMIT");
      return { rules, created };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async updateFor(rule: ManagedRule): Promise<LibraryUpdate | null> {
    if (!rule.librarySource) return null;
    const source = rule.librarySource;
    const set = (await this.load(source.setId))[0];
    const entry = set?.entries.find((entry) => entry.id === canonicalEntryId(source.entryId));
    if (!set || !entry) return null;
    return { setId: set.id, entryId: entry.id, appliedVersion: source.version, latestVersion: set.libraryVersion,
      hasUpdate: source.version !== set.libraryVersion || (source.judgement ?? false) !== (entry.judgement ?? set.judgement ?? false),
      previousJudgement: source.judgement ?? false, currentJudgement: rule.judgement, incomingJudgement: entry.judgement ?? set.judgement ?? false, previousBody: source.body, currentBody: rule.body, incomingBody: libraryEntryBody(entry),
      incomingGoodExample: entry.goodExample, incomingBadExample: entry.badExample, incomingExampleLanguage: entry.exampleLanguage };
  }
  async updateInfo(id: string): Promise<LibraryUpdate | null> { return this.updateFor(await this.managed.get(id)); }
  async adoptUpdate(id: string, value: unknown): Promise<ManagedRule> {
    const actor = requireAdmin();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("请提供规范版本");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "version") || !Number.isSafeInteger(input.version) || Number(input.version) < 1) throw invalid("请提供规范版本");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockRuleHierarchy(client, actor.teamId);
      const rule = await this.managed.get(id, client);
      if (rule.version !== input.version) throw new ManagedRuleError(409, "version_conflict", "规范已更新，请刷新后核对差异");
      const update = await this.updateFor(rule);
      if (!update) throw new ManagedRuleError(404, "not_found", "关联的规范库条目不存在");
      if (update.hasUpdate) {
        await this.managed.saveInTransaction(client, { ...managedRuleInput(rule), body: update.incomingBody,
          goodExample: update.incomingGoodExample, badExample: update.incomingBadExample, judgement: update.incomingJudgement }, { id, version: rule.version });
        const existing = await client.query("SELECT id FROM managed_rules WHERE library_source->>'entryId'=$1 AND id<>$2", [update.entryId, id]);
        await client.query("UPDATE managed_rules SET library_source=$2 WHERE id=$1", [id, JSON.stringify({ ...rule.librarySource,
          entryId: existing.rows.length === 0 ? update.entryId : rule.librarySource!.entryId,
          version: update.latestVersion, body: update.incomingBody, judgement: update.incomingJudgement, exampleLanguage: update.incomingExampleLanguage })]);
      }
      const updated = await this.managed.get(id, client);
      await client.query("COMMIT"); return updated;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
export function registerRuleLibraryRoutes(app: FastifyInstance, dependencies: { pool: pg.Pool; service?: RuleLibraryService }): RuleLibraryService {
  const service = dependencies.service ?? new RuleLibraryService(dependencies.pool);
  void app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ManagedRuleError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.get<{ Querystring: { layer?: string; language?: string } }>("/api/rule-library", async (request) => ({ sets: await service.list(request.query) }));
    routes.get<{ Params: { setId: string } }>("/api/rule-library/:setId/entries", async (request) => ({ entries: await service.entries(request.params.setId) }));
    routes.post<{ Params: { setId: string }; Body: unknown }>("/api/rule-library/:setId/apply", { bodyLimit: 16000 }, async (request) => service.apply(request.params.setId, request.body));
    routes.get<{ Params: { id: string } }>("/api/managed-rules/:id/library-update", async (request) => ({ update: await service.updateInfo(request.params.id) }));
    routes.post<{ Params: { id: string }; Body: unknown }>("/api/managed-rules/:id/library-update", { bodyLimit: 4096 }, async (request) => ({ rule: await service.adoptUpdate(request.params.id, request.body) }));
  });
  return service;
}
