import { ReviewError } from "./reviews/types.js";

type LogFields = Record<string, string | number | boolean | undefined>;

export function logEvent(event: string, fields: LogFields = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

// 上游错误可能附带请求头和响应正文，只输出可枚举的故障分类。
export function failureCategory(error: unknown): string {
  if (error instanceof ReviewError && error.diagnostic.causeCategory) return error.diagnostic.causeCategory;
  const text = error instanceof Error ? error.message : String(error);
  if (/security_plugin_uninstalled|security_plugin_block/.test(text)) return "security_plugin_required";
  if (/401|unauthorized/i.test(text)) return "authentication_failed";
  if (/429|rate.limit/i.test(text)) return "rate_limited";
  if (/timeout|timed.out/i.test(text)) return "timeout";
  return "operation_failed";
}
