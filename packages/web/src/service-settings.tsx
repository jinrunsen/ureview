import { useEffect, useRef, useState } from "react";
import { ApiError, isRecord, request } from "./api";
import { useSession } from "./auth";
import { revealModelKey, verifyModelConnection, type ModelPhase, type ModelVerification } from "./service-settings-api";
import "./service-settings.css";

interface ModelInfo { configured: boolean; source: string; model: string; baseURL: string }
interface Settings { version: number; generator: ModelInfo; grader: ModelInfo }
interface ConnectionDraft { model: string; baseURL: string; apiKey: string }
interface ServiceUser { id: string; username: string; email: string | null; name: string; serviceRole: "user" | "service_admin" }
function isSettings(value: unknown): value is { settings: Settings } {
  if (!isRecord(value) || !isRecord(value.settings)) return false;
  const s = value.settings;
  return typeof s.version === "number" && [s.generator, s.grader].every((m) => isRecord(m) && typeof m.configured === "boolean" && [m.model, m.baseURL, m.source].every((v) => typeof v === "string"));
}
function isUsers(value: unknown): value is { users: ServiceUser[] } {
  return isRecord(value) && Array.isArray(value.users) && value.users.every((u) => isRecord(u) && [u.id, u.name, u.username].every((v) => typeof v === "string") && (u.email === null || typeof u.email === "string") && ["user", "service_admin"].includes(String(u.serviceRole)));
}
const message = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请重试。";
const noAccess = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 403);

