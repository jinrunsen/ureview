import { Context } from "@deepseek-ai/cordis";
import CredentialProvider, { type CredentialRef, type CredentialRecord, type ResolvedCredential } from "@deepseek-ai/dsh-credentials";
import LlmRuntime, { LlmError, type LlmFailure } from "@deepseek-ai/dsh-llm";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import type { ReviewModel } from "./config.js";

export interface ModelConnectionInput {
  api: ReviewModel["api"];
  provider: string;
  model: string;
  baseURL: string;
  apiKey: string;
}
export interface ModelVerification { ok: boolean; code: string; message: string; latencyMs: number }
export type ModelProbe = (input: ModelConnectionInput) => Promise<ModelVerification>;

const credentialName = "UREVIEW_PROBE_KEY";
const messages: Record<string, string> = {
  verified: "模型连接验证通过。",
  invalid_config: "模型连接配置不完整或格式不正确。",
  authentication_failed: "模型服务认证失败，请检查 API key 及使用权限。",
  model_not_found: "模型不存在或当前密钥无权使用该模型，请检查模型名称。",
  rate_limited: "模型服务请求频率受限，请稍后重试。",
  timeout: "模型连接验证超时，请检查服务地址后重试。",
  security_plugin_required: "模型网关要求安装或更新安全插件。",
  protocol_error: "模型服务未返回有效响应，请检查接口地址和协议。",
  connection_failed: "暂时无法连接模型服务，请检查服务地址和网络。",
};

/** 探测凭据只在本次独立 Context 中可读，既不访问环境变量，也不写入凭据存储。 */
class ProbeCredentials extends CredentialProvider {
  constructor(ctx: Context, private readonly value: string) { super(ctx); }
  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return ref === credentialName ? { value: this.value, source: "model-probe" } : undefined;
  }
  async describe(ref: CredentialRef) { return { configured: ref === credentialName, writable: false }; }
  async set(): Promise<void> { throw new Error("探测凭据只读"); }
  async unset(): Promise<void> { throw new Error("探测凭据只读"); }
  async readRecord(): Promise<CredentialRecord | undefined> { return undefined; }
  async describeRecord() { return { configured: false, writable: false }; }
  async listRecords() { return []; }
  async modifyRecord(): Promise<CredentialRecord | undefined> { throw new Error("探测凭据只读"); }
  async deleteRecord(): Promise<void> { throw new Error("探测凭据只读"); }
}

function classify(failure: LlmFailure): string {
  if (/security_plugin_uninstalled|security_plugin_block/i.test(failure.message)) return "security_plugin_required";
  if (failure.code === "TIMEOUT" || failure.status === 408 || failure.status === 504) return "timeout";
  if (failure.code === "RATE_LIMIT" || failure.status === 429) return "rate_limited";
  if (failure.code === "AUTH" || failure.status === 401 || failure.status === 403) return "authentication_failed";
  if (/model[_ -]?not[_ -]?found|unknown[_ -]?model|invalid[_ -]?model|model[^\n]{0,100}(?:does not exist|not found|not available)/i.test(`${failure.code} ${failure.message}`)) return "model_not_found";
  if (["INVALID_REQUEST", "INVALID_RESPONSE", "EMPTY_RESPONSE", "NO_ADAPTER", "PI_AI_ERROR"].includes(failure.code) || failure.status === 400 || failure.status === 404) return "protocol_error";
  return "connection_failed";
}

function valid(input: ModelConnectionInput): boolean {
  if (!["anthropic-messages", "openai-completions", "openai-responses"].includes(input.api) || !input.provider || !input.model.trim() ||
    !input.apiKey.trim() || /[^\x21-\x7e]/.test(input.apiKey.trim())) return false;
  try {
    const url = new URL(input.baseURL);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export async function verifyModelConnection(input: ModelConnectionInput, timeoutMs = 30_000): Promise<ModelVerification> {
  const started = performance.now();
  const result = (code: string): ModelVerification => ({ ok: code === "verified", code, message: messages[code]!, latencyMs: Math.max(0, Math.round(performance.now() - started)) });
  if (!valid(input) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return result("invalid_config");
  const context = new Context(), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let code = "protocol_error";
  try {
    await context.plugin({ name: "ureview-probe-credentials", apply(ctx) { new ProbeCredentials(ctx, input.apiKey.trim()); } });
    await context.plugin(LlmRuntime);
    await context.plugin(PiAi, { providers: { [input.provider]: {
      api: input.api, baseURL: input.baseURL, apiKeyEnv: credentialName,
      models: [{ id: input.model, contextWindow: 131072, maxTokens: 8192, reasoningEfforts: false }],
      retryPolicy: { mode: "normal", maxRetries: 0 }, timeoutMs,
    } } });
    await context.plugin({ name: "ureview-model-probe", inject: ["llm"], async apply(ctx) {
      let hasContent = false;
      // 插件内收口供应商异常，避免 Cordis 输出包含响应正文的原始错误。
      try {
        for await (const chunk of ctx.llm.stream({ provider: input.provider, model: input.model,
          messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK." }] }], maxTokens: 64, signal: controller.signal })) {
          if ((chunk.type === "text-delta" || chunk.type === "reasoning-delta") && chunk.text.trim()) hasContent = true;
          if (chunk.type === "block-end" && (chunk.block.type === "text" || chunk.block.type === "reasoning") && chunk.block.text.trim()) hasContent = true;
          if (chunk.type === "finish") {
            code = chunk.reason.kind === "error" || chunk.reason.kind === "aborted" ? classify(chunk.reason.failure)
              // 小预算可能全部用于模型思考；正常到达 token 上限仍证明请求已被接受。
              : chunk.reason.kind === "max-tokens" || (hasContent && chunk.reason.kind === "stop") ? "verified" : "protocol_error";
          }
        }
      } catch (error) { code = error instanceof LlmError ? classify(error.failure) : "connection_failed"; }
    } });
  } catch { code = "invalid_config"; }
  finally {
    clearTimeout(timeout);
    try { await context.fiber.dispose(); } catch { code = "connection_failed"; }
  }
  return result(controller.signal.aborted ? "timeout" : code);
}
