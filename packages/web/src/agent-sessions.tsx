import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ApiError } from "./api";
import { useSession } from "./auth";
import { readSessionPreferences, saveSessionPreferences } from "./agent-session-preferences";
import { AppHeader, formatDate } from "./layout";
import { Icon } from "./icons";
import { getReview, type ReviewSummary } from "./review-api";
import { resolveReviewPage } from "./review-pagination";
import { agentSessionKindLabels, agentSessionPageUrl, agentSessionSource, agentSessionStatusLabels, getAgentSession, listAgentSessions, preferredAgentSession,
  type AgentSessionFilters, type AgentSessionKind, type AgentSessionList, type AgentSessionStatus, type AgentSessionSummary } from "./agent-sessions-api";
import "./agent-sessions.css";

type SessionTarget = { type: "session"; id: string } | { type: "review"; review: ReviewSummary; kind?: AgentSessionKind; full?: boolean; failed?: boolean } | { type: "rule"; id: string; title: string };
type SessionView = "chat" | "trajectory";
type OpenSessionViewer = (target: SessionTarget, opener?: HTMLElement) => void;
const SessionViewerContext = createContext<OpenSessionViewer | null>(null);
export function useAgentSessionViewer() {
  const open = useContext(SessionViewerContext);
  if (!open) throw new Error("会话查看器尚未初始化。");
  return open;
}
export function AgentSessionProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<SessionTarget | null>(null);
  const { user } = useSession();
  const opener = useRef<HTMLElement | null>(null);
  const open = useCallback<OpenSessionViewer>((value, source) => {
    opener.current = source ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setTarget(value);
  }, []);
  return <SessionViewerContext.Provider value={open}>{children}{target && <AgentSessionShell target={target} userId={user!.userId} opener={opener.current} onClose={() => setTarget(null)} />}</SessionViewerContext.Provider>;
}
export function ReviewSessionButton({ review, kind, full, failed, label = "查看 Agent 会话" }: { review: ReviewSummary; kind?: AgentSessionKind; full?: boolean; failed?: boolean; label?: string }) {
  const open = useAgentSessionViewer();
  return <button className="button secondary-button" type="button" onClick={(event) => open({ type: "review", review, kind, full, failed }, event.currentTarget)}><Icon name="session" size={15} />{label}</button>;
}
export function RuleSessionButton({ sessionId, title }: { sessionId: string; title: string }) {
  const open = useAgentSessionViewer();
  return <button className="button secondary-button" type="button" onClick={(event) => open({ type: "rule", id: sessionId, title }, event.currentTarget)}><Icon name="session" size={15} />查看 Agent 会话</button>;
}
function SessionStatus({ session }: { session: AgentSessionSummary }) {
  return <span className={`review-status review-status-${session.status}`}>{agentSessionStatusLabels[session.status]}</span>;
}
function SessionObject({ session }: { session: AgentSessionSummary }) {
  return session.reviewId ? <>{session.repositoryName} · PR !{session.prNumber} · 第 {session.reviewRound} 轮</> : <>规范生成 · {session.title}</>;
}

export function AgentSessionPage({ sessionId }: { sessionId: string }) {
  const { user } = useSession();
  const [target] = useState<SessionTarget>({ type: "session", id: sessionId });
  return <AgentSessionShell target={target} userId={user!.userId} standalone opener={null} onClose={() => window.location.assign("/?sessions=1")} />;
}

function SessionFrame({ session, view, frame }: { session: AgentSessionSummary; view: SessionView; frame: RefObject<HTMLIFrameElement | null> }) {
  const [initialView] = useState(view);
  return <iframe ref={frame} className="agent-session-frame" title={`dsh 原始会话：${agentSessionKindLabels[session.kind]}`}
    src={`/agent-session-viewer/?session=${encodeURIComponent(session.id)}&embedded=1&view=${initialView}`} />;
}

