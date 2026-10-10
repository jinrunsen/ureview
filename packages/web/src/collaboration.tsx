import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import {
  addComment, finishReview, getComments, getMembers, getParticipation, getPlatformDiscussions,
  getUnread, readComments, type DiscussionThread, type Participation, type PlatformThread, type TeamMember, type Unread,
} from "./collaboration-api";
import { requestIdentifier } from "./request-id";
import "./collaboration.css";

function message(error: unknown) { return error instanceof Error ? error.message : "操作未完成，请稍后重试"; }
function time(value: string) { return new Date(value).toLocaleString("zh-CN"); }
const refreshUnread = () => window.dispatchEvent(new Event("ureview:unread-changed"));

export function FindingDiscussion({ reviewId, findingId }: { reviewId: string; findingId: string }) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get("discussion") === findingId);
  const section = useRef<HTMLElement>(null);
  const navigateOnLoad = useRef(open);
  const acknowledged = useRef(new Set<string>());
  const acknowledgmentsInFlight = useRef(new Set<string>());
  const openRef = useRef(open);
  openRef.current = open;
  const [thread, setThread] = useState<DiscussionThread>();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [parentId, setParentId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const refresh = useCallback(async () => {
    const result = await getComments(reviewId, findingId);
    if (!openRef.current) return;
    setThread(result);
    setError("");
  }, [reviewId, findingId]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void Promise.all([refresh(), getMembers()]).then(([, result]) => { if (active) setMembers(result.members); }).catch((reason) => { if (active) setError(message(reason)); });
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh().catch((reason) => { if (active) setError(message(reason)); }); }, 15_000);
    return () => { active = false; clearInterval(timer); };
  }, [open, refresh]);
  useLayoutEffect(() => {
    if (!open || !thread || !navigateOnLoad.current || !section.current) return;
    navigateOnLoad.current = false;
    section.current.scrollIntoView({ block: "start", behavior: "instant" });
    section.current.focus({ preventScroll: true });
  }, [open, thread]);
  useEffect(() => {
    const target = section.current;
    if (!open || !thread || !target) return;
    let active = true;
    const acknowledgeVisible = () => {
      if (!active || !openRef.current || document.visibilityState !== "visible") return;
      const rectangle = target.getBoundingClientRect();
      if (rectangle.bottom <= 0 || rectangle.top >= window.innerHeight) return;
      const ids = thread.unreadIds.filter((id) => !acknowledged.current.has(id) && !acknowledgmentsInFlight.current.has(id));
      if (!ids.length) return;
      for (const id of ids) acknowledgmentsInFlight.current.add(id);
      void readComments(reviewId, findingId, ids).then(() => {
        for (const id of ids) acknowledged.current.add(id);
        refreshUnread();
      }).catch((reason) => { if (active) setError(message(reason)); }).finally(() => {
        for (const id of ids) acknowledgmentsInFlight.current.delete(id);
      });
    };
    const observer = new IntersectionObserver(acknowledgeVisible);
    observer.observe(target);
    document.addEventListener("visibilitychange", acknowledgeVisible);
    acknowledgeVisible();
    return () => { active = false; observer.disconnect(); document.removeEventListener("visibilitychange", acknowledgeVisible); };
  }, [open, thread, reviewId, findingId]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const input = { body: body.trim(), mentions, parentId };
      const key = JSON.stringify(input);
      if (pending.current?.key !== key) pending.current = { key, id: requestIdentifier() };
      await addComment(reviewId, findingId, { ...input, requestId: pending.current.id });
      setBody(""); setMentions([]); setParentId(undefined); pending.current = undefined;
      await refresh(); refreshUnread();
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  const reply = thread?.comments.find((item) => item.id === parentId);
  return <section ref={section} tabIndex={-1} className="finding-discussion" id={`discussion-${findingId}`} aria-label="Finding 讨论">
    <button type="button" className="button secondary-button" aria-expanded={open} onClick={() => { navigateOnLoad.current = false; setOpen(!open); }}>讨论{thread ? `（${thread.comments.length}）` : ""}</button>
    {open && <div className="discussion-content">
      {error && <p role="alert">{error}</p>}
      {!thread && !error && <p role="status">正在读取讨论…</p>}
      {thread?.comments.length === 0 && <p className="muted">还没有讨论。</p>}
      <ol className="discussion-comments">{thread?.comments.map((item) => {
        const parent = thread.comments.find((candidate) => candidate.id === item.parentId);
        return <li key={item.id} className={item.parentId ? "discussion-reply" : ""}>
          <div className="discussion-meta"><strong>{item.authorName}</strong><time dateTime={item.createdAt}>{time(item.createdAt)}</time></div>
          {parent && <p className="muted">回复 {parent.authorName}：{parent.body.slice(0, 80)}{parent.body.length > 80 ? "…" : ""}</p>}
          <p className="discussion-body">{item.body}</p>
          {item.mentions.length > 0 && <p className="discussion-mentions">{item.mentions.map((id) => `@${members.find((member) => member.id === id)?.name ?? "团队成员"}`).join(" ")}</p>}
          <button type="button" className="text-button" onClick={() => { setParentId(item.id); textarea.current?.focus(); }}>回复</button>
        </li>;
      })}</ol>
      <form onSubmit={(event) => void submit(event)} className="discussion-form">
        {reply && <p>回复 {reply.authorName} <button type="button" className="text-button" onClick={() => setParentId(undefined)}>取消回复</button></p>}
        <label htmlFor={`comment-${findingId}`}>新讨论请在下方</label>
        <textarea ref={textarea} id={`comment-${findingId}`} value={body} maxLength={4000} required rows={3} onChange={(event) => setBody(event.target.value)} placeholder="写下问题或补充说明" />
        <label htmlFor={`mention-${findingId}`}>@ 团队成员</label>
        <select id={`mention-${findingId}`} value="" onChange={(event) => { const id = event.target.value; if (id && !mentions.includes(id)) setMentions([...mentions, id]); }}>
          <option value="">选择需要提醒的成员</option>{members.filter((member) => !mentions.includes(member.id)).map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select>
        {mentions.length > 0 && <div className="discussion-mention-tags">{mentions.map((id) => <button type="button" key={id} onClick={() => setMentions(mentions.filter((item) => item !== id))}>@{members.find((member) => member.id === id)?.name} ×</button>)}</div>}
        <button type="submit" className="button primary-button" disabled={busy || !body.trim()}>{busy ? "正在发送…" : parentId ? "发送回复" : "发送讨论"}</button>
      </form>
    </div>}
  </section>;
}

export function UnreadIndicator() {
  const [unread, setUnread] = useState<Unread>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => { void getUnread().then((result) => { if (active) { setUnread(result); setError(false); } }).catch(() => { if (active) setError(true); }); };
    load(); const timer = setInterval(load, 15_000); window.addEventListener("ureview:unread-changed", load);
    return () => { active = false; clearInterval(timer); window.removeEventListener("ureview:unread-changed", load); };
  }, []);
  if (error) return <span className="muted" title="未读提示暂时不可用">讨论提示暂不可用</span>;
  const first = unread?.threads[0];
  if (!first) return <span className="unread-indicator">没有未读讨论</span>;
  return <a className="unread-indicator unread-active" href={`/?review=${encodeURIComponent(first.reviewId)}&discussion=${encodeURIComponent(first.findingId)}#discussion-${encodeURIComponent(first.findingId)}`} aria-label={`${unread?.count} 条未读讨论`}>讨论 <strong>{unread?.count}</strong></a>;
}

