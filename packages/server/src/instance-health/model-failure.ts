import type { ModelFailureCode } from "./types.js";

const codes: ReadonlySet<string> = new Set<ModelFailureCode>(["invalid_config", "authentication_failed", "model_not_found",
  "rate_limited", "timeout", "security_plugin_required", "protocol_error", "connection_failed"]);

/** 历史仅输出模型验证使用的安全分类，不返回供应商异常正文。 */
export function modelFailureCode(code: string | null): ModelFailureCode {
  if (code !== null && codes.has(code)) return code as ModelFailureCode;
  if (code === "invalid_model_config" || code === "model_unconfigured") return "invalid_config";
  return "protocol_error";
}
