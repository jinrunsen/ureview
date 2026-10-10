import type { SessionView } from "../../packages/server/src/auth/service.js";
import type { AppliedLibrarySet } from "../../packages/server/src/rules/library-types.js";
import type { ManagedRule } from "../../packages/server/src/rules/managed-types.js";
import assert from "node:assert/strict";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import type { ApiWorld } from "../support/world.js";
import type { ManagedRuleScenario } from "../../packages/server/src/rules/managed/test-support.js";
import { RuleImportScenario, type ImportPreview } from "../../packages/server/src/rules/import/test-support.js";
import { importChecklist, installationGuide } from "../../packages/server/src/rules/import/test-support.js";
import type { LibraryEntry } from "../../packages/server/src/rules/library-types.js";
import { fixturePassword } from "../../packages/server/src/auth/test-support.js";
interface State { oldVersion?: number; setId?: string; paymentCookie?: string; applied?: ManagedRule[]; librarySet?: AppliedLibrarySet; scenario: RuleImportScenario; files?: Array<{ name: string; text: string }>; id?: string; preview?: ImportPreview; previousJava?: LibraryEntry[]; app: ManagedRuleScenario; status: number; body: { error?: { message: string } }; cookie?: string }
const states = new WeakMap<ApiWorld, State>();
const state = (world: ApiWorld) => { const value = states.get(world); assert.ok(value); return value; };
Before({ tags: "@layer:api and @story:rule-library-import", timeout: 60000 }, async function (this: ApiWorld) { const scenario = new RuleImportScenario(); const value = { scenario, app: scenario.app, status: 0, body: {} }; states.set(this, value); await scenario.start(); });
After({ tags: "@layer:api and @story:rule-library-import", timeout: 60000 }, async function (this: ApiWorld) { await states.get(this)?.scenario.stop(); });
const file = (name: string, content = "# 编程经验\n必须检查输入参数。") => ({ name, content: Buffer.from(content).toString("base64") });
async function upload(value: State, files: ReturnType<typeof file>[]) { const result = await value.app.request<State["body"]>("/api/rule-library-imports", { files }, value.cookie ? { cookie: value.cookie } : {}); value.status = result.status; value.body = result.body; }
async function empty(value: State) { const result = await value.app.request<{ imports: unknown[] }>("/api/rule-library-imports"); assert.equal(result.status, 200); assert.deepEqual(result.body.imports, []); }
Given("服务管理员张伟准备了一份研发编程经验 checklist", function (this: ApiWorld) { assert.ok(state(this).app.cookie); });
When("张伟连同一份 PDF 文件一起上传", async function (this: ApiWorld) { await upload(state(this), [file("研发编程经验.md"), file("编码规范.pdf")]); });
Then("上传被拒绝并指出 PDF 文件的格式不受支持，导入列表没有新增导入", async function (this: ApiWorld) { const value = state(this); assert.equal(value.status, 400); assert.match(value.body.error!.message, /编码规范.pdf.*格式不受支持/); await empty(value); });
When("张伟上传一份超过 1 MB 的 Markdown 文件", async function (this: ApiWorld) { await upload(state(this), [file("研发编程经验.md", "规".repeat(350000))]); });
Then("上传被拒绝并指出该文件超过大小限制", async function (this: ApiWorld) { const value = state(this); assert.equal(value.status, 400); assert.match(value.body.error!.message, /研发编程经验.md.*大小限制/); await empty(value); });
Given("支付团队管理员李娜没有服务管理员权限", async function (this: ApiWorld) {
  const value = state(this); const result = await value.app.request("/api/admin/members", { username: "li.admin", name: "李娜", password: fixturePassword, role: "admin" }); assert.equal(result.status, 201);
  const login = await value.app.request("/api/auth/login", { username: "li.admin", password: fixturePassword }, { cookie: "" }); assert.equal(login.status, 200); value.cookie = login.cookie;
});
When("李娜尝试上传研发编程语言 checklist", async function (this: ApiWorld) {
  const value = state(this); await upload(value, [file("研发编程语言.md")]);
  const member = await value.app.request("/api/rule-library-imports", { files: [file("研发编程语言.md")] }, { cookie: value.app.memberCookie }); assert.equal(member.status, 403);
  for (const cookie of [value.cookie!, value.app.memberCookie]) { const list = await value.app.request("/api/rule-library-imports", undefined, { cookie }); assert.equal(list.status, 403); }
});
Then("上传未生效且导入列表中没有新的导入", async function (this: ApiWorld) { assert.equal(state(this).status, 403); await empty(state(this)); });

