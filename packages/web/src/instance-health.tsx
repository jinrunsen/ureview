import { useEffect, useState } from "react";
import { useSession } from "./auth";
import { switchTeam } from "./auth-api";
import { Icon } from "./icons";
import { getInstanceHealth, modelFailureLabels, type InstanceHealth } from "./instance-api";
import { formatDate } from "./layout";
import "./instance-health.css";

const phaseLabels = { generator: "Generator", grader: "Grader" };
const sourceLabels = { database: "数据库", environment: "环境变量", none: "未配置" };
const message = (cause: unknown) => cause instanceof Error ? cause.message : "实例健康暂时无法读取，请重试。";
const number = (value: number) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
function waitDuration(seconds: number | null) {
  if (seconds === null) return "无等待";
  if (seconds < 60) return `${Math.floor(seconds)} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
  return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时`;
}

export function InstanceHealthSection({ refreshKey }: { refreshKey: number }) {
  const { user } = useSession();
  const [data, setData] = useState<InstanceHealth>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [openingReview, setOpeningReview] = useState("");
  const [navigationError, setNavigationError] = useState("");
  useEffect(() => {
    if (user?.serviceRole !== "service_admin") return;
    const controller = new AbortController();
    setLoading(true); setError("");
    void getInstanceHealth(controller.signal).then((result) => { if (!controller.signal.aborted) setData(result); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) { setData(undefined); setError(message(cause)); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [user?.serviceRole, refreshKey, revision]);
  async function openReview(teamId: string, reviewId: string) {
    if (openingReview) return;
    setOpeningReview(reviewId); setNavigationError("");
    try { await switchTeam(teamId); window.location.assign(`/?review=${encodeURIComponent(reviewId)}`); }
    catch (cause) { setNavigationError(message(cause)); setOpeningReview(""); }
  }
  if (user?.serviceRole !== "service_admin") return null;
  return <section className="panel settings-content instance-health" aria-labelledby="instance-health-heading">
    <div className="panel-heading"><div><h2 id="instance-health-heading">实例健康</h2><p>查看整个实例的模型、评审队列与最近 7 天的运行记录。</p></div>
      <button type="button" className="button secondary-button" disabled={loading} onClick={() => setRevision((current) => current + 1)}><Icon name="refresh" size={15} />{loading ? "正在刷新" : "刷新健康"}</button></div>
    {loading && !data && <p className="muted" role="status">正在读取实例健康…</p>}
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}
    {data && <div className="instance-health-content" aria-busy={loading}>
      <section aria-labelledby="health-models-heading"><h3 id="health-models-heading">模型连接</h3><p className="health-caption">显示当前配置来源。最近记录包含模型调用和未保存连接的验证，失败仅显示安全错误分类。</p>
        <div className="health-models">{data.models.map((model) => <article key={model.phase} className="health-model">
          <div className="health-model-heading"><h4>{phaseLabels[model.phase]}</h4><span className="status-badge">{model.configured ? "已配置" : "未配置"}</span></div>
          <p className="health-model-name">{model.model || "尚未设置模型"}</p>
          <dl><div><dt>配置来源</dt><dd>{sourceLabels[model.source]}</dd></div>
            <div><dt>最近成功</dt><dd>{model.lastSuccessAt ? <time dateTime={model.lastSuccessAt}>{formatDate(model.lastSuccessAt)}</time> : "暂无成功记录"}</dd></div>
            <div><dt>最近失败</dt><dd>{model.lastFailure ? <><time dateTime={model.lastFailure.at}>{formatDate(model.lastFailure.at)}</time><span className="health-failure-code">{modelFailureLabels[model.lastFailure.code]} · <code>{model.lastFailure.code}</code></span></> : "暂无失败记录"}</dd></div></dl>
        </article>)}</div>
      </section>
      <section aria-labelledby="health-queue-heading"><h3 id="health-queue-heading">评审队列</h3><dl className="health-queue">
        <div><dt>等待中</dt><dd>{number(data.queue.queued)}</dd></div><div><dt>进行中</dt><dd>{number(data.queue.running)}</dd></div>
        <div><dt>最早等待时长</dt><dd>{waitDuration(data.queue.oldestWaitSeconds)}</dd></div>
      </dl>{data.queue.oldestQueuedAt && <p className="health-caption">最早入队于 <time dateTime={data.queue.oldestQueuedAt}>{formatDate(data.queue.oldestQueuedAt)}</time>。</p>}</section>
      <section aria-labelledby="health-failures-heading"><h3 id="health-failures-heading">最近失败</h3><p className="health-caption">最近 7 天失败的评审轮次，按错误码分组。</p>
        {data.failures.length === 0 ? <p className="health-empty">最近 7 天没有失败的评审。</p>
          : data.failures.map((group) => <details className="health-failure-group" key={group.code}><summary><code>{group.code}</code><strong>{number(group.count)} 轮失败</strong></summary>
            <ul className="health-failure-reviews">{group.reviews.map((review) => <li key={review.id}>
              <div><p>{review.title}</p><p className="health-review-meta">{review.teamName} · {review.repositoryName} !{review.iid} · 第 {review.round} 轮<br /><time dateTime={review.completedAt}>{formatDate(review.completedAt)}</time></p></div>
              {!review.canOpen ? <span className="health-review-access">加入该团队后可查看</span>
                : review.teamId === user.teamId ? <a href={`/?review=${encodeURIComponent(review.id)}`}>查看评审</a>
                  : <button type="button" className="text-button" disabled={!!openingReview} onClick={() => void openReview(review.teamId, review.id)}>{openingReview === review.id ? "正在打开…" : "切换团队并查看"}</button>}
            </li>)}</ul></details>)}
        {navigationError && <p role="alert" className="feedback feedback-error">{navigationError}</p>}
      </section>
      <section aria-labelledby="health-success-heading"><h3 id="health-success-heading">按模型统计</h3><p className="health-caption">最近 7 天的完成率 = 已完成轮次 /（已完成轮次 + 失败轮次），等待中与进行中的轮次不计入。被拒提交平均次数按同一批轮次的提交记录计算。</p>
        {data.modelMetrics.length === 0 ? <p className="health-empty">最近 7 天没有包含模型记录的已结束评审。</p>
          : <div className="table-scroll"><table className="health-metrics"><thead><tr><th>模型</th><th>阶段</th><th>已结束轮次</th><th>已完成</th><th>失败</th><th>完成率</th><th>平均被拒提交次数</th></tr></thead><tbody>
            {data.modelMetrics.map((metric) => <tr key={`${metric.phase}:${metric.provider}:${metric.model}`}><td>{metric.model}<span className="health-model-provider">{metric.provider}</span></td>
              <td>{phaseLabels[metric.phase]}</td><td>{number(metric.total)}</td><td>{number(metric.completed)}</td><td>{number(metric.failed)}</td><td>{number(metric.completionRate * 100)}%</td><td>{number(metric.averageRejectedSubmissions)}</td></tr>)}
          </tbody></table></div>}
        <p className="health-caption">统计时间：<time dateTime={data.period.from}>{formatDate(data.period.from)}</time> 至 <time dateTime={data.period.to}>{formatDate(data.period.to)}</time>。</p>
      </section>
      <section aria-labelledby="health-version-heading"><h3 id="health-version-heading">版本</h3><dl className="health-versions">
        <div><dt>uReview</dt><dd><code>{data.versions.ureview}</code></dd></div><div><dt>dsh</dt><dd><code>{data.versions.dsh}</code></dd></div><div><dt>数据库迁移</dt><dd><code>{data.versions.migration ?? "尚未执行迁移"}</code></dd></div>
      </dl></section>
    </div>}
  </section>;
}
