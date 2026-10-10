import { loadRuleLibrary } from "./library.js";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireIdentity } from "../auth/context.js";
import type { DatabaseRuleFile, GitReviewRule, GitRuleFile, ReviewRule } from "../reviews/types.js";
import type { CatalogRule } from "./catalog-source.js";
import { loadRuleExecutions, ruleExecutionKey, summarizeRuleExecutions, type RuleExecution, type RuleExecutionSummary } from "./executions.js";
import { ManagedRuleService } from "./managed.js";
import { getManagedRuleId, ManagedRuleError, type ManagedRule, type RuleWaiver } from "./managed-types.js";
import { listRuleWaivers } from "./managed/waivers.js";
import type { RuleLayer } from "./metadata.js";

export interface RuleDetail {
  rule: {
    id: string; name: string; body: string; goodExample: string; badExample: string;
    judgement: boolean; layer: RuleLayer; languages: string[]; overrides: string[];
    overriddenBy: Array<{ id: string; name: string; repositoryId?: string }>;
    scope: "global" | "repositories" | "repository";
    repositories: Array<{ repositoryId: string; paths: string[] }>;
    waivers: RuleWaiver[];
    source: { kind: "managed" } | { kind: "git"; file: GitRuleFile }
      | { kind: "library"; setId: string; entryId: string; setName: string; sourceFilename: string; libraryVersion: string };
    version: number | string;
    status: "active" | "draft" | "disabled" | "lazy" | "snapshot";
    managedRule?: ManagedRule;
  };
  records: RuleExecution[];
  summary: RuleExecutionSummary;
}

export class RuleDetailService {
  constructor(private readonly pool: pg.Pool) {}

  private async libraryOrigin(source: NonNullable<ManagedRule["librarySource"]>): Promise<{ setName: string; sourceFilename: string }> {
    const imported = (await this.pool.query<{ name: string; filename: string }>(`SELECT sets.name,file.name AS filename
      FROM rule_library_import_sets sets JOIN rule_library_import_files file ON file.id=sets.file_id WHERE sets.id=$1`, [source.setId])).rows[0];
    if (imported) return { setName: imported.name, sourceFilename: imported.filename };
    const builtin = (await loadRuleLibrary()).find((set) => set.id === source.setId);
    return { setName: builtin?.name ?? source.setName ?? "来源规范集已删除", sourceFilename: source.sourceFilename ?? builtin?.sources.map((item) => item.title).join("、") ?? "来源文件不可用" };
  }

  private async managedSnapshot(ruleId: string, managedId: string, repositoryId?: string): Promise<RuleDetail["rule"]> {
    const saved = await this.pool.query<{ repository_id: string; snapshot: ReviewRule & { file: DatabaseRuleFile } }>(`
      SELECT review.repository_id,snapshot FROM reviews review CROSS JOIN LATERAL jsonb_array_elements(review.rules) snapshot
      WHERE review.status='completed' AND snapshot->>'id'=$1 AND snapshot->'file'->>'kind'='database'
        AND snapshot->'file'->>'ruleId'=$2 AND ($3::uuid IS NULL OR review.repository_id=$3)
      ORDER BY review.completed_at DESC NULLS LAST,review.created_at DESC,review.id DESC LIMIT 1`, [ruleId, managedId, repositoryId ?? null]);
    const row = saved.rows[0];
    if (!row) throw new ManagedRuleError(404, "not_found", "规范不存在");
    const snapshot = row.snapshot;
    return { id: snapshot.id, name: snapshot.name ?? snapshot.id, body: snapshot.body,
      goodExample: snapshot.goodExample ?? "", badExample: snapshot.badExample ?? "",
      judgement: snapshot.judgement ?? false, layer: snapshot.layer ?? "team", languages: snapshot.languages ?? [], overrides: snapshot.overrides ?? [],
      overriddenBy: (snapshot.overriddenBy ?? []).map((entry) => ({ id: entry.ruleId, name: entry.ruleId,
        ...(!getManagedRuleId(entry.ruleId) ? { repositoryId: row.repository_id } : {}) })),
      scope: snapshot.file.scope, repositories: snapshot.file.scope === "global" ? [] : [{ repositoryId: row.repository_id, paths: snapshot.matchedPaths }],
      waivers: [], source: { kind: "managed" }, version: snapshot.file.version, status: "snapshot" };
  }

