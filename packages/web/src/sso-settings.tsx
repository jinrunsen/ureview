import { useEffect, useRef, useState } from "react";
import { isRecord, request } from "./api";
import { ssoConnectionMessage } from "./sso-connection";

interface Configuration {
  enabled: boolean; protocol: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string;
  clientId: string; scope: string; tokenAuthMethod: string; buttonLabel: string; subjectField: string; usernameField: string;
  nameField: string; emailField: string; linking: string; defaultTeamId: string; passwordLogin: string;
}
interface View { configuration: Configuration; version: number; secretConfigured: boolean; callbackUrl: string; teams: { id: string; name: string }[] }
function isView(value: unknown): value is View {
  if (!isRecord(value) || !isRecord(value.configuration)) return false;
  const configuration = value.configuration;
  return typeof configuration.enabled === "boolean"
    && ["protocol", "issuer", "authorizationEndpoint", "tokenEndpoint", "userinfoEndpoint", "clientId", "scope", "tokenAuthMethod", "buttonLabel", "subjectField", "usernameField", "nameField", "emailField", "linking", "defaultTeamId", "passwordLogin"].every((key) => typeof configuration[key] === "string")
    && Number.isSafeInteger(value.version) && typeof value.secretConfigured === "boolean" && typeof value.callbackUrl === "string"
    && Array.isArray(value.teams) && value.teams.every((team) => isRecord(team) && typeof team.id === "string" && typeof team.name === "string");
}
export function SsoSettings() {
  const callbackInput = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<View>();
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void request("/api/service-sso", isView, { signal: controller.signal }).then(setView).catch((cause) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, []);
  function change(key: keyof Configuration, value: string | boolean) {
    setView((current) => current && { ...current, configuration: { ...current.configuration, [key]: value } }); setNotice("");
  }
  async function save() {
    if (!view) return;
    setBusy(true); setError(""); setNotice("");
    try { setView(await request("/api/service-sso", isView, { method: "PUT", body: JSON.stringify({ configuration: view.configuration, version: view.version, clientSecret: secret }) })); setSecret(""); setNotice("企业登录配置已保存。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function test() {
    if (!view) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await request("/api/service-sso/test", isRecord, { method: "POST", body: JSON.stringify(view.configuration) });
      setNotice(ssoConnectionMessage(result));
    } catch { setError("无法访问统一认证，请检查地址和网络。"); }
    finally { setBusy(false); }
  }
  async function copyCallback() {
    if (!view) return;
    setError(""); setNotice("");
    try {
      if (navigator.clipboard) await navigator.clipboard.writeText(view.callbackUrl);
      else {
        callbackInput.current?.select();
        if (!document.execCommand("copy")) throw new Error("复制失败");
      }
      setNotice("回调地址已复制。");
    } catch {
      callbackInput.current?.focus();
      callbackInput.current?.select();
      setError("复制失败，请手动复制回调地址。");
    }
  }
  const config = view?.configuration;
  const field = (key: keyof Configuration, label: string) => <label key={key}>{label}<input value={String(config?.[key] ?? "")} maxLength={key === "buttonLabel" ? 40 : 2048} onChange={(event) => change(key, event.target.value)} /></label>;
  const select = (key: keyof Configuration, label: string, choices: [string, string][]) => <label>{label}<select value={String(config?.[key])} onChange={(event) => change(key, event.target.value)}>{choices.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>;
  return <section className="panel settings-content"><div className="panel-heading"><h2>企业账号登录</h2></div><div className="panel-body">
    {view && config && <form className="service-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset disabled={busy} className="service-model-card">
      <label><input type="checkbox" checked={config.enabled} onChange={(event) => change("enabled", event.target.checked)} />启用企业账号登录</label>
      <label>协议<select value={config.protocol} onChange={(event) => {
        setNotice("");
        const oidc = event.target.value === "oidc";
        setView({ ...view, configuration: { ...config, protocol: event.target.value, scope: oidc ? "openid profile email" : "", tokenAuthMethod: oidc ? "client_secret_basic" : "client_secret_post", subjectField: oidc ? "sub" : "", usernameField: oidc ? "preferred_username" : "", nameField: oidc ? "name" : "", emailField: oidc ? "email" : "" } });
      }}><option value="oidc">OIDC</option><option value="oauth2">OAuth2</option></select></label>
      {config.protocol === "oidc" ? field("issuer", "Issuer") : <>{field("authorizationEndpoint", "授权端点")}{field("tokenEndpoint", "令牌端点")}{field("userinfoEndpoint", "用户信息端点")}</>}
      {field("clientId", "Client ID")}<label>Client Secret<input type="password" autoComplete="new-password" maxLength={4096} value={secret} placeholder={view.secretConfigured ? "已配置，留空不修改" : "未配置"} onChange={(event) => { setSecret(event.target.value); setNotice(""); }} /></label>
      {field("scope", "scope")}{select("tokenAuthMethod", "令牌端点认证方式", [["client_secret_basic", "client_secret_basic"], ["client_secret_post", "client_secret_post"]])}
      {field("subjectField", "唯一标识字段")}{field("usernameField", "用户名字段")}{field("nameField", "姓名字段")}{field("emailField", "邮箱字段")}
      {select("linking", "账号关联方式", [["username", "按用户名"], ["email", "按邮箱"], ["none", "不关联"]])}
      {select("defaultTeamId", "新账号默认团队", [["", "请选择团队"], ...view.teams.map((team): [string, string] => [team.id, team.name])])}
      {field("buttonLabel", "登录按钮文案")}{select("passwordLogin", "密码登录范围", [["all", "全部账号"], ["service_admin", "仅服务管理员"]])}
      <label>回调地址<input ref={callbackInput} readOnly value={view.callbackUrl} /></label><button type="button" className="button secondary-button" onClick={() => void copyCallback()}>复制回调地址</button>
      <button type="button" className="button secondary-button" onClick={() => void test()}>测试连接</button><p className="field-hint">使用当前填写的地址测试可达性，不验证凭据，不保存配置。</p>
      <button type="submit" className="button primary-button">保存企业登录配置</button>
    </fieldset></form>}
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}{notice && <p role="status" className="feedback">{notice}</p>}
  </div></section>;
}