Given("服务管理员张伟准备了一份按 C&C++ 与 Go 分章的研发编程语言 checklist", function (this: ApiWorld) { state(this).files = [{ name: "研发编程语言 checklist.md", text: importChecklist() }]; });
async function uploadAndWait(value: State) { value.id = await value.scenario.upload(value.files!); value.preview = await value.scenario.wait(value.id); }
When("张伟上传该文件并等待导入完成", async function (this: ApiWorld) { await uploadAndWait(state(this)); });
Then(/^导入预览包含 C\/C\+\+ 与 Go 两个语言层规范集$/, function (this: ApiWorld) {
  const preview = state(this).preview!; assert.equal(preview.status, "ready"); assert.equal(preview.sets.length, 2);
  assert.deepEqual(preview.sets.map((set) => set.languages).sort(), [["c", "cpp"], ["go"]]); assert.ok(preview.sets.every((set) => set.layer === "language" && set.entries.length === 3));
});
Then("每个条目都有标题、摘要、检查什么、严重级别和指向原文章节的出处", function (this: ApiWorld) {
  for (const set of state(this).preview!.sets) for (const entry of set.entries) {
    for (const field of ["title", "originalName", "summary", "body", "check", "why", "fix", "severity", "category"] as const) assert.ok(entry[field]);
    assert.match(entry.source.reference, /研发编程语言 checklist.md › 研发编程语言 checklist › (C&C\+\+|Go)/);
    assert.match(entry.id, /^import-entry-/); assert.ok(entry.goodExample && entry.badExample);
  }
});
Given("服务管理员张伟准备了一份研发编程语言 checklist 和一份 GitLab MCP 安装指南", function (this: ApiWorld) {
  state(this).files = [{ name: "研发编程语言 checklist.md", text: importChecklist() }, { name: "GitLab MCP 安装指南.txt", text: installationGuide }];
});
When("张伟同时上传两份文件并等待导入完成", async function (this: ApiWorld) { await uploadAndWait(state(this)); });
Then("安装指南没有生成规范集，预览列出它被跳过的理由", function (this: ApiWorld) {
  const preview = state(this).preview!, guide = preview.files.find((file) => file.name === "GitLab MCP 安装指南.txt")!;
  assert.equal(preview.status, "ready"); assert.ok(guide); assert.ok(!preview.sets.some((set) => set.file_id === guide.id)); assert.match(guide.plan!.skipped[0]!.reason, /安装指南不属于编码规范/);
});
Then("checklist 中的排版总则列为未生成条目的段落并写明理由", function (this: ApiWorld) {
  assert.ok(state(this).preview!.chunks.flatMap((chunk) => chunk.skipped).some((item) => item.reference.includes("排版总则") && item.reason.includes("适用范围")));
});
Given("服务管理员张伟上传了一份按 Java 与 Go 分章的研发安全编码 checklist", async function (this: ApiWorld) {
  const value = state(this); value.scenario.controls.failGo = true; value.scenario.controls.failAfterBatch = true;
  value.id = await value.scenario.upload([{ name: "研发安全编码 checklist.md", text: importChecklist(["Java", "Go"]) }]);
});
Given("生成 Go 章节时模型服务暂时不可用", function (this: ApiWorld) { assert.equal(state(this).scenario.controls.failGo, true); });
When("导入结束", async function (this: ApiWorld) { const value = state(this); value.preview = await value.scenario.wait(value.id!); });
Then("导入显示部分失败，Java 规范集的条目可以预览，Go 章节列为失败片段", function (this: ApiWorld) {
  const value = state(this), preview = value.preview!; assert.equal(preview.status, "partial_failed");
  value.previousJava = preview.sets.find((set) => set.languages.includes("java"))!.entries; assert.equal(value.previousJava.length, 3);
  assert.equal(preview.sets.find((set) => set.languages.includes("go"))!.entries.length, 0);
  assert.ok(preview.chunks.some((chunk) => chunk.path.includes("Go") && chunk.status === "failed" && chunk.error === "模型服务暂时不可用"));
});
When("模型服务恢复后张伟重试失败片段", async function (this: ApiWorld) {
  const value = state(this); value.scenario.controls.failGo = false;
  const chunkId = value.preview!.chunks.find((chunk) => chunk.status === "failed")!.id;
  const result = await value.app.request(`/api/rule-library-imports/${value.id}/retry`, { chunkId }); assert.equal(result.status, 200, JSON.stringify(result.body)); value.preview = await value.scenario.wait(value.id!);
});
Then("导入变为待发布，预览包含 Go 规范集", function (this: ApiWorld) {
  const value = state(this); assert.equal(value.preview!.status, "ready"); assert.equal(value.preview!.sets.find((set) => set.languages.includes("go"))!.entries.length, 3);
  assert.deepEqual(value.preview!.sets.find((set) => set.languages.includes("java"))!.entries, value.previousJava);
});

