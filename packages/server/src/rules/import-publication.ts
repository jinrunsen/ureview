import { readImportPreview } from "./import-preview.js";
import type pg from "pg";
import { requireServiceAdmin } from "../auth/context.js";
import { ManagedRuleError, validateRuleMetadata } from "./managed-types.js";
import type { LibraryEntry, LibrarySet } from "./library-types.js";
const invalid = (message: string) => new ManagedRuleError(400, "invalid_import", message);
const conflict = (message: string) => new ManagedRuleError(409, "version_conflict", message);
const missing = () => new ManagedRuleError(404, "not_found", "导入规范集或条目不存在");
function inputObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !fields.includes(key))) throw invalid("导入修改参数无效");
  return value as Record<string, unknown>;
}
export class ImportPublicationService {
  constructor(private readonly pool: pg.Pool) {}
  private async change(id: string, value: Record<string, unknown>, change: (client: pg.PoolClient, userId: string) => Promise<void>) {
    const actor = requireServiceAdmin();
    if (!/^[0-9a-f-]{36}$/i.test(id) || !Number.isSafeInteger(value.version) || Number(value.version) < 1) throw invalid("请提供有效的导入版本");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const item = (await client.query<{ version: number; status: string }>("SELECT version,status FROM rule_library_imports WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!item) throw missing();
      if (item.version !== value.version) throw conflict("导入已被更新，请刷新后重试");
      if (!["ready", "partial_failed"].includes(item.status)) throw conflict("请等待导入结束后再修改或发布");
      await change(client, actor.userId);
      await client.query(`UPDATE rule_library_imports SET version=version+1,status=CASE WHEN EXISTS(SELECT id FROM rule_library_import_chunks WHERE import_id=$1 AND status='failed') THEN 'partial_failed' ELSE 'ready' END WHERE id=$1`, [id]);
      const preview = await readImportPreview(client, id);
      await client.query("COMMIT"); return preview;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  private async draft(client: pg.PoolClient, importId: string, setId: string) {
    const set = (await client.query<{ published_at: Date | null }>("SELECT published_at FROM rule_library_import_sets WHERE id=$1 AND import_id=$2", [setId, importId])).rows[0];
    if (!set) throw missing();
    if (set.published_at) throw conflict("已发布的规范集不能修改");
  }
  updateSet(id: string, setId: string, value: unknown) {
    requireServiceAdmin(); const input = inputObject(value, ["version", "name", "layer", "languages"]);
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80 || input.layer === undefined || input.languages === undefined) throw invalid("请填写 1 到 80 字的名称、层级和适用语言");
    const metadata = validateRuleMetadata(input);
    return this.change(id, input, async (client) => { await this.draft(client, id, setId); await client.query("UPDATE rule_library_import_sets SET name=$2,layer=$3,languages=$4 WHERE id=$1", [setId, String(input.name).trim(), metadata.layer, JSON.stringify(metadata.languages)]); });
  }
  deleteSet(id: string, setId: string, value: unknown) {
    requireServiceAdmin(); const input = inputObject(value, ["version"]);
    return this.change(id, input, async (client) => { await this.draft(client, id, setId); await client.query("DELETE FROM rule_library_import_sets WHERE id=$1", [setId]); });
  }
  deleteEntry(id: string, entryId: string, value: unknown) {
    requireServiceAdmin(); const input = inputObject(value, ["version"]);
    return this.change(id, input, async (client) => {
      const entry = (await client.query<{ set_id: string }>("SELECT entry.set_id FROM rule_library_import_entries entry JOIN rule_library_import_sets sets ON sets.id=entry.set_id WHERE entry.id=$1 AND sets.import_id=$2", [entryId, id])).rows[0];
      if (!entry) throw missing(); await this.draft(client, id, entry.set_id); await client.query("DELETE FROM rule_library_import_entries WHERE id=$1", [entryId]);
    });
  }
  publish(id: string, value: unknown) {
    requireServiceAdmin(); const input = inputObject(value, ["version", "setIds"]);
    if (!Array.isArray(input.setIds) || !input.setIds.length || input.setIds.some((id) => typeof id !== "string") || new Set(input.setIds).size !== input.setIds.length) throw invalid("请选择不重复的规范集");
    const ids = input.setIds as string[];
    return this.change(id, input, async (client, userId) => {
      for (const setId of ids) {
        await this.draft(client, id, setId);
        if (!(await client.query("SELECT id FROM rule_library_import_entries WHERE set_id=$1 LIMIT 1", [setId])).rowCount) throw conflict("没有条目的规范集不能发布");
        if ((await client.query("SELECT id FROM rule_library_import_chunks WHERE set_id=$1 AND status NOT IN ('completed','skipped') LIMIT 1", [setId])).rows.length) throw conflict("该规范集还有未完成或失败的片段，请重试后再发布");
      }
      await client.query("UPDATE rule_library_import_sets SET published_at=now(),published_by=$2 WHERE id=ANY($1::text[])", [ids, userId]);
    });
  }
  async deletePublished(setId: string) {
    requireServiceAdmin(); const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const set = (await client.query<{ import_id: string }>("SELECT import_id FROM rule_library_import_sets WHERE id=$1 AND published_at IS NOT NULL", [setId])).rows[0];
      if (!set) throw missing();
      await client.query("SELECT id FROM rule_library_imports WHERE id=$1 FOR UPDATE", [set.import_id]);
      const removed = await client.query("DELETE FROM rule_library_import_sets WHERE id=$1 AND published_at IS NOT NULL RETURNING id", [setId]);
      if (!removed.rowCount) throw missing();
      await client.query("UPDATE rule_library_imports SET version=version+1 WHERE id=$1", [set.import_id]);
      await client.query("COMMIT"); return { id: setId };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
}
export async function loadImportedRuleLibrary(pool: pg.Pool, setId?: string, includeEntries = true): Promise<Array<LibrarySet & { entryCount: number }>> {
  const sets = (await pool.query<{ id: string; name: string; layer: LibrarySet["layer"]; languages: string[]; file_id: string; filename: string; published_at: Date; publisher: string; entry_count: number }>(`SELECT sets.id,sets.name,sets.layer,sets.languages,sets.file_id,sets.published_at,file.name AS filename,actor.name AS publisher,
    (SELECT count(*)::int FROM rule_library_import_entries entry WHERE entry.set_id=sets.id) AS entry_count
    FROM rule_library_import_sets sets JOIN rule_library_import_files file ON file.id=sets.file_id JOIN auth_users actor ON actor.id=sets.published_by WHERE sets.published_at IS NOT NULL AND ($1::text IS NULL OR sets.id=$1) ORDER BY sets.published_at,sets.id`, [setId ?? null])).rows;
  if (!sets.length) return [];
  const entries = includeEntries ? (await pool.query<{ set_id: string; data: LibraryEntry }>("SELECT set_id,data FROM rule_library_import_entries WHERE set_id=ANY($1::text[]) ORDER BY id", [sets.map((set) => set.id)])).rows : [];
  return sets.map((set) => ({ id: set.id, name: set.name, layer: set.layer, languages: set.languages, libraryVersion: set.published_at.toISOString(),
    entryCount: set.entry_count, sourceType: "imported", sourceFilename: set.filename, publishedBy: set.publisher, publishedAt: set.published_at.toISOString(),
    sources: [{ id: set.file_id, title: set.filename, author: "企业规范提供方", url: "", license: "企业内部规范" }],
    inclusionReasons: [{ kind: "enterprise", explanation: "服务管理员上传并发布的企业编码规范。" }],
    license: { tier: "enterprise", attribution: set.filename, notice: "企业内部规范，供本实例团队使用。" },
    entries: entries.filter((entry) => entry.set_id === set.id).map((entry) => entry.data),
  }));
}
