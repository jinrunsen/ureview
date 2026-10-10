import { describe, expect, it } from "vitest";
import { ImportChunkCollector, validateImportEntries } from "./import-entries.js";
import { importDraft } from "./import/test-support.js";
import type { LibraryEntry } from "./library-types.js";
describe("导入条目校验和提交协议", () => {
  it.each([
    { title: undefined }, { body: "规".repeat(12001) }, { title: "规".repeat(161) },
    { goodExample: "规".repeat(12001) }, { category: "invalid" }, { severity: "high" },
    { body: "规".repeat(11999) },
  ])("拒绝字段缺失、超长及非法取值：%j", (change) => { expect(() => validateImportEntries([{ ...importDraft("go"), ...change }])).toThrow(); });
  it("拒绝空批次及超过十条的批次", () => {
    expect(() => validateImportEntries([])).toThrow(); expect(() => validateImportEntries(Array.from({ length: 11 }, () => importDraft("go")))).toThrow();
  });
  it("多次提交各自持久化，被拒绝后仍能纠正并完成", async () => {
    const saved: LibraryEntry[] = [];
    const collector = new ImportChunkCollector({ sourceId: "file-go", reference: "安全.md › Go" }, async (entries) => { saved.push(...entries); }, async () => {});
    await expect(collector.finish([])).rejects.toThrow("至少接受");
    await expect(collector.submit([{ ...importDraft("go"), title: "" }])).rejects.toThrow();
    await collector.submit([importDraft("go")]); await collector.submit([importDraft("go", 2)]); await collector.finish([]);
    expect(() => collector.complete()).not.toThrow(); expect(saved).toHaveLength(2);
    expect(new Set(saved.map((entry) => entry.id)).size).toBe(2); expect(saved[0]!.source.reference).toContain("安全.md › Go");
    await expect(collector.submit([importDraft("go")])).rejects.toThrow("已完成");
  });
  it("持久化失败不能通过后续完成提交掩盖", async () => {
    const collector = new ImportChunkCollector({ sourceId: "file-go", reference: "安全.md › Go" }, async () => { throw new Error("存储失败"); }, async () => {});
    await expect(collector.submit([importDraft("go")])).rejects.toThrow();
    await expect(collector.finish([{ reference: "综述", reason: "说明范围" }])).rejects.toThrow();
    expect(() => collector.complete()).toThrow();
  });
  it("没有条目时可以用跳过理由完成片段", async () => {
    const collector = new ImportChunkCollector({ sourceId: "file-guide", reference: "说明.txt" }, async () => {}, async () => {});
    await collector.finish([{ reference: "适用范围", reason: "综述说明" }]); expect(() => collector.complete()).not.toThrow();
  });
});
