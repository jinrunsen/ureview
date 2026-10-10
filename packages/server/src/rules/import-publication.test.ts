import { RuleImportService } from "./imports.js";
import { register } from "tsx/esm/api";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RuleImportScenario, importChecklist, type ImportPreview, type ImportSummary } from "./import/test-support.js";
let scenario: RuleImportScenario;
beforeAll(() => { register(); });
beforeEach(async () => { scenario = new RuleImportScenario(); await scenario.start(); });
afterEach(async () => { await scenario?.stop(); });
async function upload() { const id = await scenario.upload([{ name: "安全规范.md", text: importChecklist(["Java", "Go"]) }]); return scenario.wait(id); }
async function detail(id: string) { return scenario.previewWithEntries(id); }
async function publish(preview: ImportPreview, setIds: string[]) { return scenario.app.request(`/api/rule-library-imports/${preview.id}/publish`, { version: preview.version, setIds }); }
describe("导入规范集发布事务", () => {
  it("空规范集不能发布，全部发布状态在详情和列表一致，来源保留名称与文件", async () => {
    let preview = await upload(); const empty = preview.sets[0]!, kept = preview.sets[1]!;
    for (const entry of empty.entries) {
      await scenario.app.request(`/api/rule-library-imports/${preview.id}/entries/${entry.id}`, { version: preview.version }, { method: "DELETE" });
      preview = await detail(preview.id);
    }
    expect((await publish(preview, [empty.id])).status).toBe(409);
    await scenario.app.request(`/api/rule-library-imports/${preview.id}/sets/${empty.id}`, { version: preview.version }, { method: "DELETE" });
    preview = await detail(preview.id);
    expect((await publish(preview, [kept.id])).status).toBe(200);
    expect((await scenario.app.request<{ all_published: boolean }>(`/api/rule-library-imports/${preview.id}`)).body.all_published).toBe(true);
    const list = await scenario.app.request<{ imports: Array<{ id: string; all_published: boolean }> }>("/api/rule-library-imports");
    expect(list.body.imports.find((item) => item.id === preview.id)?.all_published).toBe(true);
    const entries = await scenario.app.request(`/api/rule-library/${kept.id}/entries`, undefined, { cookie: scenario.app.memberCookie });
    expect(entries.status).toBe(200);
    const applied = await scenario.app.request<{ rules: Array<{ id: string }> }>(`/api/rule-library/${kept.id}/apply`, { entryIds: [kept.entries[0]!.id] });
    const path = `/api/rules/managed:${applied.body.rules[0]!.id}/detail`;
    const origin = { kind: "library", setName: kept.name, sourceFilename: "安全规范.md" };
    expect((await scenario.app.request<{ rule: { source: unknown } }>(path)).body.rule.source).toMatchObject(origin);
    await scenario.app.request(`/api/rule-library/${kept.id}`, undefined, { method: "DELETE" });
    expect((await scenario.app.request<{ rule: { source: unknown } }>(path)).body.rule.source).toMatchObject(origin);
  });
  it("概要不含条目，按规范集读取隔离导入与权限，修改删除发布返回最新概要", async () => {
    const preview = await upload(), set = preview.sets[0]!;
    const path = `/api/rule-library-imports/${preview.id}`;
    const summary = (await scenario.app.request<ImportSummary>(path)).body;
    expect(summary.sets.every((item) => !Object.hasOwn(item, "entries"))).toBe(true);
    expect(summary.sets.map((item) => item.entry_count)).toEqual([3, 3]);
    const entriesPath = `${path}/sets/${set.id}/entries`;
    expect((await scenario.app.request<{ entries: unknown[] }>(entriesPath)).body.entries).toEqual(set.entries);
    expect((await scenario.app.request(entriesPath, undefined, { cookie: scenario.app.memberCookie })).status).toBe(403);
    expect((await scenario.app.request("/api/admin/members", { username: "li.admin", name: "李娜", password: "ImportAdmin987!", role: "admin" })).status).toBe(201);
    const login = await scenario.app.request("/api/auth/login", { username: "li.admin", password: "ImportAdmin987!" }, { cookie: "" });
    expect((await scenario.app.request(entriesPath, undefined, { cookie: login.cookie })).status).toBe(403);
    const other = await upload();
    expect((await scenario.app.request(`/api/rule-library-imports/${other.id}/sets/${set.id}/entries`)).status).toBe(404);
    const changed = await scenario.app.request<ImportSummary>(`${path}/sets/${set.id}`, { version: preview.version, name: "支付边界规范", layer: "general", languages: [] }, { method: "PUT" });
    expect(changed.status).toBe(200);
    expect(changed.body.sets.find((item) => item.id === set.id)).toMatchObject({ name: "支付边界规范", entry_count: 3 });
    const deleted = await scenario.app.request<ImportSummary>(`${path}/entries/${set.entries[0]!.id}`, { version: changed.body.version }, { method: "DELETE" });
    expect(deleted.status).toBe(200);
    expect(deleted.body.sets.find((item) => item.id === set.id)?.entry_count).toBe(2);
    const published = await scenario.app.request<ImportSummary>(`${path}/publish`, { version: deleted.body.version, setIds: [set.id] });
    expect(published.status).toBe(200);
    expect(published.body.sets.find((item) => item.id === set.id)?.published_at).toBeTruthy();
    const remaining = preview.sets[1]!;
    const removed = await scenario.app.request<ImportSummary>(`${path}/sets/${remaining.id}`, { version: published.body.version }, { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(removed.body.sets.map((item) => item.id)).toEqual([set.id]);
    for (const result of [changed, deleted, published, removed]) expect(result.body.sets.every((item) => !Object.hasOwn(item, "entries"))).toBe(true);
  });
  it("部分失败只发布已完成规范集，已发布内容冻结，剩余规范集可随后发布", async () => {
    scenario.controls.failGo = true;
    let preview = await upload(); expect(preview.status).toBe("partial_failed");
    const java = preview.sets.find((set) => set.languages.includes("java"))!, go = preview.sets.find((set) => set.languages.includes("go"))!;
    expect((await publish(preview, [go.id])).status).toBe(409);
    expect((await publish(preview, [java.id])).status).toBe(200);
    preview = await detail(preview.id);
    expect((await scenario.app.request(`/api/rule-library-imports/${preview.id}/sets/${java.id}`, { version: preview.version, name: "新的名称", layer: "general", languages: [] }, { method: "PUT" })).status).toBe(409);
    expect((await scenario.app.request(`/api/rule-library-imports/${preview.id}/entries/${java.entries[0]!.id}`, { version: preview.version }, { method: "DELETE" })).status).toBe(409);
    scenario.controls.failGo = false;
    expect((await scenario.app.request(`/api/rule-library-imports/${preview.id}/retry`, {})).status).toBe(200);
    preview = await scenario.wait(preview.id); expect((await publish(preview, [go.id])).status).toBe(200);
    const library = (await scenario.app.readLibrary()).body.sets.filter((set) => set.sourceType === "imported");
    expect(library).toHaveLength(2); expect(library.every((set) => set.entries.length === 3 && set.publishedBy === "张伟")).toBe(true);
  });
  it.each([
    { importStatus: "generating", chunkStatus: "running" },
    { importStatus: "generating", chunkStatus: "pending" },
    { importStatus: "planning", chunkStatus: "pending" },
  ])("重启恢复 $importStatus 导入的 $chunkStatus 片段，已完成规范集可立即预览与发布", async ({ importStatus, chunkStatus }) => {
    scenario.controls.failGo = true;
    const preview = await upload();
    const java = preview.sets.find((set) => set.languages.includes("java"))!, go = preview.sets.find((set) => set.languages.includes("go"))!;
    await scenario.app.pool.query("UPDATE rule_library_imports SET status=$2 WHERE id=$1", [preview.id, importStatus]);
    await scenario.app.pool.query("UPDATE rule_library_import_chunks SET status=$2 WHERE import_id=$1 AND set_id=$3", [preview.id, chunkStatus, go.id]);
    await new RuleImportService(scenario.app.pool).recover();
    const recovered = await detail(preview.id);
    expect(recovered.status).toBe("partial_failed");
    expect(recovered.error).toBe("服务重启，生成中断");
    expect(recovered.version).toBe(preview.version + 1);
    expect(recovered.sets.find((set) => set.id === java.id)).toEqual(java);
    expect(recovered.chunks.find((chunk) => chunk.set_id === go.id)).toMatchObject({ status: "failed", error: "服务重启，生成中断" });
    expect((await publish(recovered, [java.id])).status).toBe(200);
    const library = (await scenario.app.readLibrary()).body.sets;
    expect(library.find((set) => set.id === java.id)?.entries).toEqual(java.entries.map((entry) => ({ ...entry, appliedRuleId: null, appliedVersion: null, hasUpdate: false })));
    scenario.controls.failGo = false;
    expect((await scenario.app.request(`/api/rule-library-imports/${preview.id}/retry`, {})).status).toBe(200);
    const retried = await scenario.wait(preview.id);
    expect(retried.status).toBe("ready");
    expect(retried.sets.find((set) => set.id === java.id)?.entries).toEqual(java.entries);
  });
  it("同版本并发修改仅接受一次，删除规范集同步提高导入版本", async () => {
    let preview = await upload(); const set = preview.sets[0]!;
    const responses = await Promise.all(["支付安全规范", "交易安全规范"].map((name) => scenario.app.request(`/api/rule-library-imports/${preview.id}/sets/${set.id}`, { version: preview.version, name, layer: "language", languages: ["go"] }, { method: "PUT" })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    preview = await detail(preview.id);
    expect((await scenario.app.request(`/api/rule-library-imports/${preview.id}/sets/${set.id}`, { version: preview.version }, { method: "DELETE" })).status).toBe(200);
    const after = await detail(preview.id); expect(after.sets).toHaveLength(1); expect(after.version).toBe(preview.version + 1);
  });
  it("重复上传形成新的规范集和全实例唯一条目，不覆盖已发布内容", async () => {
    const first = await upload(); expect((await publish(first, first.sets.map((set) => set.id))).status).toBe(200);
    const second = await upload(); expect((await publish(second, second.sets.map((set) => set.id))).status).toBe(200);
    const sets = (await scenario.app.readLibrary()).body.sets;
    expect(sets.filter((set) => set.sourceType === "imported")).toHaveLength(4);
    const ids = sets.flatMap((set) => set.entries.map((entry) => entry.id)); expect(new Set(ids).size).toBe(ids.length);
    expect(first.sets.some((set) => second.sets.some((other) => other.id === set.id))).toBe(false);
  });
  it("普通成员不能读取草稿或调用任何发布修改删除接口", async () => {
    const preview = await upload(), set = preview.sets[0]!, cookie = scenario.app.memberCookie;
    expect((await scenario.app.request(`/api/rule-library-imports/${preview.id}`, undefined, { cookie })).status).toBe(403);
    for (const [path, method, body] of [
      [`/api/rule-library-imports/${preview.id}/publish`, "POST", { version: preview.version, setIds: [set.id] }],
      [`/api/rule-library-imports/${preview.id}/sets/${set.id}`, "PUT", { version: preview.version, name: "安全规范", layer: "general", languages: [] }],
      [`/api/rule-library-imports/${preview.id}/sets/${set.id}`, "DELETE", { version: preview.version }],
      [`/api/rule-library-imports/${preview.id}/entries/${set.entries[0]!.id}`, "DELETE", { version: preview.version }],
      [`/api/rule-library-imports/${preview.id}/retry`, "POST", {}],
      [`/api/rule-library/${set.id}`, "DELETE", {}],
    ] as const) expect((await scenario.app.request(path, body, { method, cookie })).status).toBe(403);
    expect(await detail(preview.id)).toEqual(preview);
  });
});