function AgentSessionShell({ target, userId, standalone = false, opener: source, onClose }: { target: SessionTarget; userId: string; standalone?: boolean; opener: HTMLElement | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const opener = useRef(source);
  const close = useRef(onClose); close.current = onClose;
  const titleId = useId();
  const [preferences, setPreferences] = useState(() => readSessionPreferences(userId));
  const width = preferences.width;
  const [full, setFull] = useState(() => target.type === "review" && target.full !== undefined ? target.full : preferences.full);
  const [view, setView] = useState<SessionView>(() => new URLSearchParams(location.search).get("view") === "trajectory" ? "trajectory" : "chat");
  const currentView = useRef(view); currentView.current = view;
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [review, setReview] = useState(target.type === "review" ? target.review : null);
  const [kind, setKind] = useState<AgentSessionKind | null>(target.type === "review" ? target.kind ?? null : null);
  const [selectedId, setSelectedId] = useState<string | null>(target.type === "session" ? target.id : null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [frameAttempt, setFrameAttempt] = useState(0);
  const pointer = useRef<{ id: number; left: number; width: number } | null>(null);
  const changeWidth = (next: number) => {
    const value = { ...preferences, width: Math.max(45, Math.min(100, next)) };
    setPreferences(value); saveSessionPreferences(userId, value);
  };
  const toggleFull = () => {
    const value = { ...preferences, full: !full };
    setFull(value.full); setPreferences(value); saveSessionPreferences(userId, value);
  };
  const changeView = (next: SessionView) => {
    setView(next);
    frame.current?.contentWindow?.postMessage({ type: "ureview:agent-session-view", view: next }, location.origin);
  };
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menuOpen]);
  useEffect(() => {
    const element = dialog.current;
    const scroll = { x: window.scrollX, y: window.scrollY };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element?.showModal();
    function message(event: MessageEvent) {
      if (event.origin !== location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "ureview:agent-session-close" && !standalone) close.current();
      if (event.data?.type === "ureview:agent-session-ready") frame.current?.contentWindow?.postMessage({ type: "ureview:agent-session-view", view: currentView.current }, location.origin);
      if (event.data?.type === "ureview:agent-session-view" && ["chat", "trajectory"].includes(event.data.view)) setView(event.data.view);
    }
    window.addEventListener("message", message);
    return () => {
      element?.close(); document.body.style.overflow = overflow;
      window.removeEventListener("message", message);
      if (standalone) return;
      queueMicrotask(() => {
        if (element?.open) return;
        window.scrollTo({ left: scroll.x, top: scroll.y, behavior: "instant" });
        if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
      });
    };
  }, [standalone]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      let denied = false;
      try {
        let items: AgentSessionSummary[];
        let initial: AgentSessionSummary | undefined;
        if (target.type === "session") {
          initial = (await getAgentSession(target.id, controller.signal)).session;
          const filters = initial.reviewId ? { reviewId: initial.reviewId } : { ruleSessionId: initial.ruleSessionId! };
          items = (await listAgentSessions({ ...filters, page: 1, pageSize: 100 }, controller.signal)).items;
          if (!items.some(item => item.id === initial!.id)) items = [initial, ...items];
        } else {
          const filters = target.type === "review" ? { reviewId: target.review.id } : { ruleSessionId: target.id };
          items = (await listAgentSessions({ ...filters, page: 1, pageSize: 100 }, controller.signal)).items;
          if (target.type === "review" && (target.review.status === "running" || target.review.status === "queued")) {
            const latest = await getReview(target.review.id, controller.signal);
            if (!controller.signal.aborted) setReview(latest);
          }
        }
        if (controller.signal.aborted) return;
        setSessions(items); setError(""); setLoading(false);
        const preferred = target.type === "review" && target.failed ? preferredAgentSession(items.filter(item => item.kind !== "review_reading")) : preferredAgentSession(items);
        setKind((current) => current ?? initial?.kind ?? preferred?.kind ?? null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        denied = cause instanceof ApiError && [401, 403, 404].includes(cause.status);
        if (denied) setSessions([]);
        setError(cause instanceof Error ? cause.message : "会话加载失败，请重试。"); setLoading(false);
      }
      if (!controller.signal.aborted && !denied) timer = setTimeout(() => void refresh(), 3000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [target, attempt]);
  const currentKind = kind ?? "review_generator";
  const isReview = target.type === "review" || sessions.some(item => item.reviewId);
  const candidates = isReview ? sessions.filter(item => item.kind === currentKind) : sessions;
  const selected = candidates.find(item => item.id === selectedId) ?? preferredAgentSession(candidates);
  const title = target.type === "review" ? target.review.title : target.type === "rule" ? target.title : selected?.title || "Agent 会话";
  const context = review ? `${review.repositoryName} · PR !${review.iid} · 第 ${review.round} 轮 · ${review.headSha.slice(0, 12)}`
    : selected?.reviewId ? `${selected.repositoryName} · PR !${selected.prNumber} · 第 ${selected.reviewRound} 轮 · ${selected.headSha?.slice(0, 12)}` : "";
  const waiting = review?.status === "running" || review?.status === "queued";
  const emptyTitle = waiting ? currentKind === "review_grader" ? "评分阶段尚未开始" : "等待评审创建会话" : "本轮未保存会话记录";
  const stages = isReview ? ["review_reading", "review_generator", "review_grader"] as const : ["rule_generation"] as const;
  const content = <>
    {!standalone && <div className="agent-session-resizer" role="separator" aria-label="调整会话面板宽度" aria-orientation="vertical" tabIndex={full ? -1 : 0}
      aria-valuemin={45} aria-valuemax={100} aria-valuenow={width} onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); changeWidth(width + (event.key === "ArrowLeft" ? 5 : -5)); }
      }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointer.current = { id: event.pointerId, left: event.clientX, width }; }}
      onPointerMove={(event) => { if (pointer.current?.id === event.pointerId) changeWidth(pointer.current.width + (pointer.current.left - event.clientX) / window.innerWidth * 100); }}
      onPointerUp={(event) => { pointer.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { pointer.current = null; }} />}
    <header className="agent-session-drawer-header">
      <div className="agent-session-heading"><h2 id={titleId} title={title}>{title}</h2>{context && <span className="agent-session-context" title={context}>{context}</span>}</div>
      <nav className="agent-session-stages" aria-label="评审会话阶段">{stages.map(stage => {
        const item = selected?.kind === stage ? selected : preferredAgentSession(sessions.filter(session => session.kind === stage));
        const status = item ? agentSessionStatusLabels[item.status] : "未运行";
        return <button key={stage} type="button" aria-pressed={currentKind === stage} aria-label={`${agentSessionKindLabels[stage]} · ${status}`} title={`${agentSessionKindLabels[stage]} · ${status}${item ? ` · ${item.model}` : ""}`}
          onClick={() => { setKind(stage); setSelectedId(null); }}><span className={`agent-session-dot agent-session-dot-${item?.status ?? "idle"}`} aria-hidden="true" /><span className="agent-session-stage-label">{agentSessionKindLabels[stage]}</span><span className="agent-session-stage-short" aria-hidden="true">{stage === "review_reading" ? "解读" : stage === "review_generator" ? "评审" : stage === "review_grader" ? "评分" : "规范"}</span></button>;
      })}</nav>
      <span className="agent-session-readonly" title="只读查看已保存的会话">只读</span>
      <div className="agent-session-window-actions">
        <div ref={menu} className="agent-session-menu" data-open={menuOpen} onKeyDown={event => { if (event.key === "Escape" && menuOpen) { event.preventDefault(); event.stopPropagation(); setMenuOpen(false); menu.current?.querySelector<HTMLButtonElement>(".agent-session-menu-toggle")?.focus(); } }}>
          <button type="button" className="icon-button agent-session-menu-toggle" aria-label="会话操作" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><Icon name="menu" size={16} /></button>
          <div className="agent-session-actions" onClick={event => { if ((event.target as HTMLElement).closest("button, a") && menuOpen) { setMenuOpen(false); menu.current?.querySelector<HTMLButtonElement>(".agent-session-menu-toggle")?.focus(); } }}>
            <nav className="agent-session-views" aria-label="会话视图" title="展开用时、工作步骤和工具调用，可查看工具名称、参数和结果。">
              <button type="button" aria-pressed={view === "chat"} disabled={!selected} onClick={() => changeView("chat")}>对话</button><button type="button" aria-pressed={view === "trajectory"} disabled={!selected} onClick={() => changeView("trajectory")}>原始轨迹</button>
            </nav>
            {selected && <><a className="icon-button" href={agentSessionSource(selected)} aria-label="打开来源页面" title="打开来源页面"><Icon name="arrow-up-right" size={16} /><span className="agent-session-action-label">打开来源页面</span></a>
              <a className="icon-button" href={agentSessionPageUrl(selected.id, view)} target="_blank" rel="noopener noreferrer" aria-label="在新标签页打开" title="在新标签页打开"><Icon name="copy" size={16} /><span className="agent-session-action-label">在新标签页打开</span></a></>}
            {!standalone && <button className="icon-button agent-session-fullscreen" type="button" aria-label={full ? "退出全屏会话" : "全屏查看会话"} title={full ? "退出全屏会话" : "全屏查看会话"} onClick={toggleFull}><Icon name={full ? "collapse" : "expand"} size={16} /><span className="agent-session-action-label">{full ? "退出全屏会话" : "全屏查看会话"}</span></button>}
            {selected && candidates.length > 1 && <label className="agent-session-attempts">会话<select aria-label="阶段会话" value={selected.id} onChange={event => setSelectedId(event.target.value)}>{candidates.map((item, index) => <option key={item.id} value={item.id}>{index + 1} · {formatDate(item.createdAt)} · {agentSessionStatusLabels[item.status]}</option>)}</select></label>}
          </div>
        </div>
        <button autoFocus={!standalone} className="icon-button" type="button" onClick={onClose} aria-label={standalone ? "返回会话列表" : "关闭 Agent 会话"} title={standalone ? "返回会话列表" : "关闭 Agent 会话"}><Icon name="close" size={16} /></button>
      </div>
    </header>
    {error && <div className="agent-session-error" role="alert"><span>{error}</span><button className="button secondary-button" onClick={() => { setAttempt(value => value + 1); setFrameAttempt(value => value + 1); }}>重新连接</button></div>}
    {loading && <div className="agent-session-empty" role="status"><span className="spinner" /><p>正在读取会话…</p></div>}
    {!loading && selected && <SessionFrame key={`${selected.id}:${frameAttempt}`} session={selected} view={view} frame={frame} />}
    {!loading && !selected && !error && <div className="agent-session-empty" role="status"><Icon name={waiting ? "clock" : "session"} size={30} /><h3>{target.type === "rule" ? "本会话尚无原始记录" : emptyTitle}</h3>
      <p>{waiting ? "会话创建后会自动显示在这里。" : review?.failureReason || "已保存的会话才可回看。查看记录不会重新发起任务。"}</p>
      {review?.status === "failed" && <span className="review-status review-status-failed">本轮评审失败</span>}
    </div>}
  </>;
  if (standalone) return <main className="agent-session-page" aria-labelledby={titleId}>{content}</main>;
  return <dialog ref={dialog} className={`agent-session-drawer${full ? " agent-session-full" : ""}`} style={{ "--session-width": `${width}vw` } as CSSProperties}
    aria-labelledby={titleId} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => {
      if (event.target === event.currentTarget && event.clientX < event.currentTarget.getBoundingClientRect().left) onClose();
    }}>{content}</dialog>;
}

