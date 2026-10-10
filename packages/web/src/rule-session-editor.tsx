import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, type RepositorySummary } from "./api";
import { DetailDrawer } from "./ui";
import { Icon } from "./icons";
import { RuleSessionButton } from "./agent-sessions";
import { formatDate } from "./layout";
import { ManagedRuleDetail, ManagedRuleFields, type RuleRepositoryTarget } from "./managed-rule-editor";
import { RuleHierarchyTags, RuleOverrideDetail } from "./rule-hierarchy";
import { getManagedRules, ruleCategoryLabels, ruleSeverityLabels, type GeneratedRuleDraft, type ManagedRule, type ManagedRuleInput } from "./managed-rules-api";
import { getRuleSession, saveRuleSession, sendRuleSessionTurn, updateRuleSession, type RuleSession, type RuleSessionTurn } from "./rule-sessions-api";
import { ruleDetailUrl } from "./rule-detail-api";

type Busy = "loading" | "persisting" | "generating" | "saving" | "checking" | null;
const copyKey = (copy: ManagedRuleInput | null) => JSON.stringify(copy);
const normalizedCopy = (copy: ManagedRuleInput): ManagedRuleInput => ({ ...copy, repositories: copy.scope === "global" ? [] : copy.repositories.map((entry) => ({ ...entry, paths: [...new Set(entry.paths.map((path) => path.trim()).filter(Boolean))] })) });

function TurnResult({ turn }: { turn: RuleSessionTurn }) {
  return <article className="rule-session-turn"><div className="rule-session-message rule-session-user"><span className="rule-session-speaker">你 <time dateTime={turn.createdAt}>{formatDate(turn.createdAt)}</time></span><p>{turn.message}</p></div>
    <div className="rule-session-message rule-session-agent"><span className="rule-session-speaker"><Icon name="rules" size={14} />规范助手</span>
      {turn.status === "running" ? <p className="rule-session-running"><span className="spinner" />正在生成规范…</p> : turn.status === "failed" ? <p className="rule-session-turn-error">{turn.error ?? "本轮生成未完成，可以再次提出要求。"}</p> : <p>{turn.reply || "已根据你的要求更新工作稿。"}</p>}
      {turn.draft && <details className="rule-session-result"><summary>查看本轮生成结果 · {turn.draft.name}</summary><p className="rule-detail-tags"><RuleHierarchyTags rule={turn.draft} /><span className="status-badge">{ruleCategoryLabels[turn.draft.category]}</span><span className="status-badge">{ruleSeverityLabels[turn.draft.severity]}</span></p><p className="rule-body">{turn.draft.body}</p>{turn.draft.goodExample && <><h4>正确示例</h4><pre className="code-block"><code>{turn.draft.goodExample}</code></pre></>}{turn.draft.badExample && <><h4>反例</h4><pre className="code-block"><code>{turn.draft.badExample}</code></pre></>}</details>}
    </div>
  </article>;
}

function WorkingCopySnapshot({ copy, repositories }: { copy: ManagedRuleInput; repositories: RepositorySummary[] }) {
  return <div className="rule-detail"><h4>{copy.name || "未命名工作稿"}</h4><div className="rule-detail-tags"><RuleHierarchyTags rule={copy} /><span className="status-badge">{ruleCategoryLabels[copy.category]}</span><span className="status-badge">{ruleSeverityLabels[copy.severity]}</span><span className="status-badge">{copy.status === "active" ? "已启用" : "草稿"}</span></div>
    <p className="rule-body">{copy.body}</p><h4>作用范围</h4>{copy.scope === "global" ? <p>当前团队的全部仓库</p> : copy.repositories.map((entry) => <p key={entry.repositoryId}>{repositories.find((repository) => repository.id === entry.repositoryId)?.pathWithNamespace ?? "所选仓库"} · {entry.paths.length ? entry.paths.join("、") : "全部路径"}</p>)}
    <RuleOverrideDetail overrides={copy.overrides} />
    {copy.goodExample && <><h4>正确示例</h4><pre className="code-block"><code>{copy.goodExample}</code></pre></>}{copy.badExample && <><h4>反例</h4><pre className="code-block"><code>{copy.badExample}</code></pre></>}
  </div>;
}

