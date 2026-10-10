import { DshImportGenerator, type ImportGenerator } from "./import-generator.js";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-agent-preset-registry";
import type {} from "@deepseek-ai/dsh-system-prompt";
import { ReviewError, type ReviewRuntime } from "../reviews/types.js";
import { modelProviderProfiles } from "./profile.js";
import type { ReviewModels } from "./config.js";
import { DshReviewRuntime } from "./review-runtime.js";
import { DshRuleDraftGenerator, type RuleDraftGenerator } from "./rule-generator.js";
import { RuleSessionCheckpointStore } from "./rule-session-checkpoint.js";
import { logEvent, failureCategory } from "../logging.js";
import type { SessionRecorder } from "./session-capture.js";

export interface HostBootstrap {
  models: ReviewModels | undefined;
  resolveModels?: () => Promise<ReviewModels | undefined>;
  sessionRecorder?: SessionRecorder;
  onReady: (runtime: ReviewRuntime, ruleGenerator: RuleDraftGenerator, importGenerator: ImportGenerator) => Promise<() => Promise<void>>;
  started: boolean;
}

declare module "@deepseek-ai/cordis" {
  interface Context { ureviewBootstrap: HostBootstrap }
}

export const name = "ureview-host";
export const inject = ["ureviewBootstrap", "agents", "agentPresets", "tools", "systemPrompt"];

export async function apply(ctx: Context): Promise<void> {
  const responseLanguage = {
    name: "deployment:response-language",
    text: "思考过程（reasoning）、中间说明、回答和解释必须使用简体中文。所有面向用户的自然语言内容，包括解读正文、文件分组名称和主题、finding 标题、问题描述、证据说明、修复提示词、评分解释、规范正文与示例注释，都使用简体中文。Mermaid 图中的说明文字使用简体中文。工具名、结构化字段名、枚举值、代码标识符、文件路径、URL 和原文引用保持原样，不要翻译；代码示例遵循对应语言的语法。",
  };
  ctx.effect(() => ctx.systemPrompt.section({
    ...responseLanguage, order: ctx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_SUFFIX"),
  }));
  // dsh 没有绝对末尾的排序值；在协作组装返回后固定公共语言段的位置。
  ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembly = await next();
    return { ...assembly, sections: [
      ...assembly.sections.filter((section) => section.name !== responseLanguage.name), responseLanguage,
    ] };
  }, { prepend: true });
  const bootstrap = ctx.ureviewBootstrap;
  ctx.on("session/event", (session, event) => {
    const fields = { sessionId: String(session.id), sequence: event.seq };
    if (event.type === "request/header") {
      const { provider, model } = event.data.header.config;
      logEvent("agent.request", { ...fields, provider, model });
    } else if (event.type === "tool/call") {
      logEvent("agent.tool", { ...fields, tool: event.data.name, callId: event.data.callId });
    } else if (event.type === "tool/result") {
      logEvent("agent.tool.result", { ...fields, callId: event.data.message.toolCallId,
        failed: Boolean(event.data.message.isError) });
    } else if (event.type === "turn/end") {
      const reason = event.data.reason;
      logEvent("agent.turn.end", { ...fields, reason: reason.kind,
        ...(reason.kind === "completed" ? {} : { category: failureCategory(JSON.stringify(reason)) }) });
    }
  });
  const providers = modelProviderProfiles(bootstrap.models);
  let updating = Promise.resolve();
  const resolveModels = async () => {
    const models = await bootstrap.resolveModels!();
    if (!models) return undefined;
    updating = updating.catch(() => {}).then(async () => {
      const missing = !providers[models.generator.provider] || !providers[models.grader.provider];
      if (missing) {
        const candidate = { ...providers, ...modelProviderProfiles(models) };
        const entry = [...ctx.loader.entries()].find((item) => item.options.name === "@deepseek-ai/dsh-llm-pi-ai");
        if (!entry) throw new ReviewError("runtime_unavailable", "无法找到模型连接插件");
        await entry.update({ config: { providers: candidate } });
        Object.assign(providers, candidate);
      }
    });
    await updating;
    return models;
  };
  const selection = bootstrap.resolveModels ? resolveModels : bootstrap.models;
  const runtime = new DshReviewRuntime(ctx, selection, bootstrap.sessionRecorder);
  const generator = new DshRuleDraftGenerator(ctx, bootstrap.resolveModels ? async () => (await resolveModels())?.generator : bootstrap.models?.generator,
    new RuleSessionCheckpointStore(ctx), bootstrap.sessionRecorder);
  const stop = await bootstrap.onReady(runtime, generator, new DshImportGenerator(ctx, bootstrap.resolveModels ? async () => (await resolveModels())?.generator : bootstrap.models?.generator));
  ctx.effect(() => stop);
  bootstrap.started = true;
}