  async get(ruleId: string, repositoryId?: string): Promise<RuleDetail> {
    requireIdentity();
    if (repositoryId && !(await this.pool.query("SELECT id FROM repositories WHERE id=$1", [repositoryId])).rowCount) {
      throw new ManagedRuleError(404, "not_found", "仓库不存在");
    }
    let rule: RuleDetail["rule"];
    const managedId = getManagedRuleId(ruleId);
    if (managedId) {
      const managed = await new ManagedRuleService(this.pool).get(managedId).catch((error: unknown) => {
        if (error instanceof ManagedRuleError && error.statusCode === 404) return undefined;
        throw error;
      });
      rule = managed ? { id: ruleId, name: managed.name, body: managed.body, goodExample: managed.goodExample, badExample: managed.badExample,
        judgement: managed.judgement, layer: managed.layer, languages: managed.languages, overrides: managed.overrides, overriddenBy: [],
        scope: managed.scope, repositories: managed.repositories, waivers: await listRuleWaivers(this.pool, managed.id),
        source: managed.librarySource ? { kind: "library", setId: managed.librarySource.setId,
          entryId: managed.librarySource.entryId, ...await this.libraryOrigin(managed.librarySource), libraryVersion: managed.librarySource.version } : { kind: "managed" },
        version: managed.version, status: managed.status, managedRule: managed } : await this.managedSnapshot(ruleId, managedId, repositoryId);
    } else {
      if (!repositoryId || !["repository:", "managed:"].some((prefix) => ruleId.startsWith(prefix))) throw new ManagedRuleError(400, "invalid_input", "Git 规范需要提供所属仓库");
      const result = await this.pool.query<{ payload: CatalogRule }>(`SELECT payload FROM rule_catalog
        WHERE rule_id=$1 AND repository_id=$2 AND payload->>'kind' IS DISTINCT FROM 'lint'
          AND payload->>'scope'='repository'`, [ruleId, repositoryId]);
      const git = result.rows[0]?.payload;
      if (git) {
        rule = { id: git.id, name: git.name, body: git.body, goodExample: "", badExample: "",
          judgement: git.judgement ?? false, layer: git.layer, languages: git.languages, overrides: git.overrides, overriddenBy: [], scope: "repository",
          repositories: [{ repositoryId, paths: git.paths }], waivers: [], source: { kind: "git", file: git.file },
          version: git.file.commitSha, status: !git.enabled ? "disabled" : git.lazy ? "lazy" : "active" };
      } else {
        const saved = await this.pool.query<{ snapshot: GitReviewRule }>(`SELECT snapshot FROM reviews review
          CROSS JOIN LATERAL jsonb_array_elements(review.rules) snapshot
          WHERE review.repository_id=$2::uuid AND review.status='completed' AND snapshot->>'id'=$1
            AND snapshot->'file'->>'kind'='repository' AND snapshot->'file'->>'repositoryId'=$2::text
          ORDER BY review.completed_at DESC NULLS LAST,review.created_at DESC,review.id DESC LIMIT 1`, [ruleId, repositoryId]);
        const snapshot = saved.rows[0]?.snapshot;
        if (!snapshot) throw new ManagedRuleError(404, "not_found", "规范不存在");
        rule = { id: snapshot.id, name: snapshot.name ?? snapshot.id, body: snapshot.body,
          goodExample: snapshot.goodExample ?? "", badExample: snapshot.badExample ?? "",
          judgement: snapshot.judgement ?? false, layer: snapshot.layer ?? "team", languages: snapshot.languages ?? [], overrides: snapshot.overrides ?? [],
          overriddenBy: (snapshot.overriddenBy ?? []).map((entry) => ({ id: entry.ruleId, name: entry.ruleId,
            ...(!getManagedRuleId(entry.ruleId) ? { repositoryId } : {}) })),
          scope: "repository", repositories: [{ repositoryId, paths: snapshot.matchedPaths }], waivers: [],
          source: { kind: "git", file: snapshot.file }, version: snapshot.file.commitSha, status: "snapshot" };
      }
    }
    if (rule.status !== "snapshot") {
      const overriding = await this.pool.query<{ id: string; name: string; repository_id: string | null }>(`
      SELECT 'managed:' || id::text AS id,name,NULL::uuid AS repository_id FROM managed_rules
        WHERE overrides ? $1 AND ($2::uuid IS NULL OR scope='global' OR EXISTS(
          SELECT 1 FROM managed_rule_repositories mapping WHERE mapping.rule_id=managed_rules.id AND mapping.repository_id=$2))
      UNION ALL
      SELECT rule_id AS id,payload->>'name' AS name,repository_id FROM rule_catalog
        WHERE payload->>'kind' IS DISTINCT FROM 'lint' AND payload->'overrides' ? $1
          AND ($2::uuid IS NULL OR repository_id=$2)
      ORDER BY id,repository_id`, [ruleId, repositoryId ?? null]);
      rule.overriddenBy = overriding.rows.map((row) => ({ id: row.id, name: row.name,
        ...(row.repository_id ? { repositoryId: row.repository_id } : {}) }));
    }
    const records = (await loadRuleExecutions(this.pool, repositoryId, ruleId)).get(ruleExecutionKey(ruleId, repositoryId)) ?? [];
    return { rule, records, summary: summarizeRuleExecutions(records) };
  }
}

export function registerRuleDetailRoutes(app: FastifyInstance, dependencies: { pool: pg.Pool }): void {
  const service = new RuleDetailService(dependencies.pool);
  app.get<{ Params: { ruleId: string }; Querystring: { repositoryId?: string } }>("/api/rules/:ruleId/detail", {
    schema: { params: { type: "object", required: ["ruleId"], properties: { ruleId: { type: "string", minLength: 1, maxLength: 2048 } } },
      querystring: { type: "object", additionalProperties: false, properties: { repositoryId: { type: "string", format: "uuid" } } } },
  }, async (request, reply) => {
    requireIdentity();
    reply.header("Cache-Control", "no-store");
    try { return await service.get(request.params.ruleId, request.query.repositoryId); }
    catch (error) {
      if (error instanceof ManagedRuleError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    }
  });
}