async function previewGo(value: State) {
  value.id = await value.scenario.upload([{ name: "研发编程语言 checklist.md", text: importChecklist() }]);
  value.preview = await value.scenario.wait(value.id); assert.equal(value.preview.status, "ready");
  return value.preview.sets.find((set) => set.languages.includes("go"))!;
}
async function publishGo(value: State) {
  const set = await previewGo(value); value.setId = set.id;
  const response = await value.app.request(`/api/rule-library-imports/${value.id}/publish`, { version: value.preview!.version, setIds: [set.id] });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  value.preview = await value.scenario.previewWithEntries(value.id!);
}
async function applyInPaymentTeam(value: State) {
  const team = await value.app.request<{ id: string }>("/api/admin/teams", { name: "支付团队" }); assert.equal(team.status, 201);
  const owner = await value.app.request("/api/auth/login", { username: "zhang.wei", password: fixturePassword }, { cookie: "" });
  assert.equal((await value.app.request("/api/auth/team", { teamId: team.body.id }, { cookie: owner.cookie })).status, 200);
  assert.equal((await value.app.request("/api/admin/members", { username: "li.payment", name: "李娜", password: fixturePassword, role: "admin" }, { cookie: owner.cookie })).status, 201);
  const login = await value.app.request<SessionView>("/api/auth/login", { username: "li.payment", password: fixturePassword }, { cookie: "" });
  assert.equal(login.status, 200); assert.equal(login.body.user!.teamId, team.body.id); assert.equal(login.body.user!.serviceRole, "user"); value.paymentCookie = login.cookie;
  const library = await value.app.readLibrary("?layer=language&language=go", { cookie: value.paymentCookie }); assert.equal(library.status, 200);
  value.librarySet = library.body.sets.find((set) => set.id === value.setId)!; assert.ok(value.librarySet);
  const entryIds = value.librarySet.entries.slice(0, 2).map((entry) => entry.id);
  const applied = await value.app.request<{ rules: ManagedRule[]; created: number }>(`/api/rule-library/${value.setId}/apply`, { entryIds }, { cookie: value.paymentCookie });
  assert.equal(applied.status, 200, JSON.stringify(applied.body)); assert.equal(applied.body.created, 2); value.applied = applied.body.rules;
  const repeated = await value.app.request<{ rules: ManagedRule[]; created: number }>(`/api/rule-library/${value.setId}/apply`, { entryIds }, { cookie: value.paymentCookie });
  assert.equal(repeated.status, 200); assert.equal(repeated.body.created, 0); assert.deepEqual(repeated.body.rules, value.applied);
}
Given(/^张伟的导入已生成 C\/C\+\+ 规范集预览$/, async function (this: ApiWorld) {
  const value = state(this);
  const text = importChecklist(["C&C++"]).replace("1. 输入检查", "1. 缩进").replace("必须检查输入长度和取值范围。", "缩进使用四个空格。").replace("2. 错误处理", "2. 大括号").replace("禁止忽略外部调用的错误。", "条件分支必须使用大括号。");
  value.id = await value.scenario.upload([{ name: "数据面编码 checklist.md", text }]); value.preview = await value.scenario.wait(value.id);
  assert.equal(value.preview.status, "ready"); value.oldVersion = value.preview.version; value.setId = value.preview.sets[0]!.id;
});
When("张伟把规范集改名为“数据面 C 编码规范”，适用语言只保留 C，并删除其中两条排版条目", async function (this: ApiWorld) {
  const value = state(this), set = value.preview!.sets[0]!;
  const changed = await value.app.request<{ version: number }>(`/api/rule-library-imports/${value.id}/sets/${set.id}`, { version: value.preview!.version, name: "数据面 C 编码规范", layer: "language", languages: ["c"] }, { method: "PUT" }); assert.equal(changed.status, 200);
  let version = changed.body.version;
  const formatting = set.entries.filter((entry) => /indent|brace/.test(entry.originalName)); assert.equal(formatting.length, 2);
  for (const entry of formatting) {
    const removed = await value.app.request<{ version: number }>(`/api/rule-library-imports/${value.id}/entries/${entry.id}`, { version }, { method: "DELETE" }); assert.equal(removed.status, 200); version = removed.body.version;
  }
  value.preview = await value.scenario.previewWithEntries(value.id!);
});
Then("预览中的规范集名称、语言和条目数随之更新", function (this: ApiWorld) {
  const set = state(this).preview!.sets[0]!; assert.equal(set.name, "数据面 C 编码规范"); assert.deepEqual(set.languages, ["c"]); assert.equal(set.entries.length, 1);
});
When("服务管理员王芳用修改前的导入版本删除另一条条目", async function (this: ApiWorld) {
  const value = state(this);
  assert.equal((await value.app.request("/api/admin/members", { username: "wang.fang", name: "王芳", password: fixturePassword, role: "member" })).status, 201);
  const login = await value.app.request<SessionView>("/api/auth/login", { username: "wang.fang", password: fixturePassword }, { cookie: "" }); assert.equal(login.status, 200);
  assert.equal((await value.app.identity.request(`/api/service-users/${login.body.user!.userId}`, { role: "service_admin" }, { method: "PUT" })).status, 200);
  const deleted = await value.app.request<State["body"]>(`/api/rule-library-imports/${value.id}/entries/${value.preview!.sets[0]!.entries[0]!.id}`, { version: value.oldVersion }, { method: "DELETE", cookie: login.cookie });
  value.status = deleted.status; value.body = deleted.body;
});
Then("删除未生效并提示导入已被更新", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.status, 409); assert.match(value.body.error!.message, /导入已被更新/);
  assert.deepEqual(await value.scenario.previewWithEntries(value.id!), value.preview);
});
Given("张伟发布了导入生成的 Go 规范集", async function (this: ApiWorld) { await publishGo(state(this)); });
When("支付团队管理员李娜打开规范库并应用其中两条", async function (this: ApiWorld) { await applyInPaymentTeam(state(this)); });
Then("规范库中该规范集标记为企业导入并显示来源文件", function (this: ApiWorld) {
  const set = state(this).librarySet!; assert.equal(set.sourceType, "imported"); assert.equal(set.sourceFilename, "研发编程语言 checklist.md"); assert.equal(set.publishedBy, "张伟"); assert.ok(Number.isFinite(Date.parse(set.publishedAt!))); assert.equal(set.libraryVersion, set.publishedAt);
});
Then("支付团队得到两条已启用的 Go 规范并保留规范库关联", async function (this: ApiWorld) {
  const value = state(this); assert.equal(value.applied!.length, 2);
  for (const rule of value.applied!) { assert.equal(rule.status, "active"); assert.equal(rule.scope, "global"); assert.deepEqual(rule.languages, ["go"]); assert.equal(rule.librarySource!.setId, value.setId); assert.match(rule.librarySource!.entryId, /^import-entry-/); assert.equal(rule.librarySource!.version, value.librarySet!.libraryVersion); }
  assert.deepEqual((await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules")).body.rules, []);
  const member = await value.app.readLibrary("", { cookie: value.app.memberCookie }); assert.ok(member.body.sets.some((set) => set.id === value.setId));
  assert.equal((await value.app.request(`/api/rule-library/${value.setId}/apply`, {}, { cookie: value.app.memberCookie })).status, 403);
});
Given("支付团队已应用导入的 Go 规范集中的两条规范", async function (this: ApiWorld) { const value = state(this); await publishGo(value); await applyInPaymentTeam(value); });
When("张伟删除这个已发布的规范集", async function (this: ApiWorld) { const value = state(this); assert.equal((await value.app.request(`/api/rule-library/${value.setId}`, undefined, { method: "DELETE" })).status, 200); });
Then("规范库不再显示该规范集", async function (this: ApiWorld) {
  const value = state(this); const library = await value.app.readLibrary("", { cookie: value.paymentCookie! }); assert.equal(library.status, 200); assert.ok(!library.body.sets.some((set) => set.id === value.setId));
});
Then("支付团队的两条规范正文与规范库关联保持不变", async function (this: ApiWorld) {
  const value = state(this), rules = await value.app.request<{ rules: ManagedRule[] }>("/api/managed-rules", undefined, { cookie: value.paymentCookie! });
  assert.deepEqual([...rules.body.rules].sort((a, b) => a.id.localeCompare(b.id)), [...value.applied!].sort((a, b) => a.id.localeCompare(b.id)));
  for (const rule of value.applied!) { const update = await value.app.request<{ update: unknown }>(`/api/managed-rules/${rule.id}/library-update`, undefined, { cookie: value.paymentCookie! }); assert.equal(update.status, 200); assert.equal(update.body.update, null); }
});
