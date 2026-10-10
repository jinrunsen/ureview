import { reviewRuleDetailUrl } from "./rule-detail-api";
import { requestIdentifier } from "./request-id";
import { FindingDiscussion, PlatformDiscussions, ReviewParticipation } from "./collaboration";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AppHeader, formatDate } from "./layout";
import { listRepositories, type RepositorySummary } from "./api";
import { resolveReviewPage } from "./review-pagination";
import { ConclusionBar } from "./review-conclusion";
import { ReadingPanel } from "./reading";
import "./review-page.css";
import { ReviewSessionButton } from "./agent-sessions";
import { ruleCategoryLabels, ruleSeverityLabels } from "./managed-rules-api";
import { ruleLayerLabels } from "./rule-metadata";
import { DispositionSummary, FindingComparison, FindingDispositionControls, findingStatusLabels, type RefreshDisposition } from "./finding-disposition";
import { evidenceTarget, findingTarget } from "./review-diff-data";
import {
  getReview, listReviews, listReviewRounds, markReviewViewed, rerunReview, mergeFindingDisposition,
  type CodeRange, type CodeTarget, type ReadRange, type ReportSubmission, type ReviewDetail, type ReviewFinding, type ReviewStatus, type ReviewSummary, type ReviewRule,
} from "./review-api";

const ReviewDiff = lazy(() => import("./review-diff"));
const statusLabels: Record<ReviewStatus, string> = { queued: "待评审", running: "进行中", completed: "已完成", failed: "失败" };
const severityLabels = { high: "高危", medium: "中危" };
const alwaysPoll = () => true;
function isActive(review: ReviewSummary): boolean { return review.status === "queued" || review.status === "running"; }

function useReviewResource<T>(load: (signal: AbortSignal) => Promise<T>, shouldPoll: (value: T) => boolean) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setValue(null); setError("");
    async function refresh() {
      try {
        const result = await load(controller.signal);
        if (controller.signal.aborted) return;
        setValue(result); setError("");
        if (shouldPoll(result)) timer = setTimeout(() => void refresh(), 2500);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "评审加载失败，请重试。");
      }
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [load, shouldPoll, attempt]);
  return { value, error, loading: value === null && !error, refresh: () => setAttempt((current) => current + 1), update: setValue };
}
function StatusBadge({ status }: { status: ReviewStatus }) {
  return <span className={`review-status review-status-${status}`}>{statusLabels[status]}</span>;
}
function LoadError({ message, retry }: { message: string; retry: () => void }) {
  return <div className="list-error" role="alert"><strong>评审加载失败</strong><p>{message}</p>
    <button className="button secondary-button" type="button" onClick={retry}>重试</button></div>;
}

