import { useEffect, useState, type FormEvent } from "react";
import { getIdentities, saveIdentities, type IdentitySettings as Settings } from "./auth-api";

export function IdentityEditor({ userId }: { userId?: string }) {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [feishuKind, setFeishuKind] = useState<"open_id" | "user_id">("open_id");
  useEffect(() => {
    let active = true;
    setSettings(undefined); setError(""); setFeedback("");
    void getIdentities(userId).then((value) => { if (active) { setSettings(value); setFeishuKind(value.feishuUserId ? "user_id" : "open_id"); } },
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "身份信息读取失败"); });
    return () => { active = false; };
  }, [userId]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings || busy) return;
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(""); setFeedback("");
    const feishuId = String(data.get("feishuId") ?? "").trim() || null;
    try {
      const next = await saveIdentities({ gitlab: settings.instances.flatMap((instanceUrl, index) => {
        const username = String(data.get(`gitlab-${index}`) ?? "").trim();
        return username ? [{ instanceUrl, username }] : [];
      }), mobile: String(data.get("mobile") ?? "").trim() || null,
      feishuOpenId: feishuKind === "open_id" ? feishuId : null, feishuUserId: feishuKind === "user_id" ? feishuId : null }, userId);
      setSettings(next); setFeedback("身份信息已保存。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "身份信息保存失败"); }
    finally { setBusy(false); }
  }
  const prefix = userId ?? "account";
  return <section className="panel team-panel identity-settings"><h2>身份关联</h2>
    <p className="muted">GitLab 用户名用于显示个人待办。即时通讯身份用于群机器人消息中的提醒。</p>
    {error && <p className="feedback feedback-error" role="alert">{error}</p>}
    {!settings && !error && <p role="status">正在读取身份信息…</p>}
    {settings && <form onSubmit={(event) => void submit(event)}><fieldset disabled={busy}>
      <h3>GitLab 用户名</h3>
      {settings.instances.length === 0 && <p className="field-hint">当前团队尚未接入 GitLab 实例，接入仓库后可关联用户名。</p>}
      {settings.instances.map((instanceUrl, index) => <div key={instanceUrl}><label htmlFor={`${prefix}-gitlab-${index}`}>{instanceUrl}</label>
        <input id={`${prefix}-gitlab-${index}`} name={`gitlab-${index}`} aria-label={`GitLab 用户名 ${instanceUrl}`} autoComplete="off" maxLength={255}
          defaultValue={settings.gitlab.find((item) => item.instanceUrl === instanceUrl)?.username ?? ""} placeholder="如 zhangwei" /></div>)}
      <h3>即时通讯身份</h3>
      <label htmlFor={`${prefix}-mobile`}>手机号</label><input id={`${prefix}-mobile`} name="mobile" type="tel" autoComplete="tel" maxLength={21} defaultValue={settings.mobile ?? ""} />
      <p className="field-hint">企业微信与钉钉使用手机号提醒接收人。</p>
      <label htmlFor={`${prefix}-feishu-kind`}>飞书身份类型</label><select id={`${prefix}-feishu-kind`} value={feishuKind} onChange={(event) => setFeishuKind(event.target.value as "open_id" | "user_id")}><option value="open_id">open_id</option><option value="user_id">user_id</option></select>
      <label htmlFor={`${prefix}-feishu-id`}>飞书 {feishuKind}</label><input id={`${prefix}-feishu-id`} name="feishuId" autoComplete="off" maxLength={128} defaultValue={settings.feishuOpenId ?? settings.feishuUserId ?? ""} />
      <p className="field-hint">从飞书取得接收人的 open_id 或 user_id，选择对应类型后填写。</p>
      <button className="button primary-button" type="submit">{busy ? "正在保存…" : "保存身份信息"}</button>
    </fieldset>{feedback && <p className="feedback" role="status">{feedback}</p>}</form>}
  </section>;
}
export const IdentitySettings = IdentityEditor;
