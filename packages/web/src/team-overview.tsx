import { useEffect, useState } from "react";
import { useSession } from "./auth";
import { Icon } from "./icons";
import { AppHeader } from "./layout";
import { getTeamOverview, overviewDismissalLabels, type TeamOverview } from "./team-overview-api";
import "./dashboard.css";
import "./team-overview.css";

function Metric({ label, value, detail, href }: { label: string; value: number | string; detail: string; href?: string }) {
  const contents = <><span className="dashboard-metric-label">{label}</span><strong className="dashboard-metric-number">{value}</strong><span className="dashboard-metric-detail">{detail}</span></>;
  return href ? <a className="metric-card dashboard-metric" href={href}>{contents}</a> : <div className="metric-card dashboard-metric">{contents}</div>;
}

export function TeamOverviewPage() {
  const { user } = useSession();
  const [data, setData] = useState<TeamOverview>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void getTeamOverview(controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) { setData(undefined); setError(reason instanceof Error ? reason.message : "读取团队概览失败"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  return <><AppHeader currentPage="团队概览" /><main className="dashboard-page team-overview-page">
    <div className="page-title-row"><div><p className="dashboard-team-label">{user?.teamName}</p><h1>团队概览</h1><p className="page-description">最近 4 周的评审与处置。</p></div>
      <button type="button" className="button secondary-button" disabled={loading} onClick={() => setRevision((value) => value + 1)}><Icon name="refresh" size={16} />{loading ? "正在刷新" : "刷新"}</button></div>
    {error && <p className="feedback feedback-error" role="alert">{error}</p>}
    {loading && !data && <p className="muted" role="status">正在读取团队概览…</p>}
    {data && <>
      <section aria-labelledby="overview-period-heading"><div className="team-overview-section-heading"><h2 id="overview-period-heading">最近 4 周</h2><p>{new Date(data.period.from).toLocaleDateString("zh-CN")} — {new Date(data.period.to).toLocaleDateString("zh-CN")}</p></div>
        <div className="metric-grid dashboard-metrics">
          <Metric label="评审轮次" value={data.reviewRounds} detail="按发起时间统计，包含重跑" />
          <Metric label="展示的高危" value={data.findings.high} detail="已完成评审中展示的 finding" />
          <Metric label="展示的中危" value={data.findings.medium} detail="已完成评审中展示的 finding" />
          <Metric label="采纳率" value={data.adoptionRate === null ? "—" : `${(data.adoptionRate * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}%`}
            detail={data.adoptionRate === null ? "暂无处置" : `采纳 ${data.findings.resolved} / 已处置 ${data.findings.resolved + data.findings.dismissed}`} />
        </div><p className="team-overview-caption">采纳率 = 采纳数 /（采纳数 + 驳回数）。按当前处置统计，待处理、被无视和已过时的 finding 不计入分母。</p>
      </section>
      <div className="team-overview-breakdowns">
        <section className="dashboard-surface team-overview-breakdown" aria-labelledby="overview-reasons-heading"><div className="dashboard-section-heading"><h2 id="overview-reasons-heading">驳回理由</h2><span className="muted">{data.findings.dismissed} 条</span></div>
          <ul className="team-overview-reasons">{data.dismissalReasons.map((reason) => <li key={reason.category}><div><span>{overviewDismissalLabels[reason.category]}</span><strong>{reason.count}</strong></div>
            <div className="team-overview-bar" aria-hidden="true"><span style={{ width: `${data.findings.dismissed ? reason.count / data.findings.dismissed * 100 : 0}%` }} /></div></li>)}</ul>
        </section>
        <section className="dashboard-surface team-overview-breakdown" aria-labelledby="overview-rules-heading"><div className="dashboard-section-heading"><h2 id="overview-rules-heading">被驳回最多的规范</h2><span className="muted">前 5 条</span></div>
          {data.mostDismissedRules.length === 0 ? <p className="team-overview-empty">最近 4 周没有被驳回的规范 finding。</p> : <ol className="team-overview-rules">{data.mostDismissedRules.map((rule) => <li key={`${rule.repositoryId ?? "team"}:${rule.id}`}><div><strong>{rule.name}</strong><span>{rule.repositoryName ?? "团队规范"}</span></div><span className="team-overview-rule-count">{rule.count} 次</span></li>)}</ol>}
          <a className="dashboard-see-all" href="/?rules=1">查看规范<Icon name="arrow-right" size={14} /></a>
        </section>
      </div>
      <section aria-labelledby="overview-totals-heading"><div className="team-overview-section-heading"><h2 id="overview-totals-heading">团队总计</h2><p>所有时间，每个 PR 按最新一轮统计</p></div>
        <div className="metric-grid dashboard-metrics">
          <Metric label="已接入仓库" value={data.totals.repositories} detail="当前团队的仓库" href="/?repositories=1" />
          <Metric label="已发起评审的 PR" value={data.totals.pullRequests} detail="每个 PR 计一次" href="/?reviews=1" />
          <Metric label="已完成评审的 PR" value={data.totals.completed} detail="可查看报告与讨论" href="/?reviews=1&status=completed" />
          <Metric label="等待或正在评审" value={data.totals.queued + data.totals.running} detail={`${data.totals.queued} 个等待 · ${data.totals.running} 个进行中`} href="/?reviews=1" />
        </div>
      </section>
    </>}
  </main></>;
}