export function ReviewParticipation({ reviewId }: { reviewId: string }) {
  const [value, setValue] = useState<Participation>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => { void getParticipation(reviewId).then((result) => { if (active) { setValue(result); setError(""); } }).catch((reason) => { if (active) setError(message(reason)); }); };
    load(); const timer = window.setInterval(load, 15_000); window.addEventListener("ureview:viewed", load);
    return () => { active = false; clearInterval(timer); window.removeEventListener("ureview:viewed", load); };
  }, [reviewId]);
  const completed = Boolean(value?.participants.find((item) => item.userId === value.currentUserId)?.completedAt);
  return <section className="review-participation" aria-label="评审参与情况">
    <div><strong>评审参与</strong>{value?.participants.length ? <ul className="review-participant-list">
      {value.participants.map((item) => <li key={item.userId}>
        <strong>{item.name}</strong>
        <span>已查看 <time dateTime={item.viewedAt}>{time(item.viewedAt)}</time></span>
        {item.completedAt
          ? <span>已看完 <time dateTime={item.completedAt}>{time(item.completedAt)}</time></span>
          : <span className="muted">尚未看完</span>}
      </li>)}
    </ul> : <p>还没有人查看</p>}</div>
    <button className="button secondary-button" disabled={busy || !value} type="button" onClick={() => {
      setBusy(true); setError(""); void finishReview(reviewId, !completed).then(setValue).catch((reason) => setError(message(reason))).finally(() => setBusy(false));
    }}>{busy ? "正在保存…" : completed ? "标为尚未看完" : "这次评审我看完了"}</button>
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function PlatformDiscussions({ reviewId }: { reviewId: string }) {
  const [open, setOpen] = useState(false);
  const [discussions, setDiscussions] = useState<PlatformThread[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true); setError("");
    try { const result = await getPlatformDiscussions(reviewId); setDiscussions(result.discussions); setError(result.error ?? ""); }
    catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }, [reviewId]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  return <section className="platform-discussions">
    <button type="button" className="button secondary-button" aria-expanded={open} onClick={() => setOpen(!open)}>GitLab 历史人工讨论（只读）</button>
    {open && <div><p className="muted">新讨论请在对应问题的讨论区进行。</p>
      {busy && <p role="status">正在读取 GitLab 讨论…</p>}
      {error && <p role="alert">{error} <button className="text-button" onClick={() => void load()} disabled={busy}>重新读取</button></p>}
      {!busy && !error && discussions?.length === 0 && <p>GitLab 上没有人工讨论。</p>}
      {discussions?.map((thread) => <article key={thread.id} className="platform-thread"><p className="muted">{thread.resolved ? "GitLab 已解决" : "GitLab 讨论"}</p>{thread.notes.map((note) => <div key={note.id}><div className="discussion-meta"><strong>{note.author}</strong><time dateTime={note.createdAt}>{time(note.createdAt)}</time><a href={note.url} target="_blank" rel="noreferrer">原文</a></div><p className="discussion-body">{note.body}</p></div>)}</article>)}
    </div>}
  </section>;
}

export { NotificationSettings } from "./notification-settings";
