import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAdmin, requireIdentity } from "../auth/context.js";
import type { RepositoryService } from "../repositories/service.js";
import { ReviewError } from "../reviews/types.js";
import { languageOptions, ruleLayers, ruleLanguages, type RuleLayer } from "./metadata.js";
import { listRuleWaivers, updateRuleWaiver } from "./managed/waivers.js";
import { checkRuleRelations, lockRuleHierarchy } from "./managed/relations.js";
import { glob } from "./repository.js";
import { syncManagedProposal } from "./proposal-records.js";
import { ManagedRuleError, ruleCategories, ruleSeverities, validateGeneratedRuleDraft, validateRuleOverrides,
  type ManagedRule, type ManagedRuleInput, type RuleDraftGenerator, type RuleCategory, type RuleSeverity, type RuleWaiver } from "./managed-types.js";

interface RuleRow {
  id: string; name: string; body: string; good_example: string; bad_example: string;
  category: RuleCategory; severity: RuleSeverity; scope: "global" | "repositories"; status: "draft" | "active";
  version: number; created_at: Date; updated_at: Date; created_by: string; updated_by: string;
  judgement: boolean; layer: RuleLayer; languages: string[]; overrides: string[];
  library_source: ManagedRule["librarySource"] | null;
  repositories?: ManagedRule["repositories"]; waivers?: RuleWaiver[];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (message = "请检查规范内容和作用范围") => new ManagedRuleError(400, "invalid_input", message);

export function validateManagedRuleInput(value: unknown): ManagedRuleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const input = value as Record<string, unknown>;
  const allowed = ["name", "body", "goodExample", "badExample", "category", "severity", "scope", "repositories", "status", "layer", "languages", "overrides", "judgement"];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw invalid();
  const draft = validateGeneratedRuleDraft(Object.fromEntries(["name", "body", "goodExample", "badExample", "category", "severity", "layer", "languages", "judgement"].map((key) => [key, input[key]])));
  if ((input.scope !== "global" && input.scope !== "repositories") || (input.status !== "draft" && input.status !== "active")
    || !Array.isArray(input.repositories) || input.repositories.length > 100) throw invalid();
  if (input.scope === "global" ? input.repositories.length !== 0 : input.repositories.length === 0) throw invalid("全局规范无需选择仓库；指定仓库规范至少选择一个仓库");
  const seen = new Set<string>();
  const repositories = input.repositories.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["repositoryId", "paths"].includes(key)) || typeof row.repositoryId !== "string" || !uuid.test(row.repositoryId)
      || !Array.isArray(row.paths) || row.paths.length > 64) throw invalid();
    const repositoryId = row.repositoryId.toLowerCase();
    if (seen.has(repositoryId)) throw invalid("同一个仓库只能选择一次");
    seen.add(repositoryId);
    const paths = row.paths.map((entry: unknown) => {
      if (typeof entry !== "string" || !entry.trim() || entry.length > 256 || !glob(entry.trim())) throw invalid("路径需为仓库相对的有效匹配条件");
      return entry.trim();
    });
    if (new Set(paths).size !== paths.length) throw invalid("路径匹配条件不能重复");
    return { repositoryId, paths };
  });
  return { ...draft, overrides: validateRuleOverrides(input.overrides), scope: input.scope, status: input.status, repositories };
}
function publicRule(row: RuleRow): ManagedRule {
  return { id: row.id, name: row.name, body: row.body, goodExample: row.good_example, badExample: row.bad_example,
    judgement: row.judgement, layer: row.layer, languages: row.languages, overrides: row.overrides, waivers: row.waivers ?? [],
    category: row.category, severity: row.severity, scope: row.scope, status: row.status,
    repositories: row.repositories ?? [], version: row.version, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    createdBy: row.created_by, updatedBy: row.updated_by, ...(row.library_source ? { librarySource: row.library_source } : {}) };
}
const repositoriesProjection = `coalesce((SELECT jsonb_agg(jsonb_build_object('repositoryId',mapping.repository_id,'paths',mapping.paths) ORDER BY mapping.repository_id)
  FROM managed_rule_repositories mapping WHERE mapping.rule_id=rule.id),'[]'::jsonb) AS repositories,
  coalesce((SELECT jsonb_agg(jsonb_build_object('id',waiver.id,'repositoryId',waiver.repository_id,'reason',waiver.reason,
    'createdBy',waiver.created_by,'createdAt',waiver.created_at,'revokedBy',waiver.revoked_by,'revokedAt',waiver.revoked_at) ORDER BY waiver.created_at,waiver.id)
    FROM managed_rule_waivers waiver WHERE waiver.rule_id=rule.id AND waiver.revoked_at IS NULL),'[]'::jsonb) AS waivers`;