function initialStatus(): ReviewStatus | "" {
  const value = new URLSearchParams(window.location.search).get("status");
  return value && Object.hasOwn(statusLabels, value) ? value as ReviewStatus : "";
}
function initialPage(): number {
  const value = Number(new URLSearchParams(window.location.search).get("page"));
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

export function RepositoryReviewsPage() {
  return <><AppHeader currentPage="评审列表" /><main className="review-main"><div className="page-title-row"><div><p className="eyebrow">代码评审</p><h1>评审列表</h1><p className="page-description">查看每个 PR 的最新一轮评审，按仓库和状态找到需要关注的改动。</p></div></div><RepositoryReviewsList /></main></>;
}

export function RepositoryReviewsList({ repositoryId }: { repositoryId?: string }) {
  const [repository, setRepository] = useState(repositoryId ?? new URLSearchParams(window.location.search).get("repository") ?? "");
  const [status, setStatus] = useState<ReviewStatus | "">(initialStatus);
  const [page, setPage] = useState(initialPage);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [repositoryError, setRepositoryError] = useState("");
  const [repositoryAttempt, setRepositoryAttempt] = useState(0);
  const pageSize = 20;
  const load = useCallback((signal: AbortSignal) => listReviews({ repositoryId: repository || undefined, status: status || undefined, page, pageSize }, signal), [repository, status, page]);
  const resource = useReviewResource(load, alwaysPoll);
  useEffect(() => {
    let current = true;
    void listRepositories().then((result) => { if (current) { setRepositories(result.repositories); setRepositoryError(""); } })
      .catch((error: unknown) => { if (current) setRepositoryError(error instanceof Error ? error.message : "仓库选项加载失败。"); });
    return () => { current = false; };
  }, [repositoryAttempt]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.delete("status"); params.delete("page");
    if (!repository) params.delete("repository");
    if (!repositoryId) params.set("reviews", "1");
    if (repository) params.set("repository", repository);
    if (status) params.set("status", status);
    if (page > 1) params.set("page", String(page));
    window.history.replaceState(null, "", `/?${params}${window.location.hash}`);
  }, [repository, repositoryId, status, page]);
  const response = resource.value;
  const pagination = resolveReviewPage(page, response?.total ?? 0, response?.pageSize ?? pageSize);
  const correctingPage = Boolean(response && (response.page !== page || pagination.page !== page));
  useEffect(() => {
    if (response?.page === page && pagination.page !== page) setPage(pagination.page);
  }, [response, page, pagination.page]);
  const loading = resource.loading || correctingPage;
  const result = correctingPage ? null : response;
  const pages = pagination.pages;
  return <>
    <section className="panel review-list-panel" aria-labelledby="reviews-heading">
      <div className="panel-heading list-heading"><div><h2 id="reviews-heading">评审记录 {result && <span className="count">{result.total}</span>}</h2><p>列表会自动更新。</p></div>
        <button className="button secondary-button" type="button" disabled={loading} onClick={resource.refresh}>刷新</button></div>
      <div className="review-filters">
        {!repositoryId && <label>仓库<select value={repository} onChange={(event) => { setRepository(event.target.value); setPage(1); }}><option value="">全部仓库</option>
          {repositories.map((item) => <option key={item.id} value={item.id}>{item.pathWithNamespace}</option>)}</select></label>}
        <label>评审状态<select value={status} onChange={(event) => { setStatus(event.target.value as ReviewStatus | ""); setPage(1); }}><option value="">全部状态</option>
          {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      </div>
      {repositoryError && <div className="list-error" role="alert"><p>{repositoryError}</p><button className="button secondary-button" onClick={() => setRepositoryAttempt((value) => value + 1)}>重载仓库选项</button></div>}
      <div aria-busy={loading}>
        {loading && <p className="list-status" role="status">正在加载评审…</p>}
        {resource.error && <LoadError message={resource.error} retry={resource.refresh} />}
        {result?.reviews.length === 0 && <div className="empty-state"><h3>没有符合条件的评审</h3><p>{status || repository ? "可更换筛选条件，或输入 MR 链接发起评审。" : "接入仓库后，输入 MR 链接即可发起评审。"}</p></div>}
        {result && result.reviews.length > 0 && <div className="table-scroll"><table className="data-table review-table"><thead><tr><th>合并请求</th><th>作者</th><th>状态</th><th>评审发现</th><th>提交评审于</th></tr></thead><tbody>{result.reviews.map((review) => <tr key={review.id}>
          <td className="review-table-title"><a className="table-primary" href={`/?review=${encodeURIComponent(review.id)}`}>{review.title}</a><span className="table-secondary">{review.repositoryName} · !{review.iid} · 第 {review.round} 轮</span>{repositories.find((item) => item.id === review.repositoryId) && <span className="table-secondary">{repositories.find((item) => item.id === review.repositoryId)?.automaticReviewEnabled ? "自动评审已开启" : "自动评审已关闭"}</span>}
            {review.status === "failed" && <p className="review-row-error">{review.failureReason || "本次评审未能完成。"} <ReviewSessionButton review={review} failed full label="查看失败会话" /></p>}{review.status !== "failed" && review.statusMessage && <span className="table-secondary">{review.statusMessage}</span>}</td>
          <td className="review-table-author">{review.author}</td><td><StatusBadge status={review.status} /></td>
          <td><span className="finding-count high">高危 {review.findingCounts.high}</span><span className="finding-count medium">中危 {review.findingCounts.medium}</span>{review.status === "completed" && !review.viewedAt && <span className="unread-badge">还没人看过</span>}</td>
          <td><time className="table-secondary" dateTime={review.createdAt}>{formatDate(review.createdAt)}</time></td>
        </tr>)}</tbody></table></div>}
      </div>
      {result && <nav className="pagination" aria-label="评审列表分页"><span>共 {result.total} 个 PR · 第 {page} / {pages} 页</span>
        <button className="button secondary-button" type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button>
        <button className="button secondary-button" type="button" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>下一页</button></nav>}
    </section>
  </>;
}

function formatRange(range: CodeRange): string {
  return `${range.path}:${range.startLine}${range.startLine === range.endLine ? "" : `–${range.endLine}`}`;
}

function ReadTrace({ ranges }: { ranges: ReadRange[] }) {
  if (ranges.length === 0) return <p className="muted">没有记录到工具读取。</p>;
  return (
    <ul className="read-trace-list">
      {ranges.map((range, index) => (
        <li key={`${range.phase}:${range.tool}:${formatRange(range)}:${index}`}>
          <code>{formatRange(range)}</code>
          <span>{range.phase === "generator" ? "产出阶段" : "评分阶段"} · <code>{range.tool}</code></span>
        </li>
      ))}
    </ul>
  );
}

function RejectedSubmissions({ review }: { review: ReviewDetail }) {
  const rejected = review.reportSubmissions.filter((submission) => submission.outcome === "rejected");
  if (rejected.length === 0) return null;
  const labels: Record<ReportSubmission["tool"], string> = {
    report_file_groups: "文件分组提交", report_overview: "综述提交", report_finding: "评审结论提交", finish_report: "完成报告", grade_finding: "结论评分",
  };
  return <details className="panel review-trace"><summary>本轮有 {rejected.length} 次提交被拒绝</summary>
    <div className="panel-body"><ol className="report-rejections">
      {rejected.map((submission, index) => <li key={index}>
        <strong>{submission.phase === "generator" ? "产出阶段" : "评分阶段"} · {labels[submission.tool]}</strong>
        <p>{submission.reason || "未记录拒绝原因。"}</p>
        <ReviewSessionButton review={review} kind={submission.phase === "generator" ? "review_generator" : "review_grader"} full label="查看阶段会话" />
      </li>)}
    </ol></div>
  </details>;
}

function Rule({ rule }: { rule: ReviewRule }) {
  const global = rule.file.kind === "global" || (rule.file.kind === "database" && rule.file.scope === "global");
  const detailUrl = reviewRuleDetailUrl(rule);
  return <div className="rule-detail">
    <p>{detailUrl ? <a href={detailUrl}><strong>{rule.name ?? rule.id}</strong></a> : <strong>{rule.name ?? rule.id}</strong>} · {global ? "全局规范" : "仓库规范"} <span className="status-badge">{ruleLayerLabels[rule.layer ?? "team"]}</span>{rule.judgement && <> <span className="status-badge">判断题</span></>}</p>
    {rule.category && rule.severity && <p className="review-meta">{ruleCategoryLabels[rule.category]} · {ruleSeverityLabels[rule.severity]}</p>}
    <p className="fix-prompt">{rule.body}</p>{detailUrl && <p><a href={detailUrl}>查看规范详情与执行记录 →</a></p>}
    {rule.goodExample && <details><summary>正确示例</summary><pre className="code-block"><code>{rule.goodExample}</code></pre></details>}
    {rule.badExample && <details><summary>错误示例</summary><pre className="code-block"><code>{rule.badExample}</code></pre></details>}
    <p className="review-meta">来源：{rule.source.kind === "generated" ? "工作台生成" : rule.source.kind === "manual" ? "人工" : "挖掘"}
      {rule.source.url && <> · <a href={rule.source.url} target="_blank" rel="noreferrer">查看来源</a></>}</p>
    {rule.file.kind === "database" ? <p className="review-meta">工作台规范 · 版本 {rule.file.version} · 本轮快照<br /><code>{rule.id}</code></p>
      : <p className="review-meta"><a href={rule.file.url} target="_blank" rel="noreferrer">{rule.file.repositoryName} / {rule.file.path}</a>
        {" · "}<code title={rule.file.commitSha}>{rule.file.commitSha.slice(0, 12)}</code></p>}
  </div>;
}

/** 挂在代码行下的 finding 卡片正文。证据位置在评审页内定位，不跳到代码平台。 */
function FindingBody({ reviewId, finding, rules, onNavigate, onRefresh }: { reviewId: string; finding: ReviewFinding; rules: ReviewRule[];
  onNavigate: (target: CodeTarget, button: HTMLButtonElement) => void; onRefresh: RefreshDisposition }) {
  const rule = rules.find((candidate) => candidate.id === finding.ruleId);
  return (
    <div className="finding finding-body">
      <div className="finding-meta">
        <span className="finding-score">评分 <strong>{finding.score}</strong> / 100</span>
        {finding.ruleCategory && <span className="status-badge">{ruleCategoryLabels[finding.ruleCategory]}</span>}
        {rule?.judgement && <span className="status-badge">判断题</span>}
      </div>
      <FindingComparison finding={finding} />
      <p className="finding-description">{finding.description}</p>
      <FindingDispositionControls reviewId={reviewId} finding={finding} onRefresh={onRefresh} />
      <section className="finding-section">
        <h3>证据位置</h3>
        {finding.evidence.length === 0 ? <p className="muted">未提供证据位置。</p> : (
          <ul className="evidence-list">
            {finding.evidence.map((evidence, evidenceIndex) => (
              <li key={`${formatRange(evidence)}:${evidenceIndex}`}>
                <button type="button" className="evidence-location" onClick={(event) => onNavigate(evidenceTarget(finding, evidence), event.currentTarget)}>
                  <code>{formatRange(evidence)}</code></button>
                <p>{evidence.description}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="finding-section">
        <h3>修复提示词</h3>
        <div className="fix-prompt">{finding.fixPrompt}</div>
      </section>
      {rule && <details className="finding-trace"><summary>命中规范 · {rule.name ?? rule.id}</summary><Rule rule={rule} /></details>}
      <details className="finding-trace">
        <summary>评分与追溯</summary>
        <dl className="trace-metadata">
          <div><dt>产出模型</dt><dd><code>{finding.generatorModel.vendor} / {finding.generatorModel.model}</code><span className="model-provider">路由：{finding.generatorModel.provider}</span></dd></div>
          <div><dt>评分模型</dt><dd><code>{finding.graderModel.vendor} / {finding.graderModel.model}</code><span className="model-provider">路由：{finding.graderModel.provider}</span></dd></div>
          <div><dt>命中规范</dt><dd>{finding.ruleId ? <code>{finding.ruleId}</code> : "无规范"}</dd></div>
          <div><dt>产出时间</dt><dd><time dateTime={finding.generatedAt}>{formatDate(finding.generatedAt)}</time></dd></div>
        </dl>
        <h3>实际工具读取</h3>
        <p className="muted trace-hint">以下为运行时记录的文件读取，包含产出与评分阶段。</p>
        <ReadTrace ranges={finding.readFiles} />
      </details>
      <FindingDiscussion reviewId={reviewId} findingId={finding.id} />
    </div>
  );
}

/** 问题目录：标题、位置与处置状态，选中后代码画布切到对应位置。 */
function FindingIndex({ review, findingId, onSelect }: { review: ReviewDetail; findingId: string | null; onSelect: (id: string) => void }) {
  const findings = review.findings;
  const current = findings.findIndex((finding) => finding.id === findingId);
  const disposed = findings.filter((finding) => finding.status === "Resolved" || finding.status === "Dismissed").length;
  if (findings.length === 0) return null;
  return <>
    <div className="finding-stepper">
      <button type="button" className="text-button" disabled={current <= 0} onClick={() => onSelect(findings[current - 1]!.id)}>‹ 上一条</button>
      <span aria-live="polite">{current < 0 ? "–" : current + 1} / {findings.length} · 已处置 {disposed}</span>
      <button type="button" className="text-button" disabled={current >= findings.length - 1} onClick={() => onSelect(findings[current + 1]!.id)}>下一条 ›</button>
    </div>
    <ol className="finding-index" aria-label="问题列表">{findings.map((finding, index) => {
      const range = findingTarget(finding);
      return <li key={finding.id}><button type="button" aria-current={finding.id === findingId ? "true" : undefined} onClick={() => onSelect(finding.id)}>
        <span className="finding-index-title"><span className="finding-number">{String(index + 1).padStart(2, "0")}</span>
          <span className={`finding-count ${finding.severity}`}>{severityLabels[finding.severity]}</span>{finding.title}</span>
        <span className="finding-index-meta"><code title={formatRange(range)}>{formatRange({ ...range, path: range.path.slice(range.path.lastIndexOf("/") + 1) })}</code>
          <span className={`disposition-status disposition-${finding.status.toLowerCase()}`}>{findingStatusLabels[finding.status]}</span></span>
      </button></li>;
    })}</ol>
  </>;
}

function ReviewRounds({ review }: { review: ReviewDetail }) {
  const load = useCallback((signal: AbortSignal) => listReviewRounds(review.repositoryId, review.iid, signal), [review.repositoryId, review.iid]);
  const resource = useReviewResource(load, alwaysPoll);
  const rounds = resource.value;
  const latest = rounds?.[0];
  return <div className="review-rounds">
    {rounds && <label>评审轮次<select aria-label="评审轮次" value={review.id} onChange={(event) => { window.location.assign(`/?review=${encodeURIComponent(event.target.value)}`); }}>
      {rounds.map((round) => <option key={round.id} value={round.id}>第 {round.round} 轮 · {round.trigger === "manual" ? "手动发起" : "自动触发"} · {statusLabels[round.status]}</option>)}
    </select></label>}
    {latest && latest.id !== review.id && <a className="latest-round" href={`/?review=${encodeURIComponent(latest.id)}`}>查看最新第 {latest.round} 轮 · {statusLabels[latest.status]} →</a>}
    {resource.error && <div className="feedback feedback-error" role="alert"><p>历史轮次加载失败：{resource.error}</p><button className="button secondary-button" onClick={resource.refresh}>重试</button></div>}
  </div>;
}

function AbsentFindings({ review }: { review: ReviewDetail }) {
  const { previousReview, absentFindings } = review.comparison;
  if (!previousReview || absentFindings.length === 0) return null;
  return <details className="panel absent-findings">
    <summary>本轮未再出现 <span className="count">{absentFindings.length}</span></summary>
    <div className="panel-body"><p className="muted">以下 finding 出现在第 {previousReview.round} 轮，本轮没有匹配的结论。</p>
      {absentFindings.map((finding) => <article key={finding.id} className="absent-finding">
      <h3><a href={`/?review=${encodeURIComponent(previousReview.id)}#finding-${encodeURIComponent(finding.id)}`}>{finding.title}</a></h3>
      <p className="review-meta">{severityLabels[finding.severity]} · <code>{formatRange(finding.location)}</code></p>
      <p>{finding.description}</p>
      <DispositionSummary status={finding.status} disposition={finding.disposition} />
    </article>)}</div>
  </details>;
}



function RerunButton({ reviewId }: { reviewId: string }) {
  const requestId = useRef<string | null>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function rerun() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    requestId.current ??= requestIdentifier();
    try {
      const result = await rerunReview(reviewId, requestId.current);
      window.location.assign(`/?review=${encodeURIComponent(result.reviewId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "重跑请求未完成，请重试。");
      pending.current = false; setBusy(false);
    }
  }
  return <div className="rerun-action"><button className="button secondary-button" type="button" disabled={busy} onClick={() => void rerun()}>
    {busy ? "正在发起评审…" : error ? "重试发起评审" : "重新评审"}</button>
    {error && <p className="review-row-error" role="alert">{error}</p>}</div>;
}

function ViewedMarker({ review }: { review: ReviewSummary }) {
  const attempted = useRef("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  useEffect(() => {
    if (review.status !== "completed" || review.viewedAt) return;
    const key = `${review.id}:${attempt}`;
    if (attempted.current === key) return;
    attempted.current = key;
    void markReviewViewed(review.id).then(() => { setError(""); window.dispatchEvent(new Event("ureview:viewed")); }).catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "查看标记保存失败。");
    });
  }, [review.id, review.status, review.viewedAt, attempt]);
  return error ? <div className="feedback feedback-error" role="alert"><p>查看标记未保存：{error}</p>
    <button className="button secondary-button" onClick={() => setAttempt((value) => value + 1)}>重试保存</button></div> : null;
}

export function ReviewPage({ reviewId }: { reviewId: string }) {
  const load = useCallback((signal: AbortSignal) => getReview(reviewId, signal), [reviewId]);
  const resource = useReviewResource<ReviewDetail>(load, isActive);
  const review = resource.value;
  const refreshDisposition: RefreshDisposition = async (updated) => {
    if (updated) resource.update((current) => current ? { ...current, findings: current.findings.map((finding) => finding.id === updated.id ? mergeFindingDisposition(finding, updated) : finding) } : current);
    const result = await getReview(reviewId, new AbortController().signal);
    resource.update((current) => current?.id === result.id ? { ...result, findings: result.findings.map((finding) => {
      const previous = current.findings.find((item) => item.id === finding.id);
      return previous ? mergeFindingDisposition(previous, finding) : finding;
    }) } : current);
    window.dispatchEvent(new Event("ureview:viewed"));
  };
  type ReviewTab = "reading" | "code" | "trace";
  function tabFromUrl(): ReviewTab {
    const view = new URLSearchParams(window.location.search).get("view");
    return view === "diff" || view === "code" || window.location.hash.startsWith("#finding-") || window.location.hash.startsWith("#discussion-") ? "code" : view === "trace" ? "trace" : "reading";
  }
  /** 规范详情、未读提醒与上一轮参考的链接用 finding、discussion 参数或 #finding-、#discussion- 指向一条 finding。 */
  function findingFromUrl(): string | null {
    const params = new URLSearchParams(window.location.search);
    const hash = /^#(?:finding|discussion)-(.+)$/.exec(window.location.hash)?.[1];
    return params.get("finding") ?? params.get("discussion") ?? (hash ? decodeURIComponent(hash) : null);
  }
  const [tab, setTab] = useState<ReviewTab>(tabFromUrl);
  const [codeVisited, setCodeVisited] = useState(tab === "code");
  const [findingId, setFindingId] = useState(findingFromUrl);
  // 每递增一次表示一次主动选中，代码画布据此滚到卡片；从链接打开时算一次。
  const [focus, setFocus] = useState(() => findingFromUrl() ? 1 : 0);
  const [location, setLocation] = useState<CodeTarget | null>(null);
  const positions = useRef<Record<ReviewTab, number>>({ reading: 0, code: 0, trace: 0 });
  const origin = useRef<{ tab: ReviewTab; scroll: number; button: HTMLElement | null } | null>(null);
  const [hasOrigin, setHasOrigin] = useState(false);
  function restorePosition(next: ReviewTab, scroll = positions.current[next], button: HTMLElement | null = null) {
    setTab(next);
    if (next === "code") setCodeVisited(true);
    requestAnimationFrame(() => {
      window.scrollTo({ top: scroll, behavior: "instant" });
      button?.focus({ preventScroll: true });
    });
  }
  useEffect(() => {
    const pop = (event: PopStateEvent) => {
      const next = tabFromUrl();
      positions.current[tab] = window.scrollY;
      setFindingId(findingFromUrl());
      setLocation(event.state?.location ?? null);
      const source = origin.current;
      if (source && next === source.tab) {
        restorePosition(next, source.scroll, source.button);
        // 从证据位置回到代码与问题时差异要重新排版，原滚动位置不可靠，改为滚回原来的卡片。
        if (next === "code") setFocus((value) => value + 1);
        origin.current = null; setHasOrigin(false);
      } else restorePosition(next);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [tab]);
  function selectTab(next: ReviewTab) {
    if (next === tab) return;
    origin.current = null; setHasOrigin(false);
    positions.current[tab] = window.scrollY;
    window.history.pushState(null, "", `/?${new URLSearchParams({ review: reviewId, view: next })}`);
    restorePosition(next);
  }
  function navigateCode(range: CodeTarget, finding: string | null, button: HTMLElement | null) {
    positions.current[tab] = window.scrollY;
    if (!origin.current) origin.current = { tab, scroll: window.scrollY, button };
    setHasOrigin(true);
    const params = new URLSearchParams({ review: reviewId, view: "code" });
    if (finding) params.set("finding", finding);
    const historyMethod = tab === "code" && window.history.state?.reviewLocation === reviewId ? "replaceState" : "pushState";
    window.history[historyMethod]({ reviewLocation: reviewId, location: range }, "", `/?${params}`);
    setLocation({ ...range }); setFindingId(finding); setCodeVisited(true);
    if (tab !== "code") {
      setTab("code");
      requestAnimationFrame(() => document.getElementById("review-tabs")?.scrollIntoView({ block: "start" }));
    }
  }
  function openDiff(finding: ReviewFinding, button: HTMLButtonElement) {
    if (finding.anchor) navigateCode(finding.anchor, finding.id, button);
  }
  function closeDiff() {
    const source = origin.current;
    if (!source) return;
    if (window.history.state?.reviewLocation === reviewId) window.history.back();
    else {
      window.history.replaceState(null, "", `/?${new URLSearchParams({ review: reviewId, view: source.tab })}`);
      restorePosition(source.tab, source.scroll, source.button); origin.current = null; setHasOrigin(false);
    }
  }
  function selectFinding(id: string) {
    setFindingId(id); setLocation(null); setFocus((value) => value + 1);
    const params = new URLSearchParams({ review: reviewId, view: "code", finding: id });
    window.history.replaceState({ ...window.history.state, location: null }, "", `/?${params}`);
  }
  // 进入代码与问题且没有指定位置时，从第一条问题开始。
  useEffect(() => {
    if (!review || tab !== "code" || findingId || location) return;
    const first = review.findings.find((finding) => finding.status !== "Outdated") ?? review.findings[0];
    if (first) selectFinding(first.id);
  }, [review, tab, findingId, location]);
  return <><AppHeader currentPage="评审" /><main className="review-main review-workbench">
    {resource.loading && <p className="list-status" role="status">正在加载评审…</p>}
    {resource.error && <LoadError message={resource.error} retry={resource.refresh} />}
    {review && <>
      <a className="back-link" href={`/?repository=${encodeURIComponent(review.repositoryId)}`}>← 返回仓库</a>
      <div className="page-heading review-page-heading">
        <p className="eyebrow">{review.repositoryName} · PR !{review.iid}</p>
        <div className="review-topline"><h1>{review.title}</h1><StatusBadge status={review.status} /></div>
        <p className="review-meta">{review.author} · <code title={review.headSha}>{review.headSha.slice(0, 12)}</code> · 第 {review.round} 轮 · {review.trigger === "manual" ? "手动发起" : "自动触发"} · <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time></p>
        <div className="review-toolbar"><ReviewRounds review={review} /><div className="review-actions">
          {review.pullRequest && <a className="platform-link" href={review.pullRequest.webUrl} target="_blank" rel="noreferrer">在 GitLab 查看 PR ↗</a>}
          <ReviewSessionButton review={review} /><RerunButton reviewId={review.id} />
        </div></div>
        <ViewedMarker review={review} />
      </div>
      <ConclusionBar review={review} onFirstHigh={(button) => {
        const first = review.findings.find((finding) => finding.severity === "high" && finding.anchor && finding.status !== "Outdated");
        if (first) openDiff(first, button);
      }} />
      <nav id="review-tabs" className="review-tabs" aria-label="评审视图" role="tablist">
        {([["reading", "解读"], ["code", "代码与问题"], ["trace", "依据与追溯"]] as const).map(([value, label], index, tabs) =>
          <button id={`review-tab-${value}`} key={value} role="tab" aria-selected={tab === value} aria-controls={`review-panel-${value}`} tabIndex={tab === value ? 0 : -1}
            onClick={() => selectTab(value)} onKeyDown={(event) => {
              const nextIndex = event.key === "ArrowRight" ? (index + 1) % 3 : event.key === "ArrowLeft" ? (index + 2) % 3 : event.key === "Home" ? 0 : event.key === "End" ? 2 : -1;
              if (nextIndex < 0) return;
              event.preventDefault(); const next = tabs[nextIndex]![0]; selectTab(next); document.getElementById(`review-tab-${next}`)?.focus();
            }}>{label}{value === "code" && <span className="count">{review.findings.length}</span>}</button>)}
      </nav>
      <section id="review-panel-reading" role="tabpanel" aria-labelledby="review-tab-reading" hidden={tab !== "reading"}>
        <ReadingPanel key={reviewId} reviewId={reviewId} reviewStatus={review.status} title={review.title} round={review.round} files={review.files}
          onNavigate={(range, origin) => navigateCode(range, null, origin)}
          sessionAction={(failed) => <ReviewSessionButton review={review} kind="review_reading" full={failed || undefined} label={failed ? "查看失败会话" : "查看 Agent 会话"} />} />
      </section>
      <section id="review-panel-code" role="tabpanel" aria-labelledby="review-tab-code" hidden={tab !== "code"}>
        {hasOrigin && <button className="text-button return-to-reading" onClick={closeDiff}>← 返回{origin.current?.tab === "reading" ? "解读" : origin.current?.tab === "trace" ? "依据与追溯" : "刚才阅读的位置"}</button>}
        <div className="review-code-layout">
          <div className="review-code-pane">{codeVisited && <Suspense fallback={<p className="list-status" role="status">正在加载变更代码…</p>}>
            <ReviewDiff review={review} findingId={findingId} location={location} focus={focus} onSelectFinding={selectFinding}
              onReturn={hasOrigin ? closeDiff : undefined}
              renderFinding={(finding) => <FindingBody reviewId={review.id} finding={finding} rules={review.rules}
                onNavigate={(target, button) => navigateCode(target, finding.id, button)} onRefresh={refreshDisposition} />} />
          </Suspense>}</div>
          <aside className="review-findings-pane" aria-label="问题目录">
            <h2 className="section-heading">问题 <span className="count">{review.findings.length}</span></h2>
            <FindingIndex review={review} findingId={findingId} onSelect={selectFinding} />
            {review.status === "completed" && review.findings.length === 0 && <section className="panel empty-state"><h2>未发现高中危问题</h2><p>本轮没有需要展示的 finding。</p></section>}
            {review.foldedCount > 0 && <p className="folded-notice" role="status">还有 {review.foldedCount} 条已折叠</p>}
            <AbsentFindings review={review} /><PlatformDiscussions reviewId={review.id} />
          </aside>
        </div>
      </section>
      <section id="review-panel-trace" role="tabpanel" aria-labelledby="review-tab-trace" hidden={tab !== "trace"}>
        {review.scope.excludedDirectories.length > 0 && <section className="feedback review-exclusions"><strong>本轮按目录配置排除 {review.scope.excludedFileCount} 个变更文件</strong>
          <p>排除目录不参与评审，也不会作为代码上下文读取。</p><ul className="excluded-directory-list">{review.scope.excludedDirectories.map((directory) => <li key={directory}><code>{directory}</code></li>)}</ul></section>}
        <details id="review-context" className="panel review-trace"><summary>本轮选用规范 <span className="count">{review.rules.length}</span></summary>
          <div className="panel-body">{review.rules.length === 0 ? <p className="muted">本轮没有适用规范。</p> : review.rules.map((rule) => <Rule key={rule.id} rule={rule} />)}</div></details>
        <RejectedSubmissions review={review} />
        <details className="panel review-trace"><summary>本轮实际工具读取 <span className="count">{review.readFiles.length}</span></summary>
          <div className="panel-body"><ReadTrace ranges={review.readFiles} /></div></details>
      </section>
      {review.status === "completed" && <details className="review-participation-details"><summary>评审参与与看完标记</summary><ReviewParticipation reviewId={review.id} /></details>}
    </>}
  </main></>;
}
