import { SsoSettings } from "./sso-settings";
import { useEffect, useState, type FormEvent } from "react";
import { AppHeader } from "./layout";
import { useSession } from "./auth";
import { changePassword, logout } from "./auth-api";
import { NotificationSettings } from "./notification-settings";
import { IdentityEditor } from "./identity-settings";
import { ServiceConfiguration } from "./service-settings";
import { InstanceHealthSection } from "./instance-health";

export type SettingsSection = "account" | "team" | "instance";
const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作未完成，请重试。";

export function LegacySettingsRedirect() {
  const { user, hasPassword } = useSession();
  const destination = user?.serviceRole === "service_admin" ? "/?instance=1" : user?.role === "admin" ? "/?team-settings=1" : "/?account=1";
  useEffect(() => { window.location.replace(destination); }, [destination]);
  return <main><p role="status">正在打开设置…</p></main>;
}

function AccountSettings() {
  const { user, hasPassword } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget, data = new FormData(form);
    setBusy(true); setError(""); setNotice("");
    try {
      await changePassword({ currentPassword: String(data.get("currentPassword")), newPassword: String(data.get("newPassword")) });
      form.reset(); setNotice("密码已修改，其他设备已退出登录。");
    } catch (cause) { setError(message(cause)); }
    finally { setBusy(false); }
  }
  async function signOut() {
    if (busy) return;
    setBusy(true); setError("");
    try { await logout(); window.location.assign("/"); }
    catch (cause) { setError(message(cause)); setBusy(false); }
  }
  return <>
    <section className="panel settings-content"><div className="panel-heading"><h2>账号信息</h2></div><div className="panel-body">
      <div className="account-summary"><span className="avatar">{user?.name.slice(0, 1)}</span><div><h2>{user?.name}</h2><p className="muted">用户名：{user?.username}</p><p className="muted">邮箱：{user?.email ?? "未填写"}</p></div></div>
      <dl className="settings-facts"><div><dt>当前团队</dt><dd>{user?.teamName}</dd></div><div><dt>团队角色</dt><dd>{user?.role === "admin" ? "管理员" : "成员"}</dd></div><div><dt>服务角色</dt><dd>{user?.serviceRole === "service_admin" ? "服务管理员" : "普通用户"}</dd></div></dl>
      <button type="button" className="button secondary-button" disabled={busy} onClick={() => void signOut()}>退出登录</button>
    </div></section>
    <IdentityEditor />
    {hasPassword !== false && <section className="panel settings-content"><div className="panel-heading"><h2>修改密码</h2></div><form className="panel-body account-password-form" onSubmit={(event) => void submit(event)}><fieldset disabled={busy}>
      <label htmlFor="current-password">当前密码</label><input id="current-password" name="currentPassword" type="password" required maxLength={128} autoComplete="current-password" />
      <label htmlFor="new-password">新密码</label><input id="new-password" name="newPassword" type="password" required minLength={6} maxLength={32} autoComplete="new-password" aria-describedby="new-password-hint" />
      <p className="field-hint" id="new-password-hint">6–32 个字符。修改后，其他设备需要重新登录。</p>
      <button className="button primary-button" type="submit">{busy ? "正在处理…" : "保存密码"}</button>
    </fieldset></form></section>}
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}{notice && <p role="status" className="feedback">{notice}</p>}
  </>;
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  const { user, hasPassword } = useSession();
  const [healthRevision, setHealthRevision] = useState(0);
  const title = section === "account" ? "我的账号" : section === "team" ? "团队设置" : "实例管理";
  const allowed = section === "account" || (section === "team" ? user?.role === "admin" : user?.serviceRole === "service_admin");
  return <><AppHeader currentPage={title} /><main className="settings-page">
    <div className="page-title-row"><div><p className="eyebrow">{section === "instance" ? "实例管理" : user?.teamName}</p><h1>{title}</h1><p className="page-description">{section === "account" ? (hasPassword === false ? "管理 GitLab 与即时通讯身份。" : "管理 GitLab 与即时通讯身份，修改登录密码。") : section === "team" ? "查看团队信息，配置团队通知出口。" : "查看实例健康，管理模型服务与服务管理员。"}</p></div></div>
    {!allowed ? <p className="feedback feedback-error" role="alert">{section === "team" ? "仅团队管理员可以管理团队设置。" : "仅服务管理员可以管理实例。"}</p>
      : section === "account" ? <div className="settings-sections account-settings"><AccountSettings /></div>
        : section === "instance" ? <div className="settings-sections"><InstanceHealthSection refreshKey={healthRevision} /><SsoSettings /><section id="model-settings" className="panel settings-content"><div className="panel-heading"><h2>模型与服务权限</h2></div><div className="panel-body"><ServiceConfiguration onHealthChanged={() => setHealthRevision((current) => current + 1)} /></div></section></div>
          : <div className="settings-sections"><section className="panel settings-content"><div className="panel-heading"><h2>团队信息</h2></div><div className="panel-body"><dl className="settings-facts"><div><dt>团队名称</dt><dd>{user?.teamName}</dd></div></dl></div></section>
            <section className="panel settings-content"><div className="panel-heading"><h2>团队通知</h2><p>评审完成、有人回复或提及时，通过通知出口发送消息。</p></div><div className="panel-body"><NotificationSettings /></div></section></div>}
  </main></>;
}
