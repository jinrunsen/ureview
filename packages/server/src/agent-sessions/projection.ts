import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { failureCategory } from "../logging.js";

declare module "@deepseek-ai/dsh-session/types" {
  interface SessionEventMap { "ureview/hidden": { reason: string } }
}

const privateField = /^(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?token|password|credential(?:s|ref)?|replayState|headers|rawRequest|rawResponse)$/i;

export function redactSessionText(text: string): string {
  return text
    .replace(/\b(?:sk-|glpat-)[A-Za-z0-9_.-]{8,}/g, "[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=_:.-]+/gi, "$1 [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?token|password|authorization)["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, "$1[redacted]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@");
}

function scrub(value: unknown): unknown {
  if (typeof value === "string") return redactSessionText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !privateField.test(key)).map(([key, item]) => [key, scrub(item)]));
  }
  return value;
}

const safeFailures: Record<string, string> = {
  security_plugin_required: "模型网关要求安装安全插件。",
  authentication_failed: "模型服务认证失败。",
  rate_limited: "模型服务请求频率受限。",
  timeout: "模型请求超时。",
  operation_failed: "模型请求失败。",
};

/**
 * dsh 压缩事件的展示字段，供对话视图展开压缩摘要和被替换的范围。
 * 摘要请求的原始输出不保留，失败只记一句通用说明。
 */
const compactionFields: Record<string, string[]> = {
  "compaction/start": ["compactionId", "sourceCommandId", "turn"],
  "compaction/summary": ["compactionId", "sourceCommandId", "summary", "shadowedRange", "shadowedSeqs", "shadowedTokenCount",
    "provider", "model", "usage"],
  "compaction/end": ["compactionId", "sourceCommandId", "turn"],
};

/** 展示副本保留事件位置；凭据和供应商私有重放数据不进入历史记录。 */
export function projectSessionEvent(event: SessionEvent): SessionEvent {
  let data: unknown;
  switch (event.type) {
    case "turn/start": case "step/start": case "step/end": case "session/end-seed":
      data = event.data; break;
    case "turn/end": {
      const reason = event.data.reason;
      if (reason.kind === "error") {
        const code = failureCategory(new Error(reason.error.message));
        data = { turn: event.data.turn, reason: { kind: "error", error: { code, message: safeFailures[code] } } };
      } else if (reason.kind === "aborted") {
        data = { turn: event.data.turn, reason: { kind: "aborted", reason: { kind: reason.reason.kind,
          ...(reason.reason.kind === "hook" ? { reason: "会话已取消。" } : {}) } } };
      } else data = event.data;
      break;
    }
    case "request/header": {
      const { config, tools } = event.data.header;
      data = { header: { config: { provider: config.provider, model: config.model,
        ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}) }, ...(tools ? { tools } : {}) },
        reason: event.data.reason, ...(event.data.startsSeries ? { startsSeries: true } : {}) };
      break;
    }
    case "user/message": data = event.data; break;
    case "developer/message": case "system/message":
      data = { turn: event.data.turn, step: event.data.step, message: event.data.message,
        ...("headerSeq" in event.data ? { headerSeq: event.data.headerSeq } : {}) }; break;
    case "assistant/message":
      data = { turn: event.data.turn, step: event.data.step, message: event.data.message, stream: [],
        ...(event.data.usage ? { usage: event.data.usage } : {}), ...(event.data.interrupted ? { interrupted: true } : {}) }; break;
    case "assistant/attempt": data = { turn: event.data.turn, step: event.data.step, stream: [] }; break;
    case "tool/call": data = { turn: event.data.turn, step: event.data.step, callId: event.data.callId,
      name: event.data.name, arguments: event.data.arguments }; break;
    case "tool/result": data = { turn: event.data.turn, step: event.data.step, message: event.data.message }; break;
    default: {
      const fields = compactionFields[event.type];
      if (!fields) {
        return { type: "ureview/hidden", seq: event.seq, time: event.time, data: { reason: "此事件不包含可展示的会话内容。" }, ignorable: true };
      }
      const source = event.data as Record<string, unknown>;
      data = { ...Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])),
        ...(source.error ? { error: "上下文压缩失败。" } : {}) };
    }
  }
  return { type: event.type, seq: event.seq, time: event.time, data: scrub(data),
    ...(event.ignorable ? { ignorable: true } : {}), ...(event.surfaceOp ? { surfaceOp: event.surfaceOp } : {}),
    ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs } : {}) } as SessionEvent;
}
