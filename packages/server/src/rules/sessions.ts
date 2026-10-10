import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAdmin, requireIdentity } from "../auth/context.js";
import { ReviewError } from "../reviews/types.js";
import { ManagedRuleService, validateManagedRuleInput } from "./managed.js";
import { lockRuleHierarchy } from "./managed/relations.js";
import { ManagedRuleError, validateGeneratedRuleDraft, type GeneratedRuleDraft, type ManagedRule, type ManagedRuleInput } from "./managed-types.js";
import type { RuleConversationGenerator, RuleSession, RuleSessionTurn } from "./sessions-types.js";
import { invalidSession, sessionIdentifier, sessionRecord, sessionVersion, workingCopy } from "./sessions-validation.js";

interface SessionRow {
  id: string; title: string; version: number; rule_id: string | null; rule_version: number | null;
  working_copy: ManagedRuleInput | null; turns: RuleSessionTurn[]; checkpoint: unknown;
  generation_id: string | null; generation_started_at: Date | null; created_at: Date; updated_at: Date;
}
const titleOf = (copy: ManagedRuleInput | null, turns: RuleSessionTurn[]) => (copy?.name.trim() || turns[0]?.message.trim() || "新规范会话").slice(0, 160);
const publicSession = (row: SessionRow): RuleSession => ({
  id: row.id, title: row.title, version: row.version, ruleId: row.rule_id, ruleVersion: row.rule_version,
  workingCopy: row.working_copy ? { ...row.working_copy, judgement: row.working_copy.judgement ?? false } : null,
  turns: row.turns.map((turn) => turn.draft ? { ...turn, draft: { ...turn.draft, judgement: turn.draft.judgement ?? false } } : turn), status: row.generation_id ? "running" : "idle",
  createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
});
const draftOf = (copy: ManagedRuleInput): GeneratedRuleDraft => ({ name: copy.name, body: copy.body, goodExample: copy.goodExample,
  badExample: copy.badExample, category: copy.category, severity: copy.severity, judgement: copy.judgement ?? false, layer: copy.layer, languages: copy.languages });
const inputOf = (rule: ManagedRule): ManagedRuleInput => ({ ...draftOf(rule), overrides: rule.overrides, scope: rule.scope, repositories: rule.repositories, status: rule.status });
const generationFailureMessages = new Map([
  ["rule_model_unavailable", "模型连接中断或服务暂时不可用，请稍后重试。当前工作稿已保留。"],
  ["rule_generation_timeout", "规范生成超时，请稍后重试。当前工作稿已保留。"],
  ["invalid_rule_draft", "模型未返回有效的规范草稿，请重新发送要求。当前工作稿已保留。"],
  ["models_not_configured", "请先配置用于生成规范的模型。当前工作稿已保留。"],
]);

export class RuleSessionService {
  private readonly managed: ManagedRuleService;
  constructor(private readonly pool: pg.Pool, private readonly generator?: RuleConversationGenerator) { this.managed = new ManagedRuleService(pool); }

  private async transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async recover(id?: string): Promise<void> {
    await this.pool.query(`UPDATE managed_rule_sessions session SET
      turns=(SELECT jsonb_agg(CASE WHEN item.turn->>'id'=session.generation_id::text
        THEN item.turn || jsonb_build_object('status','failed','error','生成等待已超时，请重新发送要求。当前工作稿已保留。') ELSE item.turn END ORDER BY item.position)
        FROM jsonb_array_elements(session.turns) WITH ORDINALITY item(turn,position)),
      generation_id=NULL,generation_started_at=NULL,version=version+1,updated_at=now()
      WHERE generation_started_at < now()-interval '90 seconds' AND ($1::uuid IS NULL OR id=$1)`, [id ?? null]);
  }
  private async locked(client: pg.PoolClient, id: string, version: number): Promise<SessionRow> {
    const result = await client.query<SessionRow>("SELECT * FROM managed_rule_sessions WHERE id=$1 FOR UPDATE", [id]);
    const row = result.rows[0];
    if (!row) throw new ManagedRuleError(404, "not_found", "规范会话不存在");
    if (row.generation_id) throw new ManagedRuleError(409, "session_busy", "规范正在生成，请等待本轮完成");
    if (row.version !== version) throw new ManagedRuleError(409, "session_version_conflict", "会话已更新，请载入最新内容核对后继续");
    return row;
  }
  private async checkRepositories(client: pg.PoolClient, copy: ManagedRuleInput | null): Promise<void> {
    if (!copy?.repositories.length) return;
    const ids = copy.repositories.map((entry) => entry.repositoryId);
    if ((await client.query("SELECT id FROM repositories WHERE id=ANY($1::uuid[]) FOR KEY SHARE", [ids])).rowCount !== ids.length) {
      throw new ManagedRuleError(404, "not_found", "选择的仓库不存在或不属于当前团队");
    }
  }

