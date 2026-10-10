import { currentTeamId } from "../db/tenant.js";
import { randomUUID } from "node:crypto";
import { ManagedRuleService } from "./managed.js";
import type { ManagedRule } from "./managed-types.js";
import { loadRuleExecutions, ruleExecutionKey, summarizeRuleExecutions, type RuleCounts } from "./executions.js";
import { syncCandidateProposals } from "./proposal-records.js";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAdmin, requireIdentity } from "../auth/context.js";
import type { RepositoryService } from "../repositories/service.js";
import { GitLabHistoryReader, HistoryRateLimitError } from "./history.js";
import { readCatalog, type CatalogLint, type CatalogRule } from "./catalog-source.js";
import { mineHistory, type MinedCandidate, type MiningResult } from "./mining.js";

const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;
export interface CatalogEntry extends CatalogRule { inherited: boolean; counts: RuleCounts }
export interface CandidateEntry extends MinedCandidate { id: string; repositoryId: string; createdAt: string; active: boolean }
export interface RuleSyncState {
  repositoryId: string; syncedAt: string | null; syncError: string | null; warnings: string[];
  minedAt: string | null; miningError: string | null; miningSummary: Omit<MiningResult, "candidates"> | null;
}
interface StateRow {
  repository_id: string; synced_at: Date | null; sync_error: string | null; warnings: string[];
  mined_at: Date | null; mining_error: string | null; mining_summary: RuleSyncState["miningSummary"];
}

export class RuleCatalogService {
  readonly history: GitLabHistoryReader;
  constructor(private readonly pool: pg.Pool, private readonly repositories: RepositoryService) { this.history = new GitLabHistoryReader(repositories); }

  async list(repositoryId?: string): Promise<{ rules: CatalogEntry[]; lints: CatalogLint[]; sync: RuleSyncState[]; managedRules: Array<ManagedRule & { counts: CatalogEntry["counts"] }> }> {
    if (repositoryId) await this.repositories.getCredentials(repositoryId);
    const { rows } = await this.pool.query<{ payload: CatalogRule }>(
      `SELECT payload FROM rule_catalog
       WHERE payload->>'kind' IS DISTINCT FROM 'lint' AND payload->>'scope'='repository'
         AND ($1::uuid IS NULL OR repository_id=$1)
       ORDER BY repository_id,rule_id`, [repositoryId ?? null]);
    const lintRows = await this.pool.query<{ payload: CatalogLint }>(
      `SELECT payload FROM rule_catalog WHERE payload->>'kind'='lint' AND ($1::uuid IS NULL OR repository_id=$1)
       ORDER BY repository_id, array_length(string_to_array(NULLIF(payload->>'checkerRoot',''),'/'),1) DESC NULLS LAST,rule_id`, [repositoryId ?? null]);
    const executions = await loadRuleExecutions(this.pool, repositoryId);
    const counts = (ruleId: string, owner?: string): RuleCounts => {
      const { dismissalReasons: _reasons, ...summary } = summarizeRuleExecutions(executions.get(ruleExecutionKey(ruleId, owner)) ?? []);
      return summary;
    };
    return { rules: rows.map((row) => ({ ...row.payload, judgement: row.payload.judgement ?? false,
      inherited: row.payload.scope === "global" && Boolean(repositoryId && row.payload.file.repositoryId !== repositoryId),
      counts: counts(row.payload.id, row.payload.file.repositoryId) })), lints: lintRows.rows.map((row) => row.payload),
      sync: await this.states(repositoryId), managedRules: (await new ManagedRuleService(this.pool).list(repositoryId))
        .map((rule) => ({ ...rule, counts: counts(`managed:${rule.id}`) })) };
  }

  private async states(repositoryId?: string): Promise<RuleSyncState[]> {
    const { rows } = await this.pool.query<StateRow>(
      "SELECT * FROM rule_sync_state WHERE ($1::uuid IS NULL OR repository_id=$1) ORDER BY repository_id",
      [repositoryId ?? null]);
    return rows.map((row) => ({ repositoryId: row.repository_id, syncedAt: row.synced_at?.toISOString() ?? null,
      syncError: row.sync_error, warnings: row.warnings, minedAt: row.mined_at?.toISOString() ?? null,
      miningError: row.mining_error, miningSummary: row.mining_summary }));
  }