function ModelConnectionFields({ phase, model, version, draft, onChange, onNoAccess, onHealthChanged }: {
  phase: ModelPhase; model: ModelInfo; version: number; draft: ConnectionDraft;
  onChange: (draft: ConnectionDraft) => void; onNoAccess: (cause: unknown) => void;
  onHealthChanged?: () => void;
}) {
  const title = phase === "generator" ? "Generator" : "Grader";
  const [visible, setVisible] = useState(false);
  const [savedKey, setSavedKey] = useState("");
  const [revealing, setRevealing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const [verification, setVerification] = useState<ModelVerification>();
  const keyInput = useRef<HTMLInputElement>(null);
  const requests = useRef({ revision: 0, reveal: undefined as AbortController | undefined, verify: undefined as AbortController | undefined });
  useEffect(() => () => {
    requests.current.revision += 1;
    requests.current.reveal?.abort(); requests.current.verify?.abort();
  }, []);
  function clearPending() {
    requests.current.revision += 1;
    requests.current.reveal?.abort(); requests.current.verify?.abort();
    setRevealing(false); setVerifying(false); setVerification(undefined); setError("");
  }
  function change(field: keyof ConnectionDraft, value: string) {
    clearPending(); setSavedKey("");
    if (!draft.apiKey || (field === "apiKey" && !value)) setVisible(false);
    onChange({ ...draft, [field]: value });
  }
  async function toggleKey() {
    if (revealing) return;
    setError("");
    if (visible) { setVisible(false); setSavedKey(""); return; }
    if (draft.apiKey) { setVisible(true); return; }
    if (!model.configured) return;
    const revision = requests.current.revision;
    const controller = new AbortController(); requests.current.reveal = controller;
    setRevealing(true);
    try {
      const result = await revealModelKey(phase, version, controller.signal);
      if (revision !== requests.current.revision) return;
      setSavedKey(result.apiKey); setVisible(true);
    } catch (cause) {
      if (revision !== requests.current.revision) return;
      if (noAccess(cause)) { clearPending(); setSavedKey(""); onNoAccess(cause); }
      else setError(message(cause));
    } finally { if (revision === requests.current.revision) setRevealing(false); }
  }
  async function verify() {
    if (verifying || !draft.model.trim() || !draft.baseURL.trim()) return;
    const revision = requests.current.revision;
    const controller = new AbortController(); requests.current.verify = controller;
    setVerifying(true); setVerification(undefined); setError("");
    try {
      const result = await verifyModelConnection(phase, { version, ...draft }, controller.signal);
      if (revision === requests.current.revision) { setVerification(result.verification); onHealthChanged?.(); }
    } catch (cause) {
      if (revision !== requests.current.revision) return;
      if (noAccess(cause)) { clearPending(); setSavedKey(""); onNoAccess(cause); }
      else setError(message(cause));
    } finally { if (revision === requests.current.revision) setVerifying(false); }
  }
  const showingSavedKey = visible && !draft.apiKey && !!savedKey;
  return <section className="service-model-card" aria-labelledby={`service-${phase}-title`}>
    <h3 id={`service-${phase}-title`}>{title}</h3>
    <label htmlFor={`service-${phase}-model`}>模型名称</label>
    <input id={`service-${phase}-model`} required maxLength={256} value={draft.model} onChange={(event) => change("model", event.target.value)} />
    <label htmlFor={`service-${phase}-url`}>Base URL</label>
    <input id={`service-${phase}-url`} type="url" required maxLength={2048} value={draft.baseURL} onChange={(event) => change("baseURL", event.target.value)} />
    <label htmlFor={`service-${phase}-key`}>API key</label>
    <p id={`service-${phase}-key-status`} className="field-hint">{model.configured ? "已配置" : "未配置"}{model.source === "database" ? "（页面配置）" : model.source === "environment" ? "（环境变量）" : ""}{draft.apiKey ? " · 新密钥尚未保存" : ""}</p>
    <div className="service-model-key">
      <input ref={keyInput} id={`service-${phase}-key`} type={visible ? "text" : "password"} autoComplete="new-password" autoCapitalize="none" spellCheck={false} maxLength={4096}
        aria-describedby={`service-${phase}-key-status service-${phase}-key-hint`} readOnly={showingSavedKey}
        value={draft.apiKey || (showingSavedKey ? savedKey : "")} onChange={(event) => change("apiKey", event.target.value)}
        placeholder={model.configured ? "••••••••••••••••" : "输入 API key"} />
      <button type="button" className="button secondary-button" aria-label={`${visible ? "隐藏" : "显示"} ${title} API key`} aria-pressed={visible}
        aria-controls={`service-${phase}-key`} disabled={revealing || (!model.configured && !draft.apiKey)} onClick={() => void toggleKey()}>{revealing ? "读取中…" : visible ? "隐藏" : "显示"}</button>
    </div>
    {showingSavedKey && <button type="button" className="text-button service-model-replace" onClick={() => { clearPending(); setSavedKey(""); setVisible(false); keyInput.current?.focus(); }}>替换 API key</button>}
    <p id={`service-${phase}-key-hint`} className="field-hint">{showingSavedKey ? "正在显示已保存的密钥。" : "输入新密钥可替换，留空保留已保存的密钥。"}</p>
    <div className="service-model-verify">
      <button type="button" className="button secondary-button" aria-label={`验证 ${title} API key`} disabled={verifying || !draft.model.trim() || !draft.baseURL.trim() || (!model.configured && !draft.apiKey.trim())}
        onClick={() => void verify()}>{verifying ? "正在验证…" : "验证 API key"}</button>
      <p className="field-hint">使用当前填写的模型和地址发送少量测试内容，不包含仓库代码。验证不会保存配置。</p>
    </div>
    {verification && <p role="status" className={`feedback service-model-result ${verification.ok ? "is-success" : "feedback-error"}`}>
      {verification.message}<small>耗时 {(verification.latencyMs / 1000).toFixed(2)} 秒{draft.apiKey.trim() ? " · 使用待保存的新密钥" : " · 使用已保存的密钥"}</small>
    </p>}
    {error && <p role="alert" className="feedback feedback-error service-model-result">{error}</p>}
  </section>;
}

export function ServiceConfiguration({ onHealthChanged }: { onHealthChanged?: () => void }) {
  const { user: currentUser } = useSession();
  const [settings, setSettings] = useState<Settings>();
  const [users, setUsers] = useState<ServiceUser[]>([]);
  const [connections, setConnections] = useState<Record<ModelPhase, ConnectionDraft>>({ generator: { model: "", baseURL: "", apiKey: "" }, grader: { model: "", baseURL: "", apiKey: "" } });
  const [keyRevision, setKeyRevision] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  function fail(cause: unknown) {
    setError(message(cause));
    if (noAccess(cause)) {
      setSettings(undefined); setUsers([]); setSaved(false); setKeyRevision((revision) => revision + 1);
      setConnections({ generator: { model: "", baseURL: "", apiKey: "" }, grader: { model: "", baseURL: "", apiKey: "" } });
    }
  }
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void Promise.all([request("/api/service-settings", isSettings, { signal: controller.signal }), request("/api/service-users", isUsers, { signal: controller.signal })])
      .then(([config, accounts]) => {
        if (!active) return;
        setSettings(config.settings); setUsers(accounts.users);
        setConnections({ generator: { model: config.settings.generator.model, baseURL: config.settings.generator.baseURL, apiKey: "" }, grader: { model: config.settings.grader.model, baseURL: config.settings.grader.baseURL, apiKey: "" } });
      }).catch((cause) => { if (active) fail(cause); });
    return () => { active = false; controller.abort(); };
  }, []);
  async function save() {
    if (!settings || busy) return;
    setBusy(true); setError(""); setSaved(false); setKeyRevision((revision) => revision + 1);
    try {
      const result = await request("/api/service-settings", isSettings, { method: "PUT", body: JSON.stringify({ version: settings.version,
        generatorApiKey: connections.generator.apiKey, graderApiKey: connections.grader.apiKey,
        generatorModel: connections.generator.model, generatorBaseURL: connections.generator.baseURL, graderModel: connections.grader.model, graderBaseURL: connections.grader.baseURL }) });
      setSettings(result.settings);
      setConnections({ generator: { model: result.settings.generator.model, baseURL: result.settings.generator.baseURL, apiKey: "" }, grader: { model: result.settings.grader.model, baseURL: result.settings.grader.baseURL, apiKey: "" } });
      setSaved(true);
      onHealthChanged?.();
    } catch (cause) { fail(cause); }
    finally { setBusy(false); }
  }
  async function changeRole(user: ServiceUser) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await request(`/api/service-users/${encodeURIComponent(user.id)}`, isRecord, { method: "PUT", body: JSON.stringify({ role: user.serviceRole === "service_admin" ? "user" : "service_admin" }) });
      if (user.id === currentUser?.userId && user.serviceRole === "service_admin") { window.location.assign("/?account=1"); return; }
      setUsers((await request("/api/service-users", isUsers)).users);
    } catch (cause) { fail(cause); }
    finally { setBusy(false); }
  }
  return <div><p>服务配置适用于整个实例的所有团队。模型连接保存到数据库，API key 加密保存。</p>
    {!settings && !error && <p role="status">正在加载服务配置…</p>}
    {settings && <form className="service-settings-form" onSubmit={(event) => { event.preventDefault(); void save(); }}><fieldset disabled={busy} className="service-model-fields">
      {(["generator", "grader"] as const).map((phase) => <ModelConnectionFields key={`${phase}:${keyRevision}`} phase={phase} model={settings[phase]} version={settings.version} draft={connections[phase]}
        onChange={(draft) => { setConnections((current) => ({ ...current, [phase]: draft })); setSaved(false); }} onNoAccess={fail} onHealthChanged={onHealthChanged} />)}
      <p className="field-hint">新会话使用新的模型和地址，API key 用于后续模型请求。API key 留空保留现有密钥。</p>
      <button className="button primary-button" type="submit" disabled={busy}>{busy ? "正在处理…" : "保存模型配置"}</button>
    </fieldset></form>}
    {saved && <p role="status" className="feedback">模型配置已保存。</p>}
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}
    {!!settings && <><h3>服务管理员</h3><p className="muted">服务权限与团队角色分别设置。至少保留一名服务管理员。</p>
      <div className="service-settings-users"><table className="team-table"><thead><tr><th>账号</th><th>服务角色</th><th>操作</th></tr></thead><tbody>{users.map((u) => <tr key={u.id}><td>{u.name}<br /><span className="muted">{u.username}</span>{u.email && <><br /><span className="muted">{u.email}</span></>}</td><td>{u.serviceRole === "service_admin" ? "服务管理员" : "普通用户"}</td><td><button type="button" className="text-button" disabled={busy} onClick={() => void changeRole(u)}>{u.serviceRole === "service_admin" ? "取消授权" : "设为服务管理员"}</button></td></tr>)}</tbody></table></div></>}
  </div>;
}
