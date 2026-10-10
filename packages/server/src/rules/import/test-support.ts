import type { ImportEntryDraft } from "../import-entries.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootReviewHost } from "../../runtime/host.js";
import { startMockModelServer, type MockModelOptions } from "../../runtime/test-support.js";
import { ManagedRuleScenario } from "../managed/test-support.js";
import type { ImportPlan } from "../import-plan.js";
import type { LibraryEntry } from "../library-types.js";
export interface ImportPreview {
  id: string; version: number; status: string; error: string | null;
  files: Array<{ id: string; name: string; plan: ImportPlan | null }>;
  sets: Array<{ id: string; file_id: string; name: string; layer: string; languages: string[]; entry_count: number; entries: LibraryEntry[]; published_at: string | null }>;
  chunks: Array<{ id: string; set_id: string | null; file_id: string; path: string; status: string; error: string | null; skipped: Array<{ reference: string; reason: string }> }>;
  progress: { ended: number; total: number };
}
export type ImportSummary = Omit<ImportPreview, "sets"> & { sets: Array<Omit<ImportPreview["sets"][number], "entries">> };
export class RuleImportScenario {
  readonly app = new ManagedRuleScenario();
  readonly controls = { failGo: false, failAfterBatch: false, delayMs: 0, large: false };
  private host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
  model: Awaited<ReturnType<typeof startMockModelServer>> | undefined;
  private directory: string | undefined;
  private started = false;
  async start(options: { webDir?: string; port?: number; publicOrigin?: string } = {}) {
    try {
      this.directory = await mkdtemp(join(tmpdir(), "ureview-import-scenario-"));
      const reply: NonNullable<MockModelOptions["importReply"]> = (body) => {
        const parts = body.messages.flatMap((message) => typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content);
        const calls = parts.filter((part) => part.type === "tool_use");
        if (body.tools?.some((tool) => tool.name === "submit_plan")) {
          if (calls.length) return undefined;
          const text = parts.find((part) => part.text?.includes("根据章节大纲规划规范集"))!.text!;
          const sections = JSON.parse(text.slice(text.lastIndexOf("\n") + 1)) as Array<{ id: string; title: string }>;
          if (this.controls.large) return { name: "submit_plan", input: { sets: sections.filter((section) => section.title.startsWith("支付安全 · ")).map((section) => ({ name: section.title, layer: "general", languages: [], sectionIds: [section.id] })), skipped: [{ sectionId: sections[0]!.id, reason: "文档说明" }] } };
          const sets: ImportPlan["sets"] = sections.flatMap((section) => {
            const language = section.title;
            const languages = language === "C&C++" ? ["c", "cpp"] : language === "Go" ? ["go"] : language === "Java" ? ["java"] : [];
            return languages.length ? [{ name: `研发编程语言 · ${language === "C&C++" ? "C/C++" : language}`, layer: "language" as const, languages, sectionIds: [section.id] }] : [];
          });
          return { name: "submit_plan", input: { sets, skipped: [{ sectionId: sections[0]!.id, reason: sets.length ? "文档标题与说明" : "安装指南不属于编码规范" }] } };
        }
        const text = parts.find((part) => part.text?.includes("片段数据：\n"))!.text!;
        const input = JSON.parse(text.split("片段数据：\n")[1]!) as { path: string; text: string };
        if (this.controls.large) {
          const count = input.path.includes("支付安全 · 01") ? 50 : input.path.includes("支付安全 · 02") ? 66 : 63;
          const offset = calls.filter((call) => call.name === "submit_entries").length * 10;
          if (offset < count) return { name: "submit_entries", input: { entries: Array.from({ length: Math.min(10, count - offset) }, (_, index) => ({ ...importDraft("go"), title: `支付请求边界检查 ${offset + index + 1}`, body: "支付请求必须检查输入长度、金额范围与调用错误。".repeat(15), goodExample: "if err != nil { return err }\n".repeat(12), badExample: "result, _ := readInput()\n".repeat(12) })) } };
          if (!calls.some((call) => call.name === "finish_chunk")) return { name: "finish_chunk", input: { skipped: [] } };
          return undefined;
        }
        if (this.controls.failGo && input.path.includes("Go") && (!this.controls.failAfterBatch || calls.length > 0)) return "error";
        const language = input.path.includes("Go") ? "go" : input.path.includes("Java") ? "java" : "c";
        if (calls.length === 0) {
          const drafts = [importDraft(language), importDraft(language, 2)];
          if (input.text.includes("缩进使用四个空格")) {
            Object.assign(drafts[0]!, { title: "indent：缩进使用四个空格", originalName: "1. indent（缩进）", summary: "缩进使用四个空格，便于辨认代码层次。", body: "每一级缩进使用四个空格。", check: "检查缩进宽度。", why: "混合缩进使控制流层次难以辨认。", fix: "将缩进统一为四个空格。", goodExample: "if (ready) {\n    send();\n}", badExample: "if (ready) {\n send();\n}" });
            Object.assign(drafts[1]!, { title: "brace：条件分支使用大括号", originalName: "2. brace（大括号）", summary: "条件分支使用大括号，避免新增语句超出分支。", body: "条件分支即使只有一行也使用大括号。", check: "检查分支是否被大括号包围。", why: "后续添加语句时可能误判分支范围。", fix: "给分支体增加大括号。", goodExample: "if (ready) { send(); }", badExample: "if (ready) send();" });
          }
          return { name: "submit_entries", input: { entries: drafts } };
        }
        if (calls.length === 1) return { name: "submit_entries", input: { entries: [importDraft(language, 3)] } };
        if (calls.length === 2) return { name: "finish_chunk", input: { skipped: input.text.includes("排版总则") ? [{ reference: `${input.path} › 排版总则`, reason: "说明规范适用范围，不构成独立条款" }] : [] } };
        return undefined;
      };
      this.model = await startMockModelServer({ importReply: reply, beforeReply: async () => { if (this.controls.delayMs) await new Promise((resolve) => setTimeout(resolve, this.controls.delayMs)); } });
      this.host = await bootReviewHost({ homeDir: this.directory, models: this.model.models,
        onReady: async (_runtime, _rules, generator) => { await this.app.start({ ...options, importGenerator: generator }); this.started = true; return async () => { this.started = false; await this.app.stop(); }; } });
    } catch (error) { await this.stop(); throw error; }
  }
  async upload(files: Array<{ name: string; text: string }>): Promise<string> {
    const result = await this.app.request<{ id: string }>("/api/rule-library-imports", { files: files.map((file) => ({ name: file.name, content: Buffer.from(file.text).toString("base64") })) });
    if (result.status !== 201) throw new Error(`上传失败：${JSON.stringify(result.body)}`); return result.body.id;
  }
  async wait(id: string): Promise<ImportPreview> {
    const deadline = Date.now() + (this.controls.large ? 120000 : 30000);
    while (Date.now() < deadline) {
      const response = await this.app.request<ImportSummary>(`/api/rule-library-imports/${id}`);
      if (response.status !== 200) throw new Error("读取导入失败");
      if (["ready", "partial_failed", "failed"].includes(response.body.status)) return this.previewWithEntries(id);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("等待导入完成超时");
  }
  async previewWithEntries(id: string): Promise<ImportPreview> {
    const response = await this.app.request<ImportSummary>(`/api/rule-library-imports/${id}`);
    if (response.status !== 200) throw new Error("读取导入失败");
    const sets = await Promise.all(response.body.sets.map(async (set) => {
      const result = await this.app.request<{ entries: LibraryEntry[] }>(`/api/rule-library-imports/${id}/sets/${set.id}/entries`);
      if (result.status !== 200) throw new Error("读取导入条目失败");
      return { ...set, entries: result.body.entries };
    }));
    return { ...response.body, sets };
  }
  async stop() {
    try { await this.host?.dispose(); this.host = undefined; if (this.started) { this.started = false; await this.app.stop(); } }
    finally { try { await this.model?.dispose(); this.model = undefined; } finally { if (this.directory) { await rm(this.directory, { recursive: true, force: true }); this.directory = undefined; } } }
  }
}

export const installationGuide = "# GitLab MCP 安装指南\n\n安装客户端后配置服务地址，执行连接检查。\n";
export function importChecklist(languages = ["C&C++", "Go"]): string {
  return `# 研发编程语言 checklist\n\n## 目录\n${languages.map((language) => `- [${language}](#${language})`).join("\n")}\n\n${languages.map((language) => `## ${language}\n\n### 排版总则\n本文说明团队编码规范的适用范围。\n\n#### 1. 输入检查 🔴强制\n必须检查输入长度和取值范围。\n\n#### 2. 错误处理 🔴强制\n禁止忽略外部调用的错误。\n\n#### 3. 资源释放 🟡建议\n- 建议在退出作用域时释放资源。\n  - 关闭文件句柄。\n  - 保留失败原因。\n\n\`\`\`shell\n# 此处是代码注释，不是章节\ncheck_input\n\`\`\`\n`).join("\n")}`;
}
export function importDraft(language: string, index = 1): ImportEntryDraft {
  const titles = ["检查输入长度与取值范围", "处理外部调用错误", "退出作用域时释放资源"];
  return { title: titles[index - 1]!, originalName: `${index}. ${titles[index - 1]}`, summary: `${titles[index - 1]}，避免无效状态继续传播。`,
    body: `调用边界必须${titles[index - 1]}。`, check: `检查调用入口是否${titles[index - 1]}。`, why: "无效状态会造成请求失败或资源泄漏。", fix: `在调用边界${titles[index - 1]}。`,
    goodExample: language === "go" ? "if err != nil { return err }" : "if (error) return error;", badExample: language === "go" ? "result, _ := readInput()" : "useResult(result);", exampleLanguage: language,
    category: "reliability", severity: index === 3 ? "recommendation" : "error", judgement: false };
}
