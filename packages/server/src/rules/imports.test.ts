import { sliceImportFile } from "./import-slicing.js";
import { ImportFailure } from "../runtime/import-generator.js";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedRuleScenario } from "./managed/test-support.js";
import { RuleImportService } from "./imports.js";
let app: ManagedRuleScenario | undefined;
afterEach(async () => { await app?.stop(); app = undefined; });
async function start() { app = new ManagedRuleScenario(); await app.start(); return app; }
const upload = (fixture: ManagedRuleScenario) => fixture.request<{ id: string }>("/api/rule-library-imports", { files: [{ name: "安全规范.md", content: Buffer.from("# 安全\n必须校验输入。").toString("base64") }] });
describe("实例导入队列", () => {
  it("保存文件摘要并在未配置模型时给出明确失败", async () => {
    const fixture = await start(), created = await upload(fixture);
    expect(created.status).toBe(201);
    await new RuleImportService(fixture.pool).dispatch();
    const detail = await fixture.request<{ status: string; error: string; files: Array<{ size: number; sha256: string }> }>(`/api/rule-library-imports/${created.body.id}`);
    expect(detail.body.status).toBe("failed"); expect(detail.body.error).toBe("请先配置 Generator 模型");
    expect(detail.body.files[0]!.size).toBe(Buffer.byteLength("# 安全\n必须校验输入。")); expect(detail.body.files[0]!.sha256).toHaveLength(64);
  });
  it("同一实例只处理一个导入，生成完成后保留结果并可识别重启中断", async () => {
    const fixture = await start(), first = await upload(fixture); await upload(fixture);
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    let calls = 0;
    const service = new RuleImportService(fixture.pool, { generate: async () => {}, plan: async (_filename, _content, prefix) => {
      calls++; entered(); await barrier; return { sets: [{ name: "安全规范", layer: "general", languages: [], sectionIds: [`${prefix}-0`] }], skipped: [] };
    } });
    const running = service.dispatch(); await ready;
    try { await service.dispatch(); expect(calls).toBe(1); } finally { release(); await running; }
    const detail = await fixture.request<{ status: string; chunks: Array<{ status: string }> }>(`/api/rule-library-imports/${first.body.id}`);
    expect(detail.body.status).toBe("ready"); expect(detail.body.chunks.map((chunk) => chunk.status)).toEqual(["completed"]);
    await fixture.pool.query("UPDATE rule_library_imports SET status='generating' WHERE id=$1", [first.body.id]);
    await fixture.pool.query("UPDATE rule_library_import_chunks SET status='running' WHERE import_id=$1", [first.body.id]);
    await service.recover();
    const recovered = await fixture.request<{ status: string; error: string }>(`/api/rule-library-imports/${first.body.id}`);
    expect(recovered.body).toMatchObject({ status: "partial_failed", error: "服务重启，生成中断" });
  });
  it("一个导入最多四个片段并发，排队片段随后完成", async () => {
    const fixture = await start();
    const text = `# 安全规范\n${Array.from({ length: 7 }, (_, index) => `## 输入检查 ${index + 1}\n必须检查输入。\n`).join("")}`;
    const created = await fixture.request<{ id: string }>("/api/rule-library-imports", { files: [{ name: "安全规范.md", content: Buffer.from(text).toString("base64") }] });
    let release!: () => void, entered!: () => void, active = 0, maximum = 0, count = 0;
    const barrier = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
    const service = new RuleImportService(fixture.pool, {
      plan: async (name, content, prefix) => ({ sets: [{ name: "输入检查", layer: "general", languages: [], sectionIds: sliceImportFile(name, content, prefix).sections.filter((section) => section.level === 2).map((section) => section.id) }], skipped: [{ sectionId: `${prefix}-0`, reason: "标题" }] }),
      generate: async () => { active++; count++; maximum = Math.max(maximum, active); if (active === 4) entered(); await barrier; active--; },
    });
    const running = service.dispatch(); await ready;
    try { expect(maximum).toBe(4); expect(count).toBe(4); } finally { release(); await running; }
    expect(count).toBe(7); expect(maximum).toBe(4);
    const detail = await fixture.request<{ status: string; progress: { ended: number; total: number } }>(`/api/rule-library-imports/${created.body.id}`);
    expect(detail.body).toMatchObject({ status: "ready", progress: { ended: 7, total: 7 } });
  });
  it("规划未完成的导入重启后整体失败，允许重新规划", async () => {
    const fixture = await start();
    const created = await fixture.request<{ id: string }>("/api/rule-library-imports", { files: ["安全规范.md", "错误处理.md"].map((name) => ({ name, content: Buffer.from("必须检查输入。\n").toString("base64") })) });
    await fixture.pool.query("UPDATE rule_library_import_files SET plan=$2 WHERE import_id=$1 AND name='安全规范.md'", [created.body.id, JSON.stringify({ sets: [], skipped: [] })]);
    await fixture.pool.query("UPDATE rule_library_imports SET status='planning' WHERE id=$1", [created.body.id]);
    const service = new RuleImportService(fixture.pool);
    await service.recover();
    expect((await fixture.request(`/api/rule-library-imports/${created.body.id}`)).body).toMatchObject({ status: "failed", error: "服务重启，生成中断" });
    expect((await fixture.request(`/api/rule-library-imports/${created.body.id}/retry`, {})).status).toBe(200);
    expect((await fixture.request(`/api/rule-library-imports/${created.body.id}`)).body).toMatchObject({ status: "queued", files: [expect.objectContaining({ plan: null }), expect.objectContaining({ plan: null })] });
  });
  it.each(["planning", "generating"] as const)("%s 阶段的普通错误使用对应阶段文案", async (stage) => {
    const fixture = await start(), created = await upload(fixture);
    if (stage === "generating") {
      await fixture.pool.query(`CREATE FUNCTION reject_import_chunk_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '模拟片段写入失败'; END $$`);
      await fixture.pool.query(`CREATE TRIGGER reject_import_chunk_start BEFORE UPDATE ON rule_library_import_chunks FOR EACH ROW WHEN (NEW.status='running') EXECUTE FUNCTION reject_import_chunk_start()`);
    }
    const service = new RuleImportService(fixture.pool, {
      plan: async (_name, _content, prefix) => { if (stage === "planning") throw new Error("模拟规划错误"); return { sets: [{ name: "安全规范", layer: "general", languages: [], sectionIds: [`${prefix}-0`] }], skipped: [] }; },
      generate: async () => {},
    });
    await service.dispatch();
    expect((await fixture.request(`/api/rule-library-imports/${created.body.id}`)).body).toMatchObject({ status: "failed", error: stage === "planning" ? "规划失败" : "生成失败" });
  });
  it("规划失败可以整体重试", async () => {
    const fixture = await start(), created = await upload(fixture); let unavailable = true;
    const service = new RuleImportService(fixture.pool, {
      plan: async (_name, _content, prefix) => { if (unavailable) throw new ImportFailure("模型服务暂时不可用"); return { sets: [{ name: "安全规范", layer: "general", languages: [], sectionIds: [`${prefix}-0`] }], skipped: [] }; },
      generate: async () => {},
    });
    await service.dispatch(); unavailable = false;
    expect((await fixture.request(`/api/rule-library-imports/${created.body.id}/retry`, {})).status).toBe(200);
    await service.dispatch();
    expect((await fixture.request<{ status: string }>(`/api/rule-library-imports/${created.body.id}`)).body.status).toBe("ready");
  });

});
