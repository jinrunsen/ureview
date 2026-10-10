import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "./auth";
import { Icon } from "./icons";
import { AppHeader, formatDate } from "./layout";
import { getInbox, readNotification, type InboxReview } from "./inbox-api";
import { Onboarding } from "./onboarding";
import type { ReviewConclusion, ReviewStatus } from "./review-api";
import "./dashboard.css";
import "./inbox.css";

const statuses: Record<ReviewStatus, string> = { queued: "待评审", running: "进行中", completed: "已完成", failed: "失败" };
const conclusions: Record<ReviewConclusion["status"], string> = {
  queued: "待评审", running: "评审进行中", failed: "评审失败", requires_changes: "建议修改",
  manual_judgment: "需要人工判断", no_major_findings: "未发现高中危问题",
};
const message = (cause: unknown) => cause instanceof Error ? cause.message : "待办暂时无法读取，请重试。";

function ReviewSummary({ review, href }: { review: InboxReview; href?: string }) {
  return <div className="inbox-review">
    <div className="inbox-review-heading"><a href={href ?? `/?review=${encodeURIComponent(review.id)}`}>{review.title}</a>
      <span className={`status-badge dashboard-status-${review.status}`}>{statuses[review.status]}</span></div>
    <p className="inbox-meta"><Icon name="git" size={14} /><span>{review.repositoryName} !{review.iid}</span><time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time></p>
    <p className="inbox-reading">{review.readingSummary || "解读概述暂不可用。"}</p>
    <div className="inbox-review-footer"><span className={`inbox-conclusion inbox-conclusion-${review.conclusion.status}`}>{conclusions[review.conclusion.status]}</span><span>未处置 {review.pendingCount}</span></div>
  </div>;
}

function ReviewSection({ title, description, reviews, id }: { title: string; description: string; reviews: InboxReview[]; id: string }) {
  return <section className="dashboard-surface inbox-section" aria-labelledby={id}>
    <div className="dashboard-section-heading"><div><h2 id={id}>{title}<span className="inbox-section-count">{reviews.length}</span></h2><p>{description}</p></div></div>
    {reviews.length ? <ul className="inbox-list">{reviews.map((review) => <li key={review.id}><ReviewSummary review={review} /></li>)}</ul>
      : <p className="inbox-empty">{title === "待我评审" ? "目前没有指派给你的 PR。" : "目前没有你提交的开放 PR。"}</p>}
  </section>;
}

export function DashboardPage() {
  const { user } = useSession();
  const [data, setData] = useState<Awaited<ReturnType<typeof getInbox>>>();
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(true);
  const [reading, setReading] = useState<string[]>([]);
  const [onboardingRevision, setOnboardingRevision] = useState(0);
  const sequence = useRef(0);
  const refresh = useCallback(async () => {
    const requestId = ++sequence.current;
    setRefreshing(true);
    setOnboardingRevision((current) => current + 1);
    try { const result = await getInbox(); if (requestId === sequence.current) { setData(result); setError(""); } }
    catch (cause) { if (requestId === sequence.current) setError(message(cause)); }
    finally { if (requestId === sequence.current) setRefreshing(false); }
  }, []);
  useEffect(() => { void refresh(); return () => { ++sequence.current; }; }, [refresh]);
  async function markRead(id: string) {
    if (reading.includes(id)) return;
    setReading((current) => [...current, id]);
    try { await readNotification(id); window.dispatchEvent(new Event("ureview:unread-changed")); await refresh(); }
    catch (cause) { setError(message(cause)); }
    finally { setReading((current) => current.filter((value) => value !== id)); }
  }
  return <><AppHeader currentPage="我的待办" /><main className="dashboard-page inbox-page">
    <div className="page-title-row"><div><p className="dashboard-team-label">{user?.teamName}</p><h1>我的待办</h1><p className="page-description">查看指派给你的 PR、你提交的 PR 和讨论提醒。</p></div>
      <button className="button secondary-button" type="button" disabled={refreshing} onClick={() => void refresh()}><Icon name="refresh" size={16} />{refreshing ? "正在刷新" : "刷新"}</button></div>
    {user?.role === "admin" && <Onboarding key={`${user.userId}:${user.teamId}`} refreshKey={onboardingRevision} />}
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}
    {!data && refreshing && <p role="status" className="dashboard-loading">正在读取我的待办…</p>}
    {data && <>
      {!data.linked && <section className="inbox-link-notice" aria-label="关联 GitLab 账号"><Icon name="git" size={24} /><div><h2>关联 GitLab 用户名</h2><p>在「我的账号」关联 GitLab 用户名后，可查看待你评审和你提交的 PR。</p><a className="button secondary-button" href="/?account=1">前往我的账号</a></div></section>}
      <div className="inbox-sections" aria-busy={refreshing}>
        {data.linked && <><ReviewSection id="inbox-assigned" title="待我评审" description="你是评审人或指派人的开放 PR，显示最新一轮。" reviews={data.toReview} />
          <ReviewSection id="inbox-authored" title="我提交的" description="你提交的开放 PR，显示最新一轮。" reviews={data.submitted} /></>}
        <section className="dashboard-surface inbox-section" aria-labelledby="inbox-notifications"><div className="dashboard-section-heading"><div><h2 id="inbox-notifications">提到我的<span className="inbox-section-count">{data.notifications.filter((item) => !item.readAt).length} 未读</span></h2><p>讨论中的提及与回复，未读提醒在前。</p></div></div>
          {data.notifications.length ? <ul className="inbox-list">{data.notifications.map((item) => <li key={item.id} className={!item.readAt ? "inbox-unread" : undefined}>
            <div className="inbox-notification-heading"><span>{item.authorName} {item.kind === "mention" ? "提到了你" : "回复了你"}{!item.readAt && <strong>未读</strong>}</span><time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time></div>
            <ReviewSummary review={item.review} href={`/?review=${encodeURIComponent(item.reviewId)}&discussion=${encodeURIComponent(item.findingId)}#discussion-${encodeURIComponent(item.findingId)}`} />
            <p className="inbox-finding-title">{item.findingTitle}</p><p className="inbox-comment">{item.body}</p>
            {!item.readAt && <button type="button" className="button secondary-button inbox-read-button" disabled={reading.includes(item.id)} onClick={() => void markRead(item.id)}>{reading.includes(item.id) ? "正在标记…" : "标记已读"}</button>}
          </li>)}</ul> : <p className="inbox-empty">目前没有提及或回复提醒。</p>}
        </section>
      </div>
    </>}
  </main></>;
}