export function AgentSessionsPage() {
  const params = new URLSearchParams(window.location.search);
  const [kind, setKind] = useState<AgentSessionKind | "">(() => Object.hasOwn(agentSessionKindLabels, params.get("kind") ?? "") ? params.get("kind") as AgentSessionKind : "");
  const [status, setStatus] = useState<AgentSessionStatus | "">(() => Object.hasOwn(agentSessionStatusLabels, params.get("status") ?? "") ? params.get("status") as AgentSessionStatus : "");
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [query, setQuery] = useState(search);
  const [page, setPage] = useState(() => {
    const value = Number(params.get("page"));
    return Number.isSafeInteger(value) && value > 0 ? value : 1;
  });
  const [result, setResult] = useState<AgentSessionList | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const open = useAgentSessionViewer();
  const initialSession = useRef(params.get("session"));
  useEffect(() => { if (initialSession.current) { open({ type: "session", id: initialSession.current }); initialSession.current = null; } }, [open]);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [search, query]);
  useEffect(() => {
    const filters: AgentSessionFilters = { kind: kind || undefined, status: status || undefined, search: query || undefined, page, pageSize: 20 };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setResult(null); setError("");
    async function refresh() {
      let denied = false;
      try {
        const value = await listAgentSessions(filters, controller.signal);
        if (!controller.signal.aborted) { setResult(value); setError(""); }
      } catch (cause) {
        if (controller.signal.aborted) return;
        denied = cause instanceof ApiError && [401, 403].includes(cause.status);
        if (denied) setResult(null);
        setError(cause instanceof Error ? cause.message : "会话列表加载失败。");
      }
      if (!controller.signal.aborted && !denied) timer = setTimeout(() => void refresh(), 5000);
    }
    void refresh();
    const next = new URLSearchParams({ sessions: "1" });
    if (kind) next.set("kind", kind); if (status) next.set("status", status); if (query) next.set("search", query); if (page > 1) next.set("page", String(page));
    window.history.replaceState(null, "", `/?${next}`);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [kind, status, query, page, attempt]);
  const pagination = resolveReviewPage(page, result?.total ?? 0, result?.pageSize ?? 20);
  useEffect(() => { if (result && pagination.page !== page) setPage(pagination.page); }, [result, pagination.page, page]);
  return <><AppHeader currentPage="运行记录" /><main className="agent-sessions-main"><div className="page-title-row"><div><p className="eyebrow">运行过程</p><h1>运行记录</h1><p className="page-description">查看评审与规范生成的原始会话，包括消息、工具调用和运行错误。</p></div><span className="agent-sessions-readonly"><Icon name="session" size={16} />只读查看</span></div>
    <section className="panel" aria-labelledby="agent-sessions-heading"><div className="panel-heading list-heading"><div><h2 id="agent-sessions-heading">会话记录 {result && <span className="count">{result.total}</span>}</h2><p>显示当前团队中你有权查看的会话。</p></div><button className="button secondary-button" type="button" onClick={() => setAttempt((value) => value + 1)}><Icon name="refresh" size={14} />刷新</button></div>
      <div className="agent-session-filters"><label>业务类型<select value={kind} onChange={(event) => { setKind(event.target.value as AgentSessionKind | ""); setPage(1); }}><option value="">全部类型</option>{Object.entries(agentSessionKindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>运行状态<select value={status} onChange={(event) => { setStatus(event.target.value as AgentSessionStatus | ""); setPage(1); }}><option value="">全部状态</option>{Object.entries(agentSessionStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="agent-session-search">关联对象<input type="search" placeholder="搜索会话标题、仓库或 PR" value={search} maxLength={200} onChange={(event) => setSearch(event.target.value)} /></label></div>
      {error && <div className="list-error" role="alert"><p>{error}</p><button className="button secondary-button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>}
      {!result && !error && <p className="list-status" role="status">正在加载会话…</p>}
      {result?.items.length === 0 && <div className="empty-state"><Icon name="session" size={28} /><h3>{kind || status || query ? "没有符合条件的会话" : "暂无可查看的会话"}</h3><p>{kind || status || query ? "尝试调整筛选条件。" : "评审或规范生成运行后，已保存的会话会显示在这里。"}</p></div>}
      {result && result.items.length > 0 && <div className="table-scroll"><table className="data-table agent-session-table"><thead><tr><th>会话与关联对象</th><th>业务类型</th><th>状态</th><th>模型</th><th>创建时间</th><th>最近活动</th></tr></thead><tbody>{result.items.map((session) => <tr key={session.id}><td><button className="table-primary" type="button" onClick={(event) => open({ type: "session", id: session.id }, event.currentTarget)}>{session.title}</button><span className="table-secondary"><a href={agentSessionSource(session)}><SessionObject session={session} /></a></span></td><td>{agentSessionKindLabels[session.kind]}</td><td><SessionStatus session={session} /></td><td><code>{session.model}</code></td><td><time dateTime={session.createdAt}>{formatDate(session.createdAt)}</time></td><td><time dateTime={session.updatedAt}>{formatDate(session.updatedAt)}</time></td></tr>)}</tbody></table></div>}
      {result && <nav className="pagination" aria-label="会话列表分页"><span>共 {result.total} 个会话 · 第 {page} / {pagination.pages} 页</span><button type="button" className="button secondary-button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><button type="button" className="button secondary-button" disabled={page >= pagination.pages} onClick={() => setPage((value) => value + 1)}>下一页</button></nav>}
    </section></main></>;
}
