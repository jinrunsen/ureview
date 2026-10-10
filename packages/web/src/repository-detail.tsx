import { useEffect, useState } from "react";
import { ApiError, type RepositorySummary } from "./api";
import { useSession } from "./auth";
import { Icon } from "./icons";
import { AppHeader, formatDate } from "./layout";
import { ReviewScopeSettings } from "./review-settings";
import { RepositoryReviewsList } from "./reviews";
import { RuleCatalogContent } from "./rules";
import { StartReviewDialog } from "./start-review";
import { RepositoryDeletion } from "./repository-deletion";
import { checkRepositoryWebhook, getRepository, getRepositoryEvents, saveAutomaticReview, type RepositoryEvents, type WebhookCheck } from "./repository-detail-api";
import "./repositories.css";

const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作未完成，请重试。";
const tabs = [{ id: "reviews", name: "评审" }, { id: "rules", name: "规范" }, { id: "settings", name: "评审设置" }, { id: "events", name: "接入与事件" }];

function AutomaticReviewSettings({ repository, onSaved }: { repository: RepositorySummary; onSaved: (repository: RepositorySummary) => void }) {
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  async function toggle() {
    if (busy || user?.role !== "admin") return;
    setBusy(true); setError(""); setNotice("");
    try {
      const saved = await saveAutomaticReview(repository.id, !repository.automaticReviewEnabled, repository.automaticReviewVersion);
      onSaved(saved); setNotice(saved.automaticReviewEnabled ? "自动评审已开启。" : "自动评审已关闭，收到的事件仍会记录。手动发起与重新评审可以继续使用。");
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "automatic_review_conflict") {
        try { onSaved(await getRepository(repository.id)); setError("其他管理员已更新自动评审配置，已显示最新状态，请重新确认。"); }
        catch (reloadCause) { setError(message(reloadCause)); }
      } else setError(message(cause));
    } finally { setBusy(false); }
  }
  return <section className="panel"><div className="panel-heading"><h2>自动评审</h2><p>收到合并请求事件时，自动评审当前提交。</p></div><div className="panel-body">
    <div className="automatic-review-control"><span><strong>{repository.automaticReviewEnabled ? "已开启" : "已关闭"}</strong><span className="table-secondary">手动发起与重新评审始终可用。</span></span>
      {user?.role === "admin" ? <button type="button" className={`repository-switch ${repository.automaticReviewEnabled ? "is-on" : ""}`} role="switch" aria-label="自动评审" aria-checked={repository.automaticReviewEnabled} disabled={busy} onClick={() => void toggle()}><span /></button> : <span className="muted">仅团队管理员可修改</span>}
    </div>
    {busy && <p role="status">正在保存自动评审配置…</p>}{error && <p className="feedback feedback-error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}
  </div></section>;
}

