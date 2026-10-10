import { useEffect, useState, type FormEvent } from "react";
import { createNotificationEndpoint, deleteNotificationEndpoint, getNotificationEndpoints, updateNotificationEndpoint, type NotificationEndpoint, type NotificationKind } from "./notification-settings-api";

const labels: Record<NotificationKind, string> = { wecom: "企业微信群机器人", feishu: "飞书群机器人", dingtalk: "钉钉群机器人", webhook: "通用 webhook" };
const statusLabels: Record<string, string> = { queued: "待发送", sending: "发送中", delivered: "已发送", failed: "失败", cancelled: "已取消" };

export function NotificationSettings() {
  const [endpoints, setEndpoints] = useState<NotificationEndpoint[]>([]);
  const [editing, setEditing] = useState<NotificationEndpoint | null>(null);
  const [kind, setKind] = useState<NotificationKind>("wecom");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const load = async () => setEndpoints((await getNotificationEndpoints()).endpoints);
  useEffect(() => { void load().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "无法读取通知出口")); }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget, data = new FormData(form);
    const name = String(data.get("name")).trim(), endpoint = String(data.get("endpoint")).trim(), secret = String(data.get("secret") ?? "").trim();
    setBusy(true); setError(""); setNotice("");
    try {
      if (editing) await updateNotificationEndpoint(editing.id, { name, ...(endpoint ? { endpoint } : {}), ...(data.get("clearSecret") ? { secret: null } : secret ? { secret } : {}) });
      else await createNotificationEndpoint({ name, kind, endpoint, ...(secret ? { secret } : {}) });
      await load(); setEditing(null); form.reset(); setNotice("通知出口已保存。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败，请重试。"); }
    finally { setBusy(false); }
  }
  async function remove(endpoint: NotificationEndpoint) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { await deleteNotificationEndpoint(endpoint.id); await load(); if (editing?.id === endpoint.id) setEditing(null); setNotice("通知出口已删除。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <div className="notification-settings">
    <p className="muted">评审完成、有人提及或回复时发送通知。接收人填写即时通讯身份后，机器人会在消息中提醒本人。</p>
    {endpoints.length === 0 ? <p className="muted">尚未配置通知出口。</p> : <div className="notification-endpoint-list">{endpoints.map((endpoint) => <article className="panel" key={endpoint.id} style={{ marginBottom: 12 }}><div className="panel-body">
      <h3>{endpoint.name}</h3><p>{labels[endpoint.kind]} · 地址 {endpoint.endpoint}{endpoint.secret && ` · 签名密钥 ${endpoint.secret}`}</p>
      <p className="muted">{Object.entries(endpoint.deliveries).map(([status, count]) => `${statusLabels[status] ?? status} ${count}`).join(" · ") || "暂无投递"}</p>
      <div className="row-actions"><button type="button" className="button secondary-button" disabled={busy} onClick={() => { setEditing(endpoint); setKind(endpoint.kind); setError(""); setNotice(""); }}>编辑</button><button type="button" className="button secondary-button" disabled={busy} onClick={() => void remove(endpoint)}>删除</button></div>
    </div></article>)}</div>}
    <form key={editing?.id ?? "new"} className="account-password-form" onSubmit={(event) => void submit(event)}><h3>{editing ? "编辑通知出口" : "添加通知出口"}</h3><fieldset disabled={busy}>
      <label htmlFor="notification-name">出口名称</label><input id="notification-name" name="name" required maxLength={100} defaultValue={editing?.name ?? ""} />
      <label htmlFor="notification-kind">出口类型</label><select id="notification-kind" value={kind} disabled={Boolean(editing)} onChange={(event) => setKind(event.target.value as NotificationKind)}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      <label htmlFor="notification-endpoint">Webhook 地址</label><input id="notification-endpoint" name="endpoint" type="password" autoComplete="off" required={!editing} maxLength={2048} placeholder={editing ? "留空保留已保存的地址" : "https://"} />
      <p className="field-hint">使用公网 HTTPS 地址与 443 端口。保存后仅显示掩码。</p>
      {(kind === "feishu" || kind === "dingtalk") && <><label htmlFor="notification-secret">签名密钥（可选）</label><input id="notification-secret" name="secret" type="password" autoComplete="off" maxLength={256} placeholder={editing?.secret ? "留空保留已保存的密钥" : ""} />{editing?.secret && <label><input type="checkbox" name="clearSecret" />清除签名密钥</label>}</>}
      <div className="row-actions"><button type="submit" className="button primary-button">{busy ? "正在保存…" : "保存出口"}</button>{editing && <button type="button" className="button secondary-button" onClick={() => setEditing(null)}>取消编辑</button>}</div>
    </fieldset></form>
    {error && <p className="feedback feedback-error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}
  </div>;
}
