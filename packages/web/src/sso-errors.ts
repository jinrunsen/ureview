export const ssoErrors: Record<string, string> = {
  disabled: "企业登录未启用。",
  expired: "登录已过期或来源不一致，请重新登录。",
  denied: "身份源拒绝了登录。",
  unavailable: "无法连接统一认证，请稍后重试。",
  missing_identity: "统一认证未返回用户标识，请联系管理员。",
  no_team: "账号尚未加入团队，请联系管理员。",
};
export function consumeSsoError(): string {
  const url = new URL(window.location.href);
  const error = url.searchParams.get("sso_error");
  if (error === null) return "";
  url.searchParams.delete("sso_error");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  return Object.hasOwn(ssoErrors, error) ? ssoErrors[error]! : "企业登录未完成，请重新登录。";
}