function RepositoryConnection({ repository }: { repository: RepositorySummary }) {
  const repositoryId = repository.id;
  const { user } = useSession();
  const [data, setData] = useState<RepositoryEvents>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [check, setCheck] = useState<WebhookCheck>();
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void getRepositoryEvents(repositoryId, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repositoryId, attempt]);
  async function detect() {
    if (checking || user?.role !== "admin") return;
    setChecking(true); setCheckError(""); setCheck(undefined);
    try { setCheck(await checkRepositoryWebhook(repositoryId)); }
    catch (cause) { setCheckError(message(cause)); }
    finally { setChecking(false); }
  }
  const labels = { queued: "已入队", duplicate: "重复投递", ignored: "已忽略", failed: "处理失败" };
  return <div className="repository-detail-sections">
    {loading && !data && <p role="status">正在读取接入配置与事件…</p>}
    {error && <div className="feedback feedback-error" role="alert"><p>{error}</p><button type="button" className="button secondary-button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>重新加载</button></div>}
    {data && <><section className="panel"><div className="panel-heading"><h2>Webhook 配置</h2><p>由 GitLab 项目管理员在项目的 Webhooks 设置中填写。</p></div><div className="panel-body repository-webhook-settings">
      <dl className="repository-detail-fields"><div><dt>Webhook 地址</dt><dd><code>{data.webhook.url}</code></dd></div><div><dt>事件</dt><dd>Merge request events</dd></div><div><dt>密钥状态</dt><dd>{data.webhook.tokenConfigured ? "已配置" : "未配置"}</dd></div></dl>
      <p className="field-hint">在 Secret token 中填写部署配置 UREVIEW_WEBHOOK_TOKEN 的值。地址需可从 GitLab 访问；自托管 GitLab 请确认网络访问设置允许该地址。</p>
      {user?.role === "admin" && <button type="button" className="button secondary-button" disabled={checking} onClick={() => void detect()}><Icon name="refresh" size={15} />{checking ? "正在检测…" : "检测连通配置"}</button>}
      <p className="field-hint">检测读取 GitLab 中的 webhook 配置。也可在 GitLab 中使用 webhook 的「测试」功能，再刷新下方最近收到的事件。</p>
      {check && <div role="status" className={`feedback ${check.status === "configured" ? "" : "feedback-error"}`}><p>{check.message}</p><span className="table-secondary">检测于 {formatDate(check.checkedAt)}</span></div>}
      {checkError && <p className="feedback feedback-error" role="alert">{checkError}</p>}
      {data.webhook.lastAuthenticationFailureAt && <div className="feedback feedback-error" role="status"><strong>曾收到密钥校验失败的请求</strong><p>最近一次：{formatDate(data.webhook.lastAuthenticationFailureAt)}。请核对 GitLab 中的 Secret token。</p></div>}
    </div></section>
    <section className="panel repository-events"><div className="panel-heading list-heading"><div><h2>最近收到的事件</h2><p>按接收时间倒序保留最近 100 条。</p></div><button type="button" className="button secondary-button" disabled={loading} onClick={() => setAttempt((value) => value + 1)}>{loading ? "正在刷新…" : "刷新事件"}</button></div>
      {data.events.length === 0 ? <div className="empty-state"><h3>尚未收到 webhook</h3><p>请按上方说明配置 GitLab webhook，再发送测试事件。</p></div>
        : <div className="table-scroll"><table className="data-table repository-event-table"><thead><tr><th>接收时间</th><th>事件与动作</th><th>合并请求</th><th>处理结果</th><th>评审轮次</th></tr></thead><tbody>{data.events.map((event) => <tr key={event.id}>
          <td><time dateTime={event.receivedAt}>{formatDate(event.receivedAt)}</time></td><td>{event.eventType}<span className="table-secondary">{event.action ?? "—"}</span></td><td>{event.iid === null ? "—" : `!${event.iid}`}</td>
          <td><span className="status-badge">{labels[event.result]}</span>{event.reason && <p className="table-secondary repository-event-reason">{event.reason}</p>}</td>
          <td>{event.reviewId ? <a href={`/?review=${encodeURIComponent(event.reviewId)}`}>{event.reviewRound === null ? "查看评审" : `第 ${event.reviewRound} 轮`}</a> : "—"}</td>
        </tr>)}</tbody></table></div>}
    </section></>}
    {user?.role === "admin" && <RepositoryDeletion repository={repository} />}
  </div>;
}

export function RepositoryDetailPage({ repositoryId }: { repositoryId: string }) {
  const [repository, setRepository] = useState<RepositorySummary>();
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  const requestedTab = new URLSearchParams(window.location.search).get("tab");
  const tab = tabs.find((item) => item.id === requestedTab)?.id ?? "reviews";
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    void getRepository(repositoryId, controller.signal).then((value) => { if (!controller.signal.aborted) setRepository(value); })
      .catch((cause) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [repositoryId, attempt]);
  return <><AppHeader currentPage="仓库详情" /><main className="repository-detail-page">
    <a className="back-link" href="/?repositories=1">← 返回仓库列表</a>
    {error && <div className="feedback feedback-error" role="alert"><p>{error}</p><button type="button" className="button secondary-button" onClick={() => setAttempt((value) => value + 1)}>重新加载仓库</button></div>}
    {!repository && !error && <p role="status">正在读取仓库…</p>}
    {repository && <><div className="page-title-row repository-detail-heading"><div><p className="eyebrow">GitLab 仓库</p><h1>{repository.name}</h1><p className="page-description">{repository.instanceUrl}<br />{repository.pathWithNamespace}</p><p className="table-secondary">接入验证于 {formatDate(repository.connectedAt)} · 自动评审{repository.automaticReviewEnabled ? "已开启" : "已关闭"}</p></div>
      <div className="repository-detail-actions"><a className="button secondary-button" href={repository.webUrl} target="_blank" rel="noreferrer">在 GitLab 查看<Icon name="arrow-up-right" size={15} /></a><button type="button" className="button primary-button" onClick={() => setStartOpen(true)}><Icon name="plus" size={15} />发起评审</button></div></div>
      <nav className="page-tabs" aria-label="仓库详情标签">{tabs.map((item) => <a key={item.id} href={`/?repository=${encodeURIComponent(repositoryId)}&tab=${item.id}`} aria-current={tab === item.id ? "page" : undefined}>{item.name}</a>)}</nav>
      {tab === "reviews" ? <RepositoryReviewsList repositoryId={repositoryId} /> : tab === "rules" ? <RuleCatalogContent repositoryId={repositoryId} /> : tab === "events" ? <RepositoryConnection repository={repository} />
        : <div className="repository-detail-sections"><AutomaticReviewSettings repository={repository} onSaved={setRepository} /><section className="panel"><div className="panel-heading"><h2>评审排除目录</h2></div><div className="panel-body"><ReviewScopeSettings repositoryId={repositoryId} /></div></section></div>}
    </>}
    {startOpen && <StartReviewDialog onClose={() => setStartOpen(false)} />}
  </main></>;
}