  async create(value: unknown): Promise<RuleSession> {
    const actor = requireAdmin();
    const input = sessionRecord(value, ["ruleId"]);
    const ruleId = input.ruleId === undefined ? undefined : sessionIdentifier(input.ruleId);
    return this.transaction(async (client) => {
      if (ruleId) await lockRuleHierarchy(client, actor.teamId);
      const rule = ruleId ? await this.managed.get(ruleId, client) : undefined;
      const copy = rule ? inputOf(rule) : null;
      const result = await client.query<SessionRow>(`INSERT INTO managed_rule_sessions(id,title,rule_id,rule_version,working_copy,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`, [randomUUID(), titleOf(copy, []), rule?.id ?? null, rule?.version ?? null, copy ? JSON.stringify(copy) : null, actor.userId]);
      return publicSession(result.rows[0]!);
    });
  }
  async list(ruleId?: string): Promise<RuleSession[]> {
    requireIdentity();
    if (ruleId) await this.managed.get(sessionIdentifier(ruleId));
    await this.recover();
    const result = await this.pool.query<SessionRow>("SELECT * FROM managed_rule_sessions WHERE ($1::uuid IS NULL OR rule_id=$1) ORDER BY updated_at DESC,id", [ruleId ?? null]);
    return result.rows.map(publicSession);
  }
  async get(id: string): Promise<RuleSession> {
    requireIdentity(); id = sessionIdentifier(id);
    await this.recover(id);
    const result = await this.pool.query<SessionRow>("SELECT * FROM managed_rule_sessions WHERE id=$1", [id]);
    if (!result.rows[0]) throw new ManagedRuleError(404, "not_found", "规范会话不存在");
    return publicSession(result.rows[0]);
  }
  async update(id: string, value: unknown): Promise<RuleSession> {
    const actor = requireAdmin(); id = sessionIdentifier(id);
    const input = sessionRecord(value, ["version", "workingCopy"]);
    const version = sessionVersion(input.version), copy = workingCopy(input.workingCopy);
    await this.recover(id);
    return this.transaction(async (client) => {
      const row = await this.locked(client, id, version);
      await this.checkRepositories(client, copy);
      const result = await client.query<SessionRow>(`UPDATE managed_rule_sessions SET working_copy=$2,title=$3,version=version+1,updated_by=$4,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, copy ? JSON.stringify(copy) : null, titleOf(copy, row.turns), actor.userId]);
      return publicSession(result.rows[0]!);
    });
  }
  async turn(id: string, value: unknown): Promise<RuleSession> {
    const actor = requireAdmin(); id = sessionIdentifier(id);
    const input = sessionRecord(value, ["version", "message", "workingCopy"]);
    const version = sessionVersion(input.version);
    if (typeof input.message !== "string" || !input.message.trim() || input.message.trim().length > 4000) throw invalidSession("请用 1–4000 个字符描述调整要求");
    const message = input.message.trim();
    const providedCopy = input.workingCopy === undefined ? undefined : workingCopy(input.workingCopy);
    await this.recover(id);
    const generationId = randomUUID();
    const started = await this.transaction(async (client) => {
      const row = await this.locked(client, id, version);
      const copy = providedCopy === undefined ? row.working_copy : providedCopy;
      await this.checkRepositories(client, copy);
      const turns: RuleSessionTurn[] = [...row.turns, { id: generationId, message, status: "running", createdAt: new Date().toISOString() }];
      const result = await client.query<SessionRow>(`UPDATE managed_rule_sessions SET working_copy=$2,turns=$3,title=$4,
        generation_id=$5,generation_started_at=now(),version=version+1,updated_by=$6,updated_at=now() WHERE id=$1 RETURNING *`,
        [id, copy ? JSON.stringify(copy) : null, JSON.stringify(turns), titleOf(copy, turns), generationId, actor.userId]);
      return result.rows[0]!;
    });
    let completed: { draft: GeneratedRuleDraft; reply: string; checkpoint: string } | undefined;
    let failure = "本轮规范生成失败，请重新发送要求。当前工作稿已保留。";
    let failureCode = "rule_generation_failed";
    try {
      if (!this.generator) throw new ReviewError("models_not_configured", "未配置模型");
      const generated = await this.generator.continue({ sessionId: `ureview-rule-${id}`, ruleSessionId: id, message,
        ...(started.working_copy ? { draft: draftOf(started.working_copy) } : {}), ...(started.checkpoint !== null ? { checkpoint: started.checkpoint } : {}) });
      const draft = validateGeneratedRuleDraft(generated.draft);
      if (typeof generated.reply !== "string" || !generated.reply.trim() || generated.reply.length > 12000) throw new Error("生成回复无效");
      const checkpoint = JSON.stringify(generated.checkpoint);
      if (checkpoint === undefined) throw new Error("会话快照无效");
      completed = { draft, reply: generated.reply.trim(), checkpoint };
    } catch (cause) {
      if (cause instanceof ReviewError) { failure = generationFailureMessages.get(cause.code) ?? failure; failureCode = cause.code; }
    }
    await this.recover(id);
    const turns: RuleSessionTurn[] = started.turns.map((turn) => turn.id === generationId ? { ...turn,
      ...(completed ? { status: "completed" as const, draft: completed.draft, reply: completed.reply } : { status: "failed" as const, error: failure, errorCode: failureCode }) } : turn);
    const copy = completed ? { ...started.working_copy, ...completed.draft, scope: started.working_copy?.scope ?? "global",
      overrides: started.working_copy?.overrides ?? [], repositories: started.working_copy?.repositories ?? [], status: started.working_copy?.status ?? "draft" } : started.working_copy;
    await this.pool.query(`UPDATE managed_rule_sessions SET working_copy=$3,turns=$4,title=$5,
      checkpoint=CASE WHEN $6::boolean THEN $7::jsonb ELSE checkpoint END,
      generation_id=NULL,generation_started_at=NULL,version=version+1,updated_at=now()
      WHERE id=$1 AND generation_id=$2`, [id, generationId, copy ? JSON.stringify(copy) : null, JSON.stringify(turns), titleOf(copy, turns), Boolean(completed), completed?.checkpoint ?? null]);
    return this.get(id);
  }
  async saveRule(id: string, value: unknown): Promise<{ session: RuleSession; rule: ManagedRule }> {
    const actor = requireAdmin(); id = sessionIdentifier(id);
    const input = sessionRecord(value, ["version", "workingCopy", "ruleVersion"]);
    const version = sessionVersion(input.version), copy = validateManagedRuleInput(input.workingCopy);
    const ruleVersion = input.ruleVersion === undefined ? undefined : sessionVersion(input.ruleVersion);
    await this.recover(id);
    return this.transaction(async (client) => {
      await lockRuleHierarchy(client, actor.teamId);
      const row = await this.locked(client, id, version);
      if (!row.rule_id && ruleVersion !== undefined) throw invalidSession("会话尚未关联规范");
      const rule = await this.managed.saveInTransaction(client, copy, row.rule_id ? { id: row.rule_id, version: ruleVersion ?? row.rule_version! } : undefined);
      const result = await client.query<SessionRow>(`UPDATE managed_rule_sessions SET rule_id=$2,rule_version=$3,working_copy=$4,title=$5,
        version=version+1,updated_by=$6,updated_at=now() WHERE id=$1 RETURNING *`, [id, rule.id, rule.version, JSON.stringify(copy), titleOf(copy, row.turns), actor.userId]);
      return { session: publicSession(result.rows[0]!), rule };
    });
  }
}

export function registerRuleSessionRoutes(app: FastifyInstance, dependencies: {
  pool: pg.Pool; generator?: RuleConversationGenerator; service?: RuleSessionService;
}): RuleSessionService {
  const service = dependencies.service ?? new RuleSessionService(dependencies.pool, dependencies.generator);
  void app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ManagedRuleError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.post<{ Body: unknown }>("/api/rule-sessions", { bodyLimit: 4096 }, async (request, reply) => reply.code(201).send({ session: await service.create(request.body) }));
    routes.get<{ Querystring: { ruleId?: string } }>("/api/rule-sessions", async (request) => ({ sessions: await service.list(request.query.ruleId) }));
    routes.get<{ Params: { id: string } }>("/api/rule-sessions/:id", async (request) => ({ session: await service.get(request.params.id) }));
    routes.put<{ Params: { id: string }; Body: unknown }>("/api/rule-sessions/:id", { bodyLimit: 2_000_000 }, async (request) => ({ session: await service.update(request.params.id, request.body) }));
    routes.post<{ Params: { id: string }; Body: unknown }>("/api/rule-sessions/:id/turns", { bodyLimit: 2_000_000 }, async (request) => ({ session: await service.turn(request.params.id, request.body) }));
    routes.post<{ Params: { id: string }; Body: unknown }>("/api/rule-sessions/:id/save-rule", { bodyLimit: 2_000_000 }, async (request) => service.saveRule(request.params.id, request.body));
  });
  return service;
}