export class ManagedRuleService {
  constructor(private readonly pool: pg.Pool) {}
  async get(id: string, client?: pg.PoolClient): Promise<ManagedRule> {
    requireIdentity();
    if (!uuid.test(id)) throw invalid("规范标识不正确");
    const result = await (client ?? this.pool).query<RuleRow>(`SELECT rule.*,${repositoriesProjection} FROM managed_rules rule WHERE rule.id=$1`, [id]);
    if (!result.rows[0]) throw new ManagedRuleError(404, "not_found", "规范不存在");
    return publicRule(result.rows[0]);
  }
  async list(repositoryId?: string): Promise<ManagedRule[]> {
    if (repositoryId) {
      if (!uuid.test(repositoryId)) throw invalid("仓库标识不正确");
      if (!(await this.pool.query("SELECT id FROM repositories WHERE id=$1", [repositoryId])).rowCount) throw new ManagedRuleError(404, "not_found", "仓库不存在");
    }
    const result = await this.pool.query<RuleRow>(`SELECT rule.*,${repositoriesProjection} FROM managed_rules rule
      WHERE ($1::uuid IS NULL OR rule.scope='global' OR EXISTS(SELECT 1 FROM managed_rule_repositories mapping WHERE mapping.rule_id=rule.id AND mapping.repository_id=$1))
      ORDER BY rule.updated_at DESC,rule.id`, [repositoryId ?? null]);
    return result.rows.map(publicRule);
  }
  private async checkRepositories(client: pg.PoolClient, input: ManagedRuleInput) {
    if (!input.repositories.length) return;
    const identifiers = input.repositories.map((item) => item.repositoryId);
    const result = await client.query("SELECT id FROM repositories WHERE id=ANY($1::uuid[]) FOR KEY SHARE", [identifiers]);
    if (result.rows.length !== identifiers.length) throw new ManagedRuleError(404, "not_found", "选择的仓库不存在或不属于当前团队");
  }
  private async writeRepositories(client: pg.PoolClient, id: string, input: ManagedRuleInput) {
    await client.query("DELETE FROM managed_rule_repositories WHERE rule_id=$1", [id]);
    for (const item of input.repositories) await client.query("INSERT INTO managed_rule_repositories(rule_id,repository_id,paths) VALUES($1,$2,$3)", [id, item.repositoryId, JSON.stringify(item.paths)]);
  }
  async saveInTransaction(client: pg.PoolClient, value: unknown, existing?: { id: string; version: number }): Promise<ManagedRule> {
    const actor = requireAdmin();
    const input = validateManagedRuleInput(value);
    await lockRuleHierarchy(client, actor.teamId);
    if (existing) {
      if (!uuid.test(existing.id) || !Number.isSafeInteger(existing.version) || existing.version < 1 || existing.version >= 2_147_483_647) throw invalid("规范版本不正确，请重新读取后重试");
      const previous = await client.query<{ version: number }>("SELECT version FROM managed_rules WHERE id=$1 FOR UPDATE", [existing.id]);
      if (!previous.rows[0]) throw new ManagedRuleError(404, "not_found", "规范不存在");
      if (previous.rows[0].version !== existing.version) throw new ManagedRuleError(409, "version_conflict", "规范已被其他人更新，请刷新后重新核对并保存");
      await this.checkRepositories(client, input);
      await checkRuleRelations(client, existing.id, input);
      if (input.scope !== "global") await client.query("UPDATE managed_rule_waivers SET revoked_by=$2,revoked_at=now() WHERE rule_id=$1 AND revoked_at IS NULL", [existing.id, actor.userId]);
      const result = await client.query<RuleRow>(`UPDATE managed_rules SET name=$2,body=$3,good_example=$4,bad_example=$5,category=$6,severity=$7,scope=$8,status=$9,
        version=version+1,updated_at=now(),updated_by=$10,layer=$11,languages=$12,overrides=$13,judgement=$14 WHERE id=$1 RETURNING *`, [existing.id, input.name, input.body, input.goodExample, input.badExample, input.category, input.severity, input.scope, input.status, actor.userId, input.layer, JSON.stringify(input.languages), JSON.stringify(input.overrides), input.judgement]);
      await this.writeRepositories(client, existing.id, input);
      const rule = await this.get(result.rows[0]!.id, client);
      await syncManagedProposal(client, rule);
      return rule;
    }
    await this.checkRepositories(client, input);
    const id = randomUUID();
    await checkRuleRelations(client, id, input);
    const result = await client.query<RuleRow>(`INSERT INTO managed_rules(id,name,body,good_example,bad_example,category,severity,scope,status,created_by,updated_by,layer,languages,overrides,judgement)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14) RETURNING *`, [id, input.name, input.body, input.goodExample, input.badExample, input.category, input.severity, input.scope, input.status, actor.userId, input.layer, JSON.stringify(input.languages), JSON.stringify(input.overrides), input.judgement]);
    await this.writeRepositories(client, result.rows[0]!.id, input);
    const rule = await this.get(result.rows[0]!.id, client);
    await syncManagedProposal(client, rule);
    return rule;
  }
  private async save(value: unknown, existing?: { id: string; version: number }): Promise<ManagedRule> {
    requireAdmin();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const rule = await this.saveInTransaction(client, value, existing);
      await client.query("COMMIT");
      return rule;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  async create(value: unknown): Promise<ManagedRule> { return this.save(value); }
  async update(id: string, value: unknown): Promise<ManagedRule> {
    requireAdmin();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const { version, ...content } = value as Record<string, unknown>;
    if (typeof version !== "number") throw invalid("规范版本不正确，请重新读取后重试");
    return this.save(content, { id, version });
  }
  async deleteInTransaction(client: pg.PoolClient, id: string, version: number): Promise<void> {
    const actor = requireAdmin();
    if (!uuid.test(id) || !Number.isSafeInteger(version) || version < 1 || version > 2_147_483_647) throw invalid("规范标识或版本不正确，请重新读取后重试");
    id = id.toLowerCase();
    await lockRuleHierarchy(client, actor.teamId);
    const ruleId = `managed:${id}`;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:rule-feedback:${actor.teamId}:${ruleId}`]);
    const current = await client.query<{ version: number }>("SELECT version FROM managed_rules WHERE id=$1 FOR UPDATE", [id]);
    if (!current.rows[0]) throw new ManagedRuleError(404, "not_found", "规范不存在");
    if (current.rows[0].version !== version) throw new ManagedRuleError(409, "version_conflict", "规范已更新，请刷新后核对再删除");
    await client.query(`UPDATE managed_rule_sessions SET rule_id=NULL,rule_version=NULL,version=version+1,updated_at=now(),updated_by=$2
      WHERE rule_id=$1`, [id, actor.userId]);
    await client.query(`UPDATE rule_proposals SET managed_rule_id=NULL,status=CASE WHEN status='pending' THEN 'withdrawn' ELSE status END
      WHERE managed_rule_id=$1 OR rule_id=$2`, [id, ruleId]);
    await client.query(`UPDATE managed_rules SET overrides=overrides-$1,version=version+1,updated_at=now(),updated_by=$2
      WHERE overrides ? $1`, [ruleId, actor.userId]);
    await client.query("DELETE FROM managed_rules WHERE id=$1", [id]);
  }
  async delete(id: string, value: unknown): Promise<void> {
    requireAdmin();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("请提供规范标识和版本");
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "version") || typeof input.version !== "number") throw invalid("规范版本不正确，请重新读取后重试");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.deleteInTransaction(client, id, input.version);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}

export function registerManagedRuleRoutes(app: FastifyInstance, dependencies: {
  pool: pg.Pool; repositories?: RepositoryService; generator?: RuleDraftGenerator; service?: ManagedRuleService;
}): ManagedRuleService {
  const service = dependencies.service ?? new ManagedRuleService(dependencies.pool);
  const identifier = { type: "string", format: "uuid" };
  const fields = {
    name: { type: "string", minLength: 1, maxLength: 160 }, body: { type: "string", minLength: 1, maxLength: 12000 },
    goodExample: { type: "string", maxLength: 12000 }, badExample: { type: "string", maxLength: 12000 },
    judgement: { type: "boolean" },
    layer: { type: "string", enum: [...ruleLayers] },
    languages: { type: "array", uniqueItems: true, items: { type: "string", enum: [...ruleLanguages] } },
    overrides: { type: "array", maxItems: 100, uniqueItems: true, items: { type: "string", maxLength: 1024 } },
    category: { type: "string", enum: [...ruleCategories] }, severity: { type: "string", enum: [...ruleSeverities] },
    scope: { type: "string", enum: ["global", "repositories"] }, status: { type: "string", enum: ["draft", "active"] },
    repositories: { type: "array", maxItems: 100, items: { type: "object", additionalProperties: false, required: ["repositoryId", "paths"], properties: {
      repositoryId: identifier, paths: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 256 } },
    } } },
  };
  void app.register(async (routes) => {
    routes.addHook("preValidation", async (request) => {
      if (request.method === "POST" && request.routeOptions.url === "/api/managed-rules") validateManagedRuleInput(request.body);
      if (request.method === "PUT" && request.routeOptions.url === "/api/managed-rules/:id") {
        if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw invalid();
        const { version: _version, ...content } = request.body as Record<string, unknown>;
        validateManagedRuleInput(content);
      }
      if (request.routeOptions.url === "/api/managed-rules/generate" && request.body && typeof request.body === "object"
        && Object.keys(request.body).some((key) => key !== "intent")) throw invalid();
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ManagedRuleError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      if (error instanceof Error && "validation" in error) return reply.code(400).send({ error: { code: "invalid_input", message: "请检查规范字段与作用范围" } });
      throw error;
    });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.get("/api/rule-metadata", async () => { requireIdentity(); return { layers: ruleLayers, languages: languageOptions }; });
    routes.get<{ Querystring: { repositoryId?: string } }>("/api/managed-rules", {
      schema: { querystring: { type: "object", additionalProperties: false, properties: { repositoryId: identifier } } },
    }, async (request) => { requireIdentity(); return { rules: await service.list(request.query.repositoryId) }; });
    routes.post<{ Body: { intent: string } }>("/api/managed-rules/generate", {
      bodyLimit: 20000, schema: { body: { type: "object", additionalProperties: false, required: ["intent"], properties: { intent: { type: "string", minLength: 1, maxLength: 4000 } } } },
    }, async (request, reply) => {
      requireAdmin();
      const intent = request.body.intent.trim();
      if (!intent) throw invalid("请描述希望建立的规范");
      if (!dependencies.generator) throw new ManagedRuleError(503, "model_not_configured", "请先配置用于生成规范的模型");
      try { return { draft: validateGeneratedRuleDraft(await dependencies.generator(intent)) }; }
      catch (error) {
        if (error instanceof ReviewError && error.code === "models_not_configured") {
          return reply.code(503).send({ error: { code: "model_not_configured", message: "请先配置用于生成规范的模型" } });
        }
        return reply.code(502).send({ error: { code: "generation_failed", message: "规范草稿生成失败，请稍后重试。已有规范未受影响。" } });
      }
    });
    routes.get<{ Params: { id: string } }>("/api/managed-rules/:id/waivers", async (request) => ({ waivers: await listRuleWaivers(dependencies.pool, request.params.id) }));
    routes.put<{ Params: { id: string; repositoryId: string }; Body: unknown }>("/api/managed-rules/:id/waivers/:repositoryId", { bodyLimit: 12000 }, async (request) => {
      if (request.body === undefined) throw invalid("请填写豁免理由");
      await updateRuleWaiver(dependencies.pool, request.params.id, request.params.repositoryId, request.body);
      return { rule: await service.get(request.params.id) };
    });
    routes.delete<{ Params: { id: string; repositoryId: string } }>("/api/managed-rules/:id/waivers/:repositoryId", async (request) => {
      await updateRuleWaiver(dependencies.pool, request.params.id, request.params.repositoryId);
      return { rule: await service.get(request.params.id) };
    });
    routes.post<{ Body: ManagedRuleInput }>("/api/managed-rules", {
      bodyLimit: 2_000_000, schema: { body: { type: "object", additionalProperties: false, required: Object.keys(fields).filter((key) => !["layer", "languages", "overrides", "judgement"].includes(key)), properties: fields } },
    }, async (request, reply) => reply.code(201).send({ rule: await service.create(request.body) }));
    routes.put<{ Params: { id: string }; Body: ManagedRuleInput & { version: number } }>("/api/managed-rules/:id", {
      bodyLimit: 2_000_000, schema: { params: { type: "object", required: ["id"], properties: { id: identifier } },
        body: { type: "object", additionalProperties: false, required: [...Object.keys(fields).filter((key) => !["layer", "languages", "overrides", "judgement"].includes(key)), "version"], properties: { ...fields, version: { type: "integer", minimum: 1, maximum: 2_147_483_646 } } } },
    }, async (request) => ({ rule: await service.update(request.params.id, request.body) }));
    routes.delete<{ Params: { id: string }; Body: unknown }>("/api/managed-rules/:id", { bodyLimit: 4096 }, async (request) => {
      await service.delete(request.params.id, request.body);
      return { deleted: true };
    });
  });
  return service;
}