  async sync(repositoryId: string): Promise<void> {
    const repository = await this.repositories.getCredentials(repositoryId);
    try {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-hierarchy:${currentTeamId()}`]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-catalog:${repositoryId}`]);
        const managed = await client.query<{ id: string; layer: import("./metadata.js").RuleLayer; overrides: string[] }>("SELECT 'managed:' || id::text AS id, layer, overrides FROM managed_rules");
        const snapshot = await readCatalog(repository, this.history, managed.rows);
        const candidates = await client.query<{ candidate_key: string; payload: MinedCandidate }>(
          "SELECT candidate_key,payload FROM rule_candidates WHERE repository_id=$1", [repositoryId]);
        await client.query("DELETE FROM rule_catalog WHERE repository_id=$1", [repositoryId]);
        for (const rule of snapshot.rules) {
          const candidate = rule.scope === "repository" && candidates.rows.find((candidate) =>
            candidate.candidate_key === candidate.payload.key && candidate.payload.body === rule.body);
          if (candidate) rule.source = { kind: "mined", url: candidate.payload.evidence[0]!.commentUrl };
          await client.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,$2,$3)", [repositoryId, rule.id, JSON.stringify(rule)]);
        }
        for (const lint of snapshot.lints) {
          await client.query("INSERT INTO rule_catalog(repository_id,rule_id,payload) VALUES($1,$2,$3)", [repositoryId, lint.id, JSON.stringify(lint)]);
        }
        await client.query(`INSERT INTO rule_sync_state(repository_id,synced_at,warnings) VALUES($1,now(),$2)
          ON CONFLICT(team_id,repository_id) DO UPDATE SET synced_at=now(),sync_error=NULL,warnings=excluded.warnings`,
        [repositoryId, JSON.stringify(snapshot.warnings)]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    } catch {
      await this.pool.query(`INSERT INTO rule_sync_state(repository_id,sync_error) VALUES($1,$2)
        ON CONFLICT(team_id,repository_id) DO UPDATE SET sync_error=excluded.sync_error`,
      [repositoryId, "规范同步失败，保留上一次完整结果；请检查 GitLab 连接与规范文件"]);
      throw new Error("规范同步失败，请检查 GitLab 连接与规范文件后重试");
    }
  }

  async candidates(repositoryId?: string): Promise<{ candidates: CandidateEntry[]; sync: RuleSyncState[] }> {
    if (repositoryId) await this.repositories.getCredentials(repositoryId);
    const { rows } = await this.pool.query<{ id: string; repository_id: string; payload: MinedCandidate; created_at: Date; active: boolean }>(
      `SELECT candidate.*, EXISTS(SELECT 1 FROM rule_catalog catalog WHERE catalog.repository_id=candidate.repository_id
         AND catalog.payload->>'kind' IS DISTINCT FROM 'lint'
         AND catalog.payload->>'body'=candidate.payload->>'body'
         AND catalog.payload->>'enabled'='true' AND catalog.payload->>'lazy'='false') AS active
       FROM rule_candidates candidate WHERE ($1::uuid IS NULL OR candidate.repository_id=$1)
       ORDER BY candidate.created_at DESC,candidate.id`, [repositoryId ?? null]);
    return { candidates: rows.map((row) => ({ ...row.payload, id: row.id, repositoryId: row.repository_id,
      createdAt: row.created_at.toISOString(), active: row.active })), sync: await this.states(repositoryId) };
  }

  async mine(repositoryId: string): Promise<{ added: number; nextAt: string }> {
    const repository = await this.repositories.getCredentials(repositoryId);
    const state = (await this.states(repositoryId)).find((entry) => entry.repositoryId === repositoryId);
    if (state?.minedAt && Date.now() < Date.parse(state.minedAt) + FORTNIGHT_MS) {
      return { added: 0, nextAt: new Date(Date.parse(state.minedAt) + FORTNIGHT_MS).toISOString() };
    }
    let result: MiningResult;
    try { result = await mineHistory(repository, this.history); }
    catch (error) {
      await this.pool.query(`INSERT INTO rule_sync_state(repository_id,mining_error) VALUES($1,$2)
        ON CONFLICT(team_id,repository_id) DO UPDATE SET mining_error=excluded.mining_error`,
      [repositoryId, error instanceof HistoryRateLimitError ? error.message : "历史读取不完整，未生成新候选；请检查 GitLab 连接后重试"]);
      if (error instanceof HistoryRateLimitError) throw error;
      throw new Error("规范挖掘失败，未生成新候选；请检查 GitLab 连接后重试");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-mining:${repositoryId}`]);
      const existing = await client.query<{ mined_at: Date | null }>("SELECT mined_at FROM rule_sync_state WHERE repository_id=$1", [repositoryId]);
      const previous = existing.rows[0]?.mined_at;
      if (previous && Date.now() < previous.getTime() + FORTNIGHT_MS) {
        await client.query("COMMIT");
        return { added: 0, nextAt: new Date(previous.getTime() + FORTNIGHT_MS).toISOString() };
      }
      const limit = previous ? 5 : 10;
      let added = 0;
      for (const candidate of result.candidates) {
        const inserted = await client.query(`INSERT INTO rule_candidates(id,repository_id,candidate_key,payload) VALUES($1,$2,$3,$4)
          ON CONFLICT(team_id,repository_id,candidate_key) DO NOTHING`, [randomUUID(), repositoryId, candidate.key, JSON.stringify(candidate)]);
        added += inserted.rowCount ?? 0;
        if (added >= limit) break;
      }
      await syncCandidateProposals(client);
      const { candidates: _candidates, ...summary } = result;
      const completed = await client.query<{ mined_at: Date }>(`INSERT INTO rule_sync_state(repository_id,mined_at,mining_summary) VALUES($1,now(),$2)
        ON CONFLICT(team_id,repository_id) DO UPDATE SET mined_at=now(),mining_error=NULL,mining_summary=excluded.mining_summary RETURNING mined_at`,
      [repositoryId, JSON.stringify(summary)]);
      await client.query("COMMIT");
      return { added, nextAt: new Date(completed.rows[0]!.mined_at.getTime() + FORTNIGHT_MS).toISOString() };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  // 调用者为每个团队建立独立租户上下文；初次接入随下一次检查同步并挖掘。
  async syncDue(): Promise<void> {
    const repositories = await this.repositories.list();
    const states = new Map((await this.states()).map((state) => [state.repositoryId, state]));
    for (const repository of repositories) {
      const state = states.get(repository.id);
      if (!state?.syncedAt || Date.now() - Date.parse(state.syncedAt) >= 5 * 60 * 1000) {
        try { await this.sync(repository.id); } catch { /* 同步失败已经持久化，其他仓库继续。 */ }
      }
      if (!state?.minedAt || Date.now() - Date.parse(state.minedAt) >= FORTNIGHT_MS) {
        try { await this.mine(repository.id); } catch { /* 挖掘失败已经持久化，管理员可重试。 */ }
      }
    }
  }
}

export function registerRuleCatalogRoutes(app: FastifyInstance, dependencies: {
  pool: pg.Pool; repositories: RepositoryService; service?: RuleCatalogService;
}): RuleCatalogService {
  const service = dependencies.service ?? new RuleCatalogService(dependencies.pool, dependencies.repositories);
  const query = { type: "object", additionalProperties: false, properties: { repositoryId: { type: "string", format: "uuid" } } };
  app.get<{ Querystring: { repositoryId?: string } }>("/api/rules", { schema: { querystring: query } }, async (request, reply) => {
    requireIdentity(); reply.header("Cache-Control", "no-store"); return service.list(request.query.repositoryId);
  });
  app.get<{ Querystring: { repositoryId?: string } }>("/api/rule-candidates", { schema: { querystring: query } }, async (request, reply) => {
    requireIdentity(); reply.header("Cache-Control", "no-store"); return service.candidates(request.query.repositoryId);
  });
  for (const operation of ["sync", "mine"] as const) {
    app.post<{ Params: { repositoryId: string } }>(`/api/rules/repositories/:repositoryId/${operation}`, {
      schema: { params: { type: "object", required: ["repositoryId"], properties: { repositoryId: { type: "string", format: "uuid" } } } },
    }, async (request, reply) => {
      requireAdmin(); reply.header("Cache-Control", "no-store");
      try { return { ok: true, ...(operation === "mine" ? await service.mine(request.params.repositoryId) : (await service.sync(request.params.repositoryId), {})) }; }
      catch (error) {
        if (error instanceof HistoryRateLimitError) return reply.code(429).send({ error: { code: "gitlab_rate_limited", message: error.message } });
        if (error instanceof Error && "code" in error && error.code === "not_found") return reply.code(404).send({ error: { code: "not_found", message: "仓库不存在" } });
        return reply.code(502).send({ error: { code: "rules_unavailable", message: operation === "mine" ? "历史读取不完整，未生成新候选" : "规范同步失败，请检查仓库连接与文件" } });
      }
    });
  }
  return service;
}