export function RuleSessionEditor({ sessionId, repositories, onClose, onSaved }: {
  sessionId: string; repositories: RepositorySummary[]; onClose: () => void; onSaved: (rule: ManagedRule) => void;
}) {
  const [session, setSession] = useState<RuleSession | null>(null);
  const [workingCopy, setWorkingCopy] = useState<ManagedRuleInput | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<Busy>("loading");
  const [dirty, setDirty] = useState(false);
  const [transition, setTransition] = useState<"closing" | "sending" | null>(null);
  const [autoSavePaused, setAutoSavePaused] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<{ session: RuleSession; rule?: ManagedRule }>();
  const [ruleVersion, setRuleVersion] = useState<number>();
  const live = useRef(true);
  const sessionRef = useRef<RuleSession | null>(null);
  const copyRef = useRef<ManagedRuleInput | null>(null);
  const dirtyRef = useRef(false);
  const operation = useRef<Promise<boolean> | null>(null);
  const busyRef = useRef<Busy>("loading");
  const transitionRef = useRef<"closing" | "sending" | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  function changeTransition(value: "closing" | "sending" | null) { transitionRef.current = value; setTransition(value); }
  function changeBusy(value: Busy) { busyRef.current = value; setBusy(value); }
  function changeCopy(value: ManagedRuleInput | null, changed: boolean) { copyRef.current = value; setWorkingCopy(value); dirtyRef.current = changed; setDirty(changed); }
  function acceptSession(value: RuleSession, replaceCopy = true) {
    if (!live.current || (sessionRef.current && value.version < sessionRef.current.version)) return;
    sessionRef.current = value; setSession(value);
    if (replaceCopy) changeCopy(value.workingCopy, false);
  }
  function handleError(cause: unknown) {
    if (!live.current) return;
    setAutoSavePaused(true);
    if (cause instanceof ApiError && ["session_version_conflict", "version_conflict", "session_busy"].includes(cause.code ?? "")) {
      if (copyRef.current) { dirtyRef.current = true; setDirty(true); }
      setConflict(true); setLatest(undefined); setNotice("");
      setError("会话或规范已有更新。你的工作稿已保留，请载入最新内容进行核对。");
    } else setError(`${cause instanceof Error ? cause.message : "请求未完成。"} 当前工作稿已保留。`);
  }
  useEffect(() => {
    live.current = true;
    const controller = new AbortController();
    void getRuleSession(sessionId, controller.signal).then(({ session: value }) => { if (live.current) { acceptSession(value); changeBusy(null); } }).catch((cause) => {
      if (!controller.signal.aborted) { handleError(cause); changeBusy(null); }
    });
    return () => { live.current = false; controller.abort(); };
  }, [sessionId]);
  useEffect(() => {
    if (session?.status !== "running" && busy !== "generating") return;
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const result = await getRuleSession(sessionId, controller.signal);
        if (cancelled) return;
        acceptSession(result.session, !dirtyRef.current);
      } catch (cause) { if (!cancelled && !controller.signal.aborted) handleError(cause); }
      if (!cancelled) timer = setTimeout(() => void poll(), 1500);
    }
    timer = setTimeout(() => void poll(), 700);
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, session?.status, busy === "generating"]);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [session?.turns.length, session?.turns.at(-1)?.status]);
  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ""; } }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  async function persistCopy(): Promise<boolean> {
    const current = sessionRef.current;
    const copy = copyRef.current;
    if (!current || !copy || !dirtyRef.current) return true;
    if (current.status === "running" || conflict) return false;
    changeBusy("persisting");
    try {
      const result = await updateRuleSession(current.id, current.version, normalizedCopy(copy));
      if (!live.current) return false;
      const unchanged = copyKey(copyRef.current) === copyKey(copy);
      acceptSession(result.session, unchanged);
      setError("");
      return true;
    } catch (cause) { handleError(cause); return false; }
    finally { if (live.current) changeBusy(null); }
  }
  async function saveWorkingCopy(): Promise<boolean> {
    if (operation.current) return operation.current;
    const request = persistCopy(); operation.current = request;
    try { return await request; }
    finally { if (operation.current === request) operation.current = null; }
  }
  useEffect(() => {
    if (!dirty || busy || transition || conflict || autoSavePaused || session?.status !== "idle") return;
    const timer = setTimeout(() => { if (!transitionRef.current) void saveWorkingCopy(); }, 800);
    return () => clearTimeout(timer);
  }, [workingCopy, dirty, busy, transition, conflict, autoSavePaused, session?.status]);
  async function close() {
    if (transitionRef.current || busyRef.current === "saving" || busyRef.current === "checking") return;
    if (conflict || ((busyRef.current === "generating" || sessionRef.current?.status === "running") && dirtyRef.current)) {
      setError("当前工作稿尚未保存。请等待生成完成并核对最新内容后再关闭。"); return;
    }
    if (busyRef.current === "generating" || sessionRef.current?.status === "running") { onClose(); return; }
    changeTransition("closing");
    try {
      if (operation.current && !(await operation.current)) return;
      while (dirtyRef.current) { if (!(await saveWorkingCopy())) return; }
      if (live.current) onClose();
    } finally { if (live.current) changeTransition(null); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const text = message.trim();
    if (!sessionRef.current || !text || busyRef.current || transitionRef.current || sessionRef.current.status === "running" || conflict) return;
    changeTransition("sending"); setError(""); setNotice("");
    let startedFrom: RuleSession | undefined;
    try {
      while (dirtyRef.current) { if (!(await saveWorkingCopy())) return; }
      if (!live.current || !sessionRef.current) return;
      const current = sessionRef.current; startedFrom = current;
      changeBusy("generating"); changeTransition(null);
      const result = await sendRuleSessionTurn(current.id, current.version, text, copyRef.current ? normalizedCopy(copyRef.current) : undefined);
      if (!live.current) return;
      acceptSession(result.session); setMessage("");
      requestAnimationFrame(() => input.current?.focus());
    } catch (cause) {
      handleError(cause);
      if (startedFrom) try {
        const result = await getRuleSession(startedFrom.id);
        if (live.current) {
          const versionConflict = cause instanceof ApiError && ["session_version_conflict", "version_conflict", "session_busy"].includes(cause.code ?? "");
          acceptSession(result.session, !versionConflict && !dirtyRef.current);
          if (!versionConflict && result.session.turns.length > startedFrom.turns.length) setMessage("");
        }
      } catch { /* 保留原始错误与本地输入。 */ }
    } finally { if (live.current) { changeBusy(null); changeTransition(null); } }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const current = sessionRef.current;
    const copy = copyRef.current;
    if (!current || !copy || busyRef.current || transitionRef.current || current.status === "running" || conflict) return;
    const status = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-status") === "active" ? "active" : "draft";
    changeBusy("saving"); setError(""); setNotice("");
    try {
      const result = await saveRuleSession(current.id, current.version, { ...normalizedCopy(copy), status }, ruleVersion);
      if (!live.current) return;
      acceptSession(result.session); setRuleVersion(undefined);
      setNotice(status === "active" ? "规范已保存并启用，将参与之后发起的评审。可以继续对话调整。" : "规范已保存为草稿，可在提案列表查看。可以继续对话调整。");
      onSaved(result.rule);
    } catch (cause) { handleError(cause); }
    finally { if (live.current) changeBusy(null); }
  }
  async function checkLatest() {
    if (!sessionRef.current || busyRef.current || transitionRef.current) return;
    changeBusy("checking");
    try {
      const result = await getRuleSession(sessionId);
      const rules = result.session.ruleId ? await getManagedRules() : undefined;
      const rule = rules?.rules.find((item) => item.id === result.session.ruleId);
      if (live.current) { setLatest({ session: result.session, rule }); setError(""); }
    } catch (cause) { handleError(cause); }
    finally { if (live.current) changeBusy(null); }
  }
  function confirmLatest() {
    if (!latest || latest.session.status === "running") return;
    const hasLocalCopy = copyRef.current !== null;
    acceptSession(latest.session, !hasLocalCopy); setRuleVersion(latest.rule?.version); setConflict(false); setAutoSavePaused(false); setLatest(undefined); setError("");
    dirtyRef.current = hasLocalCopy; setDirty(hasLocalCopy); setNotice(hasLocalCopy ? "已核对最新内容，当前工作稿保持不变。保存规范时会使用已核对的版本。" : "已载入最新工作稿，可以继续对话或保存规范。");
  }
  function editCopy(value: ManagedRuleInput) { if (transitionRef.current) return; changeCopy(value, true); setAutoSavePaused(false); setNotice(""); }
  function update<K extends keyof GeneratedRuleDraft>(key: K, value: GeneratedRuleDraft[K]) { if (copyRef.current) editCopy({ ...copyRef.current, [key]: value }); }
  const running = session?.status === "running" || busy === "generating";
  const locked = transition !== null || running || busy === "saving" || busy === "checking" || busy === "loading";
  const targets = workingCopy?.repositories.map((entry) => ({ repositoryId: entry.repositoryId, paths: entry.paths.join("\n") })) ?? [];
  function setTargets(value: RuleRepositoryTarget[] | ((current: RuleRepositoryTarget[]) => RuleRepositoryTarget[])) {
    if (!copyRef.current) return;
    const current = copyRef.current.repositories.map((entry) => ({ repositoryId: entry.repositoryId, paths: entry.paths.join("\n") }));
    const next = typeof value === "function" ? value(current) : value;
    editCopy({ ...copyRef.current, repositories: next.map((entry) => ({ repositoryId: entry.repositoryId, paths: entry.paths.split("\n") })) });
  }
  return <DetailDrawer title={session?.title || "规范生成会话"} onClose={() => void close()}>
    <div className="rule-session-workbench">
      <div className="rule-session-banner"><span><Icon name="clock" size={15} />对话与工作稿自动保存在本会话</span><span role="status">{transition === "closing" ? "正在保存工作稿，完成后关闭…" : busy === "persisting" ? "正在保存工作稿…" : dirty ? "工作稿有未保存的更改" : session ? "会话已保存" : "正在读取会话…"}</span></div>
      <p className="rule-session-description">确认工作稿后，点击「保存草稿」或「保存并启用」更新团队规范。关闭或刷新页面后，可以从生成记录继续对话。</p>
      <div className="rule-session-viewer-entry"><RuleSessionButton sessionId={sessionId} title={session?.title || "规范生成会话"} /></div>
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}
      {dirty && autoSavePaused && !conflict && <button className="button secondary-button" disabled={busy !== null || transition !== null} onClick={() => { setAutoSavePaused(false); void saveWorkingCopy(); }}>重试保存工作稿</button>}
      {!session && busy !== "loading" && <button className="button secondary-button" onClick={() => window.location.reload()}>重新读取会话</button>}
      {conflict && <section className="managed-version-conflict" aria-label="核对最新会话"><p>当前工作稿保留在右侧。核对更新后，可用当前工作稿继续对话或保存规范。</p><button type="button" className="button secondary-button" disabled={busy !== null || transition !== null} onClick={() => void checkLatest()}>{busy === "checking" ? "正在读取…" : "载入最新版本以核对"}</button>
        {latest && <><details open className="managed-latest-version"><summary>最新会话版本 {latest.session.version}{latest.session.status === "running" ? " · 正在生成" : ""}</summary>{latest.session.turns.at(-1) && <TurnResult turn={latest.session.turns.at(-1)!} />}{latest.session.workingCopy && <><h4>会话工作稿</h4><WorkingCopySnapshot copy={latest.session.workingCopy} repositories={repositories} /></>}{latest.rule && <><h4>已保存规范 · 版本 {latest.rule.version}</h4><ManagedRuleDetail rule={latest.rule} repositories={repositories} /></>}</details><button type="button" className="button secondary-button" disabled={busy !== null || transition !== null || latest.session.status === "running"} onClick={confirmLatest}>已核对，保留当前工作稿继续</button>{latest.session.status === "running" && <p>请等待生成完成后再次载入最新版本。</p>}</>}
      </section>}
      {session && <div className="rule-session-columns"><section className="rule-session-conversation" aria-label="规范生成对话"><div className="rule-session-section-heading"><h3>对话</h3><span>{session.turns.length} 轮</span></div>
        <div className="rule-session-transcript" aria-live="polite" aria-relevant="additions text">{session.turns.length === 0 && <div className="rule-session-empty"><span className="managed-editor-icon"><Icon name="rules" size={24} /></span><h3>{workingCopy ? "继续完善这条规范" : "描述希望团队遵守的约定"}</h3><p>{workingCopy ? "可以要求补充示例、调整边界或精简措辞。助手会结合当前工作稿和前文进行修改。" : "说明要检查的行为、适用场景和例外。助手会生成规范正文、分类、严重度与示例。"}</p></div>}
          {session.turns.map((turn) => <TurnResult key={turn.id} turn={turn} />)}
          {busy === "generating" && session.status !== "running" && <p className="rule-session-running" role="status"><span className="spinner" />正在提交并生成，请稍候…</p>}<div ref={end} />
        </div>
        <form className="rule-session-composer managed-rule-intent" onSubmit={(event) => void send(event)}><label htmlFor="rule-session-message">{session.turns.length ? "继续调整规范" : "规范要求"}</label><textarea ref={input} id="rule-session-message" required maxLength={4000} rows={4} value={message} disabled={locked || conflict} onChange={(event) => setMessage(event.target.value)} placeholder={session.turns.length ? "例如：仅限制批量处理路径里的 debug 日志，允许排查异常时临时开启。" : "例如：金额使用整数分，避免浮点误差。请提供 TypeScript 示例。"} /><div className="rule-session-composer-footer"><span>{message.length} / 4,000</span><button type="submit" className="button primary-button" disabled={busy !== null || transition !== null || running || conflict || !message.trim()}>{running ? <><span className="spinner" />正在生成</> : <><Icon name="arrow-right" size={15} />{session.turns.length ? "发送调整要求" : "生成草稿"}</>}</button></div>{running && <p className="field-hint">关闭面板后会继续生成，再次打开可以查看结果。</p>}</form>
      </section><section className="rule-session-preview" aria-label="规范工作稿"><div className="rule-session-section-heading"><h3>当前工作稿</h3><span>{session.ruleId ? <a href={ruleDetailUrl(`managed:${session.ruleId}`)}>已关联规范 · 版本 {session.ruleVersion}</a> : "尚未保存为规范"}</span></div>
        {workingCopy ? <form className="managed-rule-form" onSubmit={(event) => void save(event)}><ManagedRuleFields draft={workingCopy} scope={workingCopy.scope} targets={targets} repositories={repositories} disabled={locked} update={update} setScope={(scope) => editCopy({ ...workingCopy, scope })} setTargets={setTargets} overrides={workingCopy.overrides} setOverrides={(overrides) => { if (copyRef.current) editCopy({ ...copyRef.current, overrides }); }} ruleId={session.ruleId ?? undefined} />
          <div className="managed-editor-actions"><button type="submit" data-status="active" className="button primary-button" disabled={busy !== null || transition !== null || running || conflict}>{busy === "saving" ? "正在保存…" : workingCopy.status === "active" ? "保存更改" : "保存并启用"}</button><button type="submit" data-status="draft" className="button secondary-button" disabled={busy !== null || transition !== null || running || conflict}>{workingCopy.status === "active" ? "停用并保存草稿" : "保存草稿"}</button></div><p className="field-hint">工作稿的修改在保存规范后生效。已有评审保留当时的规范快照。</p>
        </form> : <div className="rule-session-preview-empty"><Icon name="file" size={28} /><h3>生成的规范会显示在这里</h3><p>可以直接修改，也可以通过左侧对话继续微调。</p></div>}
      </section></div>}
    </div>
  </DetailDrawer>;
}
