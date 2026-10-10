import { importAssignmentBoundaries } from "./import-plan.js";
import { readImportPreview } from "./import-preview.js";
import { ImportPublicationService } from "./import-publication.js";
import type { LibraryEntry } from "./library-types.js";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { requireServiceAdmin } from "../auth/context.js";
import { ManagedRuleError } from "./managed-types.js";
import { sliceImportFile } from "./import-slicing.js";
import { ImportFailure, type ImportGenerator } from "../runtime/import-generator.js";
import type { ImportPlan } from "./import-plan.js";
const invalid = (message: string) => new ManagedRuleError(400, "invalid_import", message);
export function validateImportFiles(value: unknown) {
  const files = (value as { files?: unknown })?.files;
  if (!Array.isArray(files) || !files.length || files.length > 10) throw invalid("一次请选择 1 到 10 个文件");
  let total = 0;
  return files.map((file: unknown) => {
    const item = file as { name?: unknown; content?: unknown };
    if (!item || typeof item.name !== "string" || !item.name.trim() || item.name.length > 255) throw invalid("文件名无效");
    const name = item.name;
    if (!/\.(md|markdown|txt)$/i.test(name)) throw invalid(`${name}：文件格式不受支持`);
    if (typeof item.content !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.content)) throw invalid(`${name}：文件编码无效`);
    const bytes = Buffer.from(item.content, "base64");
    if (bytes.length > 1024 * 1024) throw invalid(`${name}：文件超过 1 MB 大小限制`);
    total += bytes.length;
    if (total > 5 * 1024 * 1024) throw invalid(`${name}：文件合计超过 5 MB 大小限制`);
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw invalid(`${name}：文件必须使用 UTF-8 编码`); }
    if (content.includes("\0")) throw invalid(`${name}：文件包含无效文本字符`);
    return { id: randomUUID(), name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), content };
  });
}
export class RuleImportService {
  constructor(readonly pool: pg.Pool, private readonly generator?: ImportGenerator) {}
  async upload(value: unknown) {
    const actor = requireServiceAdmin(), files = validateImportFiles(value), id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO rule_library_imports(id,uploaded_by,status) VALUES($1,$2,'queued')", [id, actor.userId]);
      for (const file of files) {
        await client.query("INSERT INTO rule_library_import_files(id,import_id,name,size,sha256,content) VALUES($1,$2,$3,$4,$5,$6)", [file.id, id, file.name, file.size, file.sha256, file.content]);
        for (const section of sliceImportFile(file.name, file.content, file.id).sections) await client.query("INSERT INTO rule_library_import_sections(file_id,id,data) VALUES($1,$2,$3)", [file.id, section.id, JSON.stringify(section)]);
      }
      await client.query("COMMIT"); return { id };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async list() { requireServiceAdmin(); return (await this.pool.query("SELECT imports.*,EXISTS(SELECT 1 FROM rule_library_import_sets WHERE import_id=imports.id) AND NOT EXISTS(SELECT 1 FROM rule_library_import_sets WHERE import_id=imports.id AND published_at IS NULL) AS all_published,ARRAY(SELECT name FROM rule_library_import_files WHERE import_id=imports.id ORDER BY name,id) AS filenames FROM rule_library_imports imports ORDER BY created_at DESC,id")).rows; }
  async detail(id: string) {
    requireServiceAdmin();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw invalid("导入标识无效");
    return readImportPreview(this.pool, id);
  }
  async entries(id: string, setId: string) {
    requireServiceAdmin();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw invalid("导入标识无效");
    const set = await this.pool.query("SELECT id FROM rule_library_import_sets WHERE import_id=$1 AND id=$2", [id, setId]);
    if (!set.rowCount) throw new ManagedRuleError(404, "not_found", "导入规范集不存在");
    return { entries: (await this.pool.query<{ data: LibraryEntry }>(`SELECT entry.data FROM rule_library_import_entries entry
      JOIN rule_library_import_chunks chunk ON chunk.id=entry.chunk_id
      WHERE entry.set_id=$1 AND chunk.status='completed' ORDER BY entry.id`, [setId])).rows.map((entry) => entry.data) };
  }

  async retry(id: string, value: unknown) {
    requireServiceAdmin(); await this.detail(id);
    const input = value as { chunkId?: unknown };
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => key !== "chunkId") || input.chunkId !== undefined && (typeof input.chunkId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.chunkId))) throw invalid("请选择有效的失败片段");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const item = (await client.query("SELECT status FROM rule_library_imports WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!["failed", "partial_failed"].includes(item.status)) throw new ManagedRuleError(409, "import_busy", "当前导入没有可重试的失败工作");
      const unplanned = (await client.query("SELECT id FROM rule_library_import_files WHERE import_id=$1 AND plan IS NULL", [id])).rows.length > 0;
      if (unplanned) {
        if (input.chunkId) throw invalid("规划失败，请重试整个导入");
        await client.query("DELETE FROM rule_library_import_chunks WHERE import_id=$1", [id]);
        await client.query("DELETE FROM rule_library_import_sets WHERE import_id=$1", [id]);
        await client.query("UPDATE rule_library_import_files SET plan=NULL WHERE import_id=$1", [id]);
      } else {
        const chunks = (await client.query<{ id: string }>("SELECT id FROM rule_library_import_chunks WHERE import_id=$1 AND status='failed' AND ($2::uuid IS NULL OR id=$2)", [id, input.chunkId ?? null])).rows.map((chunk) => chunk.id);
        if (input.chunkId && !chunks.length) throw invalid("所选片段没有失败或不属于本次导入");
        await client.query("DELETE FROM rule_library_import_entries WHERE chunk_id=ANY($1::uuid[])", [chunks]);
        await client.query("UPDATE rule_library_import_chunks SET status='pending',error=NULL,skipped='[]' WHERE id=ANY($1::uuid[])", [chunks]);
      }
      await client.query("UPDATE rule_library_imports SET status='queued',error=NULL,version=version+1 WHERE id=$1", [id]);
      await client.query("COMMIT"); return { id };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  async recover() {
    const client = await this.pool.connect(); let locked = false;
    try {
      locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(253500) AS locked")).rows[0]!.locked;
      if (!locked) return;
      await client.query("BEGIN");
      await client.query("UPDATE rule_library_import_chunks SET status='failed',error='服务重启，生成中断' WHERE status IN ('running','pending') AND import_id IN (SELECT id FROM rule_library_imports WHERE status IN ('planning','generating'))");
      await client.query("UPDATE rule_library_imports AS item SET status=CASE WHEN EXISTS(SELECT id FROM rule_library_import_files WHERE import_id=item.id AND plan IS NULL) THEN 'failed' ELSE 'partial_failed' END,error='服务重启，生成中断',version=version+1 WHERE status IN ('planning','generating')");
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { try { if (locked) await client.query("SELECT pg_advisory_unlock(253500)"); } finally { client.release(); } }
  }
  async dispatch() {
    const client = await this.pool.connect();
    let locked = false;
    try {
      locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(253500) AS locked")).rows[0]!.locked;
      if (!locked) return;
      await client.query("BEGIN");
      const row = (await client.query<{ id: string }>("SELECT id FROM rule_library_imports WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (row) await client.query("UPDATE rule_library_imports SET status='planning',error=NULL WHERE id=$1", [row.id]);
      await client.query("COMMIT");
      if (!row) return;
      let stage: "planning" | "generating" = "planning";
      try {
        if (!this.generator) throw new ImportFailure("请先配置 Generator 模型");
        const files = (await client.query<{ id: string; name: string; content: string; plan: ImportPlan | null }>("SELECT id,name,content,plan FROM rule_library_import_files WHERE import_id=$1 ORDER BY name,id", [row.id])).rows;
        for (const file of files) {
          if (file.plan) continue;
          const plan = await this.generator.plan(file.name, file.content, file.id);
          await this.savePlan(client, row.id, file, plan);
        }
        stage = "generating";
        await client.query("UPDATE rule_library_imports SET status='generating',version=version+1 WHERE id=$1", [row.id]);
        await this.generateChunks(row.id);
      } catch (error) {
        await client.query("UPDATE rule_library_imports SET status='failed',error=$2,version=version+1 WHERE id=$1", [row.id, error instanceof ImportFailure ? error.message : stage === "planning" ? "规划失败" : "生成失败"]);
      }
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { try { if (locked) await client.query("SELECT pg_advisory_unlock(253500)"); } finally { client.release(); } }
  }
  private async generateChunks(importId: string) {
    const chunks = (await this.pool.query<{ id: string; set_id: string; file_id: string; path: string; content: string; name: string }>(`SELECT chunk.*,file.name FROM rule_library_import_chunks chunk
      JOIN rule_library_import_files file ON file.id=chunk.file_id WHERE chunk.import_id=$1 AND chunk.status='pending' ORDER BY chunk.path,chunk.id`, [importId])).rows;
    const run = async () => {
      for (let chunk = chunks.shift(); chunk; chunk = chunks.shift()) {
        const current = chunk;
        await this.pool.query("UPDATE rule_library_import_chunks SET status='running' WHERE id=$1", [current.id]);
        try {
          await this.generator!.generate({ filename: current.name, path: current.path, text: current.content, fileId: current.file_id }, {
            entries: async (entries) => {
              const client = await this.pool.connect();
              try {
                await client.query("BEGIN");
                for (const entry of entries) await client.query("INSERT INTO rule_library_import_entries(id,set_id,chunk_id,data) VALUES($1,$2,$3,$4)", [entry.id, current.set_id, current.id, JSON.stringify(entry)]);
                await client.query("COMMIT");
              } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
            },
            skipped: async (skipped) => { await this.pool.query("UPDATE rule_library_import_chunks SET skipped=$2 WHERE id=$1", [current.id, JSON.stringify(skipped)]); },
          });
          await this.pool.query("UPDATE rule_library_import_chunks SET status='completed',error=NULL WHERE id=$1", [current.id]);
        } catch (error) {
          await this.pool.query("UPDATE rule_library_import_chunks SET status='failed',error=$2 WHERE id=$1", [current.id, error instanceof ImportFailure ? error.message : "未完成提交"]);
        }
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, chunks.length) }, run));
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    await this.pool.query(`UPDATE rule_library_imports SET status=CASE WHEN EXISTS(SELECT id FROM rule_library_import_chunks WHERE import_id=$1 AND status='failed') THEN 'partial_failed' ELSE 'ready' END,
      error=NULL,version=version+1 WHERE id=$1`, [importId]);
  }
  private async savePlan(client: pg.PoolClient, importId: string, file: { id: string; name: string; content: string }, plan: ImportPlan) {
    const assignments = new Map<string, { setId: string | null; reason?: string }>();
    await client.query("BEGIN");
    try {
      for (const set of plan.sets) {
        const id = `import-set-${randomUUID()}`;
        await client.query("INSERT INTO rule_library_import_sets(id,import_id,file_id,name,layer,languages) VALUES($1,$2,$3,$4,$5,$6)", [id, importId, file.id, set.name, set.layer, JSON.stringify(set.languages)]);
        set.sectionIds.forEach((sectionId) => assignments.set(sectionId, { setId: id }));
      }
      plan.skipped.forEach((item) => assignments.set(item.sectionId, { setId: null, reason: item.reason }));
      const sliced = sliceImportFile(file.name, file.content, file.id, importAssignmentBoundaries(sliceImportFile(file.name, file.content, file.id), assignments));
      for (const chunk of sliced.chunks) {
        let section = sliced.sections.find((item) => item.id === chunk.sectionId)!;
        while (!assignments.has(section.id) && section.parentId) section = sliced.sections.find((item) => item.id === section.parentId)!;
        const assignment = assignments.get(section.id)!;
        await client.query("INSERT INTO rule_library_import_chunks(id,import_id,file_id,set_id,section_id,path,content,status,skipped) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [randomUUID(), importId, file.id, assignment.setId, chunk.sectionId, chunk.path, chunk.text, assignment.setId ? "pending" : "skipped", JSON.stringify(assignment.reason ? [{ reference: chunk.path, reason: assignment.reason }] : [])]);
      }
      await client.query("UPDATE rule_library_import_files SET plan=$2 WHERE id=$1", [file.id, JSON.stringify(plan)]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  }
}
export function registerRuleImportRoutes(app: FastifyInstance, service: RuleImportService, startWorker = false) {
  void app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => { if (error instanceof ManagedRuleError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } }); throw error; });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    const publication = new ImportPublicationService(service.pool);
    routes.put<{ Params: { id: string; setId: string } }>("/api/rule-library-imports/:id/sets/:setId", async (request) => publication.updateSet(request.params.id, request.params.setId, request.body));
    routes.delete<{ Params: { id: string; setId: string } }>("/api/rule-library-imports/:id/sets/:setId", async (request) => publication.deleteSet(request.params.id, request.params.setId, request.body));
    routes.delete<{ Params: { id: string; entryId: string } }>("/api/rule-library-imports/:id/entries/:entryId", async (request) => publication.deleteEntry(request.params.id, request.params.entryId, request.body));
    routes.post<{ Params: { id: string } }>("/api/rule-library-imports/:id/publish", async (request) => publication.publish(request.params.id, request.body));
    routes.delete<{ Params: { setId: string } }>("/api/rule-library/:setId", async (request) => publication.deletePublished(request.params.setId));
    routes.post("/api/rule-library-imports", { bodyLimit: 8 * 1024 * 1024 }, async (request, reply) => reply.code(201).send(await service.upload(request.body)));
    routes.get("/api/rule-library-imports", async () => ({ imports: await service.list() }));
    routes.post<{ Params: { id: string } }>("/api/rule-library-imports/:id/retry", async (request) => service.retry(request.params.id, request.body));
    routes.get<{ Params: { id: string; setId: string } }>("/api/rule-library-imports/:id/sets/:setId/entries", async (request) => service.entries(request.params.id, request.params.setId));
    routes.get<{ Params: { id: string } }>("/api/rule-library-imports/:id", async (request) => service.detail(request.params.id));
  });
  if (!startWorker) return;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, running: Promise<void> = Promise.resolve();
  const tick = () => { running = service.dispatch().catch(() => { app.log.error("企业规范导入调度失败"); }).finally(() => { if (!stopped) timer = setTimeout(tick, 250); }); };
  app.addHook("onReady", async () => { await service.recover(); tick(); });
  app.addHook("onClose", async () => { stopped = true; clearTimeout(timer); await running; });
}
