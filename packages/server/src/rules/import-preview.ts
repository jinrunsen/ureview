import type pg from "pg";
import type { ImportPlan } from "./import-plan.js";
import { ManagedRuleError } from "./managed-types.js";

export async function readImportPreview(database: pg.Pool | pg.PoolClient, id: string) {
  const item = (await database.query("SELECT * FROM rule_library_imports WHERE id=$1", [id])).rows[0];
  if (!item) throw new ManagedRuleError(404, "not_found", "导入不存在");
  const files = (await database.query("SELECT id,name,size,sha256,plan FROM rule_library_import_files WHERE import_id=$1 ORDER BY name,id", [id])).rows;
  const sections = (await database.query<{ id: string; path: string }>("SELECT id,data->>'path' AS path FROM rule_library_import_sections WHERE file_id=ANY($1::uuid[]) AND id=ANY($2::text[])", [files.map((file) => file.id), files.flatMap((file) => (file.plan as ImportPlan | null)?.skipped.map((skip) => skip.sectionId) ?? [])])).rows;
  for (const file of files) if (file.plan) file.plan.skipped = (file.plan as ImportPlan).skipped.map((skip) => ({ ...skip, reference: sections.find((section) => section.id === skip.sectionId)?.path ?? file.name }));
  const sets = (await database.query(`SELECT sets.*,count(entry.id)::int AS entry_count FROM rule_library_import_sets sets
    LEFT JOIN rule_library_import_chunks chunk ON chunk.set_id=sets.id AND chunk.status='completed'
    LEFT JOIN rule_library_import_entries entry ON entry.chunk_id=chunk.id AND entry.set_id=sets.id
    WHERE sets.import_id=$1 GROUP BY sets.id ORDER BY sets.name,sets.id`, [id])).rows;
  const chunks = (await database.query("SELECT id,file_id,set_id,path,status,skipped,error FROM rule_library_import_chunks WHERE import_id=$1 ORDER BY path,id", [id])).rows;
  return { ...item, all_published: sets.length > 0 && sets.every((set) => set.published_at), files, sets, chunks, progress: { ended: chunks.filter((chunk) => ["completed", "failed", "skipped"].includes(chunk.status)).length, total: chunks.length } };
}
