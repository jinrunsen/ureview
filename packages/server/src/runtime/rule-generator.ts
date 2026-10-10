import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, type TurnEndReason } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ReviewError } from "../reviews/types.js";
import { ruleLayers, ruleLanguages } from "../rules/metadata.js";
import { ruleCategories, ruleSeverities, validateGeneratedRuleDraft, type GeneratedRuleDraft } from "../rules/managed-types.js";
import type { RuleConversationGenerator } from "../rules/sessions-types.js";
import type { ReviewModel } from "./config.js";
import { RULE_GENERATION_PRESET } from "./profile.js";
import { RuleSessionCheckpointStore, type RuleSessionCheckpoint } from "./rule-session-checkpoint.js";
import { captureSession, type SessionRecorder } from "./session-capture.js";

export type RuleConversationInput = Parameters<RuleConversationGenerator["continue"]>[0];
export interface RuleConversationOutput { draft: GeneratedRuleDraft; reply: string; checkpoint: RuleSessionCheckpoint }
export interface RuleDraftGenerator extends RuleConversationGenerator {
  generate(intent: string): Promise<GeneratedRuleDraft>;
  continue(input: RuleConversationInput): Promise<RuleConversationOutput>;
}
export const RULE_GENERATION_TIMEOUT_MS = 60_000;

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap { "ureview-rule-generation": { kind: "ureview-rule-generation" } }
}

export class DshRuleDraftGenerator implements RuleDraftGenerator {
  constructor(private readonly ctx: Context, private readonly model: ReviewModel | undefined | (() => Promise<ReviewModel | undefined>),
    private readonly checkpoints: RuleSessionCheckpointStore, private readonly recorder?: SessionRecorder) {}

  async generate(intent: string): Promise<GeneratedRuleDraft> {
    return (await this.continue({ sessionId: `ureview-rule-${randomUUID()}`, message: intent })).draft;
  }

