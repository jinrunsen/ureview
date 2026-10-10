import { ImportChunkCollector, type ImportSkipped } from "../rules/import-entries.js";
import type { LibraryEntry } from "../rules/library-types.js";
import { ruleCategories, ruleSeverities } from "../rules/managed-types.js";
import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, type TurnEndReason } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ReviewModel } from "./config.js";
import { IMPORT_PRESET } from "./profile.js";
import { ruleLayers, ruleLanguages } from "../rules/metadata.js";
import { sliceImportFile } from "../rules/import-slicing.js";
import { validateImportPlan, type ImportPlan } from "../rules/import-plan.js";
export interface ImportGenerator {
  plan(filename: string, content: string, prefix: string): Promise<ImportPlan>;
  generate(input: { filename: string; path: string; text: string; fileId: string }, save: {
    entries: (entries: LibraryEntry[]) => Promise<void>; skipped: (skipped: ImportSkipped[]) => Promise<void>;
  }): Promise<void>;
}
export class ImportFailure extends Error {}
declare module "@deepseek-ai/dsh-llm" { interface MessageSourceMap { "ureview-import": { kind: "ureview-import" } } }
export class DshImportGenerator implements ImportGenerator {
  constructor(private readonly ctx: Context, private readonly model: ReviewModel | undefined | (() => Promise<ReviewModel | undefined>)) {}
  async plan(filename: string, content: string, prefix: string): Promise<ImportPlan> {
    let result: ImportPlan | undefined, rejections = 0;
    const file = sliceImportFile(filename, content, prefix);
    await this.run(`根据章节大纲规划规范集，不读取正文。按语言分章的文件拆成语言层规范集，名称用文档标题加语言；不分语言用通用层。整份文件没有可以在代码中检查的编码约定时（安装、配置、部署、使用说明），跳过根章节并说明理由，不生成规范集；文档修订记录等非规范章节也跳过。子章节继承最近祖先的分配，也可覆盖。必须覆盖全部片段。通过 submit_plan 提交一次有效规划。\n${JSON.stringify(file.sections.map(({ id, parentId, title, level, characters }) => ({ id, parentId, title, level, characters })))}`, (ctx) => {
      ctx.on("tools/result", (execution, result) => { if (execution.name === "submit_plan" && result.isError) rejections++; });
      ctx.tools.register(defineTool({ name: "submit_plan", description: "提交规范集规划和跳过章节，错误可纠正两次。",
        parameters: {
          sets: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            name: { type: "string", required: true }, layer: { type: "string", enum: ruleLayers, required: true },
            languages: { type: "array", items: { type: "string", enum: ruleLanguages }, required: true },
            sectionIds: { type: "array", items: { type: "string" }, required: true },
          } } }, skipped: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { sectionId: { type: "string", required: true }, reason: { type: "string", required: true } } } },
        }, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
        execute: async (args) => {
          if (result) throw new Error("规划已接受");
          if (rejections > 2) throw new ImportFailure("规划校验失败");
          {
            const boundaries = new Set([...args.sets.flatMap((set) => set.sectionIds), ...args.skipped.map((item) => item.sectionId)]);
            result = validateImportPlan(args, sliceImportFile(filename, content, prefix, boundaries));
            return "规划已接受，请结束";
          }
        },
      }));
    }, () => { if (!result || rejections > 2) throw new ImportFailure("规划校验失败"); });
    return result!;
  }
  async generate(input: Parameters<ImportGenerator["generate"]>[0], save: Parameters<ImportGenerator["generate"]>[1]): Promise<void> {
    const collector = new ImportChunkCollector({ sourceId: input.fileId, reference: input.path }, save.entries, save.skipped);
    await this.run([
      "把片段中的编码规范逐条改写成规范库条目，一条对应原文一个条款，不合并、不拆散。原文编号写进 originalName。贴合原文，保留关键英文术语，用直白中文解释检查什么、为什么和怎么改。",
      "title 以关键英文术语开头（如有），中文部分简短。summary 用一句话说明问题与改法。body 完整表达条款。强制、必须、禁止映射 error；应当、推荐映射 warning；建议、可选映射 recommendation；无标记时按后果判断。",
      "经验总结和设计原则设 judgement=true，用可能的问题表述，写明依据和例外。原文没有代码示例时补写简短正反例；无法用代码表达的要求允许正反例为空。",
      "通过 submit_entries 每次提交 1 到 10 条，可多次调用。被拒绝时根据错误修正后重新提交，成功条目不要重复提交。最后必须通过 finish_chunk 提交 skipped 并结束。综述、目的说明不成条；所有未生成条目的原文条款都必须列入 skipped，以原文章节路径或首句定位并说明理由。",
      `片段数据：\n${JSON.stringify(input)}`,
    ].join("\n"), (ctx) => {
      ctx.tools.register(defineTool({ name: "submit_entries", description: "提交 1 到 10 个规范条目，接受后可继续分批提交。",
        parameters: { entries: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
          title: { type: "string", required: true }, originalName: { type: "string", required: true }, summary: { type: "string", required: true },
          body: { type: "string", required: true }, check: { type: "string", required: true }, why: { type: "string", required: true }, fix: { type: "string", required: true },
          goodExample: { type: "string", required: true }, badExample: { type: "string", required: true }, exampleLanguage: { type: "string", required: true },
          category: { type: "string", enum: ruleCategories, required: true }, severity: { type: "string", enum: ruleSeverities, required: true }, judgement: { type: "boolean", required: true },
        } } } }, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
        execute: (args) => collector.submit(args.entries),
      }));
      ctx.tools.register(defineTool({ name: "finish_chunk", description: "说明未生成条目的原文段落与理由，完成片段。没有条目时须至少说明一项跳过理由。",
        parameters: { skipped: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
          reference: { type: "string", required: true }, reason: { type: "string", required: true },
        } } } }, output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
        execute: (args) => collector.finish(args.skipped),
      }));
    }, () => { try { collector.complete(); } catch { throw new ImportFailure("未完成提交"); } });
  }
  private async run(prompt: string, register: (ctx: Context) => void, validate: () => void): Promise<void> {
    const model = typeof this.model === "function" ? await this.model() : this.model;
    if (!model) throw new ImportFailure("请先配置 Generator 模型");
    let handle: AgentHandle | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let identity = false, invalid = false, budget = false;
    let reason: TurnEndReason | undefined;
    try {
      handle = await this.ctx.agents.create({ sessionId: SessionId(`ureview-import-${randomUUID()}`), meta: { agentPreset: IMPORT_PRESET },
        agentOptions: { provider: model.provider, model: model.model, maxTokens: 16384 },
        setup: async (ctx, agent) => {
          await this.ctx.agentPresets.mount(ctx, IMPORT_PRESET); ctx.tools.restrict({ allow: [] }); register(ctx);
          let steps = 0;
          ctx.on("agent/pre-step", async (_payload, next) => { if (++steps <= 30) return next(); budget = true; agent.cancel({ kind: "hook", reason: "步骤预算用完" }); return { kind: "reject" }; });
          ctx.on("session/event", (_session, event) => {
            if (event.type === "request/header") { const route = event.data.header.config; if (route.provider !== model.provider || route.model !== model.model) invalid = true; else identity = true; }
            if (event.type === "turn/end") reason = event.data.reason;
          });
        },
      });
      handle.agent.followup(createUserMessage({ source: { kind: "ureview-import" }, content: [{ type: "text", text: prompt }] }));
      await Promise.race([handle.agent.whenIdle(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { handle?.agent.cancel({ kind: "user" }); reject(new ImportFailure("生成超时")); }, 600000); })]);
      if (budget) throw new ImportFailure("步骤预算用完");
      if (reason?.kind === "error") throw new ImportFailure("模型服务暂时不可用");
      if (reason?.kind !== "completed" || invalid || !identity) throw new ImportFailure("未完成提交");
      validate();
    } catch (error) { throw error instanceof ImportFailure ? error : new ImportFailure("模型服务暂时不可用"); }
    finally { clearTimeout(timer); await handle?.dispose(); }
  }
}
