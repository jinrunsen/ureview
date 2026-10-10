export function ssoConnectionMessage(result: Record<string, unknown>): string {
  if (result.ok === true) return `身份源可达。${typeof result.authorizationEndpoint === "string" && typeof result.tokenEndpoint === "string" ? `授权端点：${result.authorizationEndpoint}；令牌端点：${result.tokenEndpoint}` : ""}`;
  if (result.code === "invalid_discovery") return "身份源的 discovery 内容无效，请检查文档格式和端点。";
  if (result.code === "issuer_mismatch" && typeof result.discoveredIssuer === "string") return `Issuer 与身份源返回的值不一致。身份源返回：${result.discoveredIssuer}。请核对地址及末尾斜杠。`;
  return "无法访问统一认证，请检查地址和网络。";
}
