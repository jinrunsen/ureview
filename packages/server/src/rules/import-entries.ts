import { randomUUID } from "node:crypto";
import type { LibraryEntry } from "./library-types.js";
import { ruleCategories, ruleSeverities } from "./managed-types.js";
export class ImportRejection extends Error {}
export interface ImportSkipped { reference: string; reason: string }
export type ImportEntryDraft = Omit<LibraryEntry, "id" | "source">;
export function validateImportEntries(value: unknown): ImportEntryDraft[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) throw new ImportRejection("每次提交 1 到 10 个条目");
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ImportRejection(`条目 ${index + 1} 字段不完整`);
    const item = entry as ImportEntryDraft;
    for (const field of ["title", "originalName", "summary", "body", "check", "why", "fix", "goodExample", "badExample", "exampleLanguage"] as const) {
      const limit = ["title", "originalName", "exampleLanguage"].includes(field) ? 160 : 12000;
      if (typeof item[field] !== "string" || item[field].length > limit || (!["goodExample", "badExample", "exampleLanguage"].includes(field) && !item[field].trim())) {
        throw new ImportRejection(`条目 ${index + 1} 的 ${field} 须为${limit}字以内的有效文本`);
      }
    }
    if (!ruleCategories.includes(item.category) || !ruleSeverities.includes(item.severity) || typeof item.judgement !== "boolean") throw new ImportRejection(`条目 ${index + 1} 的分类、严重级别或判断题属性无效`);
    const body = [`原文名称：${item.originalName}`, `摘要：${item.summary}`, item.body, `## 检查什么\n\n${item.check}`, `## 为什么\n\n${item.why}`, `## 怎么改\n\n${item.fix}`].join("\n\n");
    if (body.length > 12000) throw new ImportRejection(`条目 ${index + 1} 应用后的完整正文超过 12000 字，请缩短正文与说明`);
    return item;
  });
}
export function validateImportSkipped(value: unknown): ImportSkipped[] {
  if (!Array.isArray(value)) throw new ImportRejection("请提交 skipped 列表");
  return value.map((entry: unknown) => {
    const item = entry as ImportSkipped;
    if (!item || typeof item.reference !== "string" || !item.reference.trim() || item.reference.length > 12000 || typeof item.reason !== "string" || !item.reason.trim() || item.reason.length > 12000) throw new ImportRejection("跳过项须包含原文章节或首句以及理由，分别不超过 12000 字");
    return { reference: item.reference, reason: item.reason };
  });
}
export class ImportChunkCollector {
  private accepted = 0;
  private finished = false;
  private failed = false;
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly source: { sourceId: string; reference: string },
    private readonly saveEntries: (entries: LibraryEntry[]) => Promise<void>,
    private readonly saveSkipped: (skipped: ImportSkipped[]) => Promise<void>) {}
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(async () => {
      if (this.failed) throw new Error("片段保存失败");
      if (this.finished) throw new ImportRejection("片段已完成，不能继续提交");
      try { return await run(); } catch (error) { if (!(error instanceof ImportRejection)) this.failed = true; throw error; }
    });
    this.pending = result.catch(() => {}); return result;
  }
  submit(value: unknown): Promise<string> {
    return this.serialize(async () => {
      const entries = validateImportEntries(value).map((entry) => ({ ...entry, id: `import-entry-${randomUUID()}`, source: { ...this.source, reference: `${this.source.reference} › ${entry.originalName}` } }));
      await this.saveEntries(entries); this.accepted += entries.length; return `已接受 ${entries.length} 个条目，可继续提交或调用 finish_chunk`;
    });
  }
  finish(value: unknown): Promise<string> {
    return this.serialize(async () => {
      const skipped = validateImportSkipped(value);
      if (!this.accepted && !skipped.length) throw new ImportRejection("至少接受一个条目或说明跳过理由后才能完成片段");
      await this.saveSkipped(skipped); this.finished = true; return "片段已完成，请结束会话";
    });
  }
  complete() { if (!this.finished || this.failed) throw new Error("未完成提交"); }
}
