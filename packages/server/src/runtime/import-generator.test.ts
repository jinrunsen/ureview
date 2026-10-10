import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "tsx/esm/api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootReviewHost } from "./host.js";
import { startMockModelServer } from "./test-support.js";
import { importDraft } from "../rules/import/test-support.js";
import type { LibraryEntry } from "../rules/library-types.js";
import type { ImportGenerator } from "./import-generator.js";
let directory: string, generator: ImportGenerator;
let host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
let model: Awaited<ReturnType<typeof startMockModelServer>> | undefined;
beforeAll(() => { register(); });
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "ureview-import-model-")); });
afterEach(async () => { vi.restoreAllMocks(); try { await host?.dispose(); } finally { host = undefined; try { await model?.dispose(); } finally { model = undefined; await rm(directory, { recursive: true, force: true }); } } });
const plan = { sets: [{ name: "安全编码", layer: "general", languages: [], sectionIds: ["section-0"] }], skipped: [] };
describe("导入规划的正式 dsh 会话", () => {
  it("仅发送大纲，通过工具错误纠正分配并释放会话", async () => {
    model = await startMockModelServer({ generatorScript: [
      { name: "submit_plan", input: { sets: [], skipped: [] }, result: { isError: true, includes: "归属" } },
      { name: "submit_plan", input: plan, result: { isError: false } },
    ] });
    host = await bootReviewHost({ homeDir: directory, models: model.models, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    expect(await generator.plan("安全规范.md", "# 安全编码\n必须拒绝负数交易金额。", "section")).toEqual(plan);
    expect(model.requests.every((request) => request.body.tools?.map((tool) => tool.name).join() === "submit_plan")).toBe(true);
    expect(JSON.stringify(model.requests[0]!.body.messages)).not.toContain("必须拒绝负数交易金额");
    const parts = model.requests[0]!.body.messages.flatMap((message) => typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
    const prompt = parts.find((part) => part.text?.includes("根据章节大纲规划规范集"))!.text!;
    const outline = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
    expect(outline).toEqual([
      { id: "section-0", parentId: null, title: "安全规范.md", level: 0, characters: "# 安全编码\n必须拒绝负数交易金额。".length },
      { id: "section-1", parentId: "section-0", title: "安全编码", level: 1, characters: "必须拒绝负数交易金额。".length },
    ]);
    expect(model.requests.every((request) => request.body.model === "fixture-generator")).toBe(true);
    expect(host.activeAgentCount).toBe(0);
  });
  it("三次错误分配后拒绝继续提交并释放会话", async () => {
    model = await startMockModelServer({ generatorScript: [
      ...Array.from({ length: 3 }, () => ({ name: "submit_plan", input: { sets: [], skipped: [] }, result: { isError: true } })),
      { name: "submit_plan", input: plan, result: { isError: true, includes: "规划校验失败" } },
    ] });
    host = await bootReviewHost({ homeDir: directory, models: model.models, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    await expect(generator.plan("安全规范.md", "必须校验输入。", "section")).rejects.toThrow("规划校验失败");
    expect(host.activeAgentCount).toBe(0);
  });
  it("模型失败仅返回安全分类并释放会话", async () => {
    model = await startMockModelServer({ mode: "model-error" });
    host = await bootReviewHost({ homeDir: directory, models: model.models, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    await expect(generator.plan("安全规范.md", "必须校验输入。", "section")).rejects.toThrow("模型服务暂时不可用");
    expect(host.activeAgentCount).toBe(0);
  });
  it("未配置 Generator 时返回配置提示", async () => {
    host = await bootReviewHost({ homeDir: directory, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    await expect(generator.plan("安全规范.md", "必须检查输入。", "section")).rejects.toThrow("请先配置 Generator 模型");
    expect(host.activeAgentCount).toBe(0);
  });
  it("条目工具拒绝后可纠正、多次提交并显式完成", async () => {
    model = await startMockModelServer({ generatorScript: [
      { name: "finish_chunk", input: { skipped: [] }, result: { isError: true, includes: "至少接受" } },
      { name: "submit_entries", input: { entries: [{ ...importDraft("go"), title: "" }] }, result: { isError: true, includes: "title" } },
      { name: "submit_entries", input: { entries: [importDraft("go")] }, result: { isError: false } },
      { name: "submit_entries", input: { entries: [importDraft("go", 2)] }, result: { isError: false } },
      { name: "finish_chunk", input: { skipped: [] }, result: { isError: false } },
    ] });
    host = await bootReviewHost({ homeDir: directory, models: model.models, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    const entries: LibraryEntry[] = [];
    await generator.generate({ filename: "安全.md", fileId: "file-go", path: "安全.md › Go", text: "必须检查输入。必须处理错误。" }, { entries: async (batch) => { entries.push(...batch); }, skipped: async () => {} });
    expect(entries).toHaveLength(2); expect(model.scriptErrors).toEqual([]);
    expect(model.requests.every((request) => request.body.tools?.map((tool) => tool.name).sort().join() === "finish_chunk,submit_entries")).toBe(true);
    expect(host.activeAgentCount).toBe(0);
  });
  it("没有完成提交时保留已接受条目并报告失败", async () => {
    model = await startMockModelServer({ generatorScript: [{ name: "submit_entries", input: { entries: [importDraft("go")] }, result: { isError: false } }] });
    host = await bootReviewHost({ homeDir: directory, models: model.models, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    const entries: LibraryEntry[] = [];
    await expect(generator.generate({ filename: "安全.md", fileId: "file-go", path: "安全.md › Go", text: "必须检查输入。" }, { entries: async (batch) => { entries.push(...batch); }, skipped: async () => {} })).rejects.toThrow("未完成提交");
    expect(entries).toHaveLength(1); expect(host.activeAgentCount).toBe(0);
  });
  it("步骤预算用完后停止调用并释放会话", async () => {
    model = await startMockModelServer({ generatorScript: Array.from({ length: 35 }, () => ({ name: "finish_chunk", input: { skipped: [] }, result: { isError: true } })) });
    host = await bootReviewHost({ homeDir: directory, models: model.models, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    await expect(generator.generate({ filename: "安全.md", fileId: "file-go", path: "安全.md › Go", text: "必须检查输入。" }, { entries: async () => {}, skipped: async () => {} })).rejects.toThrow("步骤预算用完");
    expect(model.requests.length).toBeLessThanOrEqual(30); expect(host.activeAgentCount).toBe(0);
  });
  it("超时取消模型请求并释放会话", async () => {
    model = await startMockModelServer({ beforeReply: async () => { await new Promise((resolve) => setTimeout(resolve, 100)); } });
    host = await bootReviewHost({ homeDir: directory, models: model.models, onReady: async (_runtime, _rules, created) => { generator = created; return async () => {}; } });
    const setTimer = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => setTimer(callback, delay === 600000 ? 20 : delay, ...args)) as typeof setTimeout);
    await expect(generator.generate({ filename: "安全.md", fileId: "file-go", path: "安全.md › Go", text: "必须检查输入。" }, { entries: async () => {}, skipped: async () => {} })).rejects.toThrow("生成超时");
    expect(host.activeAgentCount).toBe(0);
  });

});