  async continue(input: RuleConversationInput): Promise<RuleConversationOutput> {
    if (!input.message.trim() || input.message.trim().length > 4000) throw new ReviewError("invalid_rule_intent", "请用 1–4000 个字符描述规则意图");
    if (!/^ureview-rule-[a-zA-Z0-9-]{1,100}$/.test(input.sessionId)) throw new ReviewError("invalid_rule_session", "规范会话标识无效");
    const model = typeof this.model === "function" ? await this.model() : this.model;
    if (!model) throw new ReviewError("models_not_configured", "请先配置 Generator 模型");
    const sessionId = SessionId(input.sessionId);
    let draft: GeneratedRuleDraft | undefined;
    let failed = false;
    let identityVerified = false;
    let endReason: TurnEndReason | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const replies: string[] = [];
    let handle: AgentHandle | undefined;
    let acquired = false;
    let recording: Awaited<ReturnType<typeof captureSession>>;
    let failure: unknown;
    try {
      this.checkpoints.acquire(sessionId, input.checkpoint);
      acquired = true;
      if (input.ruleSessionId) recording = await captureSession(this.ctx, this.recorder, {
        dshSessionId: sessionId, ruleSessionId: input.ruleSessionId, kind: "rule_generation", provider: model.provider, model: model.model,
      }, input.checkpoint === undefined ? [] : this.checkpoints.exportCheckpoint(sessionId).events,
      () => this.checkpoints.exportCheckpoint(sessionId).events);
      const options = {
        agentOptions: { provider: model.provider, model: model.model, maxTokens: 4096 },
        setup: async (agentCtx: Context) => {
          await this.ctx.agentPresets.mount(agentCtx, RULE_GENERATION_PRESET);
          agentCtx.tools.restrict({ allow: [] });
          agentCtx.tools.register(defineTool({
            name: "submit_rule", description: "提交一次规范草稿，包含清晰名称、可执行的规范正文、合规和违规代码示例、类别与严重度。",
            parameters: {
              name: { type: "string", required: true }, body: { type: "string", required: true },
              goodExample: { type: "string", required: true }, badExample: { type: "string", required: true },
              category: { type: "string", enum: ruleCategories, required: true },
              severity: { type: "string", enum: ruleSeverities, required: true },
              judgement: { type: "boolean", description: "代码坏味道等启发式规范设为 true；判断题命中最高为中危。" },
              layer: { type: "string", enum: ruleLayers, required: true },
              languages: { type: "array", items: { type: "string", enum: ruleLanguages }, required: true },
            },
            output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
            execute: async (args) => {
              try {
                if (draft) throw new Error("重复草稿");
                draft = validateGeneratedRuleDraft(args);
                return "草稿已生成，请结束本轮";
              } catch {
                failed = true;
                throw new ReviewError("invalid_rule_draft", "模型生成的规范草稿未通过校验");
              }
            },
          }));
          agentCtx.on("session/event", (_session, event) => {
            if (event.type === "turn/end") endReason = event.data.reason;
            if (event.type === "request/header") {
              const route = event.data.header.config;
              if (route.provider !== model.provider || route.model !== model.model) failed = true;
              else identityVerified = true;
            }
            if (event.type === "tool/call" && event.data.name !== "submit_rule") failed = true;
            if (event.type === "tool/result" && event.data.message.isError) failed = true;
            if (event.type === "assistant/message") {
              const text = event.data.message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
              if (text.trim()) replies.push(text.trim());
            }
          });
        },
      };
      handle = input.checkpoint === undefined
        ? await this.ctx.agents.create({ ...options, sessionId, meta: { agentPreset: RULE_GENERATION_PRESET } })
        : await this.ctx.agents.resume({ ...options, resumeSessionId: sessionId });
      const currentDraft = input.draft;
      handle.agent.followup(createUserMessage({ source: { kind: "ureview-rule-generation" }, content: [{ type: "text", text:
        `根据本次请求及已有对话生成或调整团队代码规范。currentDraft 若存在，表示用户当前编辑的完整草稿。正文描述可核查的约束，提供简短合规和违规代码示例，通过 submit_rule 提交一次完整草稿，再用简短文字说明本轮调整并结束。请建议层级：principle 为设计原则，general 为通用规范，language 为语言规范，team 为团队约定。languages 选择适用语言，留空适用全部语言。代码坏味道等启发式规范设 judgement=true，以「可能的 X」表述，写明依据与例外情形，severity 使用 warning 或 recommendation；与团队规范冲突时以团队规范为准。其他规范 judgement=false。规则草稿不会自动启用。\n${JSON.stringify({ message: input.message.trim(), ...(currentDraft ? { currentDraft } : {}) })}` }] }));
      await Promise.race([handle.agent.whenIdle(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          handle?.agent.cancel({ kind: "user" });
          reject(new ReviewError("rule_generation_timeout", "规范生成超过 60 秒，请稍后重试"));
        }, RULE_GENERATION_TIMEOUT_MS);
      })]);
      if (endReason?.kind === "error" && ["TRANSPORT", "TIMEOUT", "SERVER", "RATE_LIMIT", "EMPTY_RESPONSE"].includes(endReason.error.code)) {
        throw new ReviewError("rule_model_unavailable", "模型服务暂时不可用，请稍后重试");
      }
      if (endReason?.kind !== "completed") throw new ReviewError("rule_generation_failed", "规范生成未完成，请检查模型连接后重试");
      if (failed || !identityVerified || !draft) throw new ReviewError("invalid_rule_draft", "模型未返回有效的规范草稿，请重试");
      await handle.dispose();
      handle = undefined;
      return { draft, reply: replies.join("\n\n") || "草稿已更新。", checkpoint: this.checkpoints.exportCheckpoint(sessionId) };
    } catch (error) {
      failure = error;
      if (error instanceof ReviewError) throw error;
      throw new ReviewError("rule_generation_failed", "规范生成未完成，请稍后重试");
    } finally {
      clearTimeout(timer);
      try {
        try { await handle?.dispose(); } finally { await recording?.close(failure); }
      } catch {
        throw new ReviewError("rule_generation_failed", "规范会话释放失败，请稍后重试");
      } finally {
        if (acquired) this.checkpoints.release(sessionId);
      }
    }
  }
}
