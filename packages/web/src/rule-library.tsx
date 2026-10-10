import { useSession } from "./auth";
import { RuleImports } from "./rule-imports";
import { useContext, useEffect, useState } from "react";
import { Icon } from "./icons";
import { RuleHierarchyTags, RuleMetadataContext } from "./rule-hierarchy";
import { ruleLayerLabels, type RuleLayer } from "./rule-metadata";
import { ruleCategoryLabels, ruleSeverityLabels } from "./managed-rules-api";
import { applyRuleLibrary, getRuleLibraryEntries, getRuleLibrary, deleteImportedLibrarySet, type LibrarySet, type LibraryEntry } from "./rule-library-api";
import { ruleDetailUrl } from "./rule-detail-api";
import { RuleExample } from "./rule-example";

const licenseLabels: Record<string, string> = { original: "自写", open: "开放许可", internal: "内部可用 · 自写要点", copyrighted: "受版权保护 · 自写要点", enterprise: "企业内部规范" };
const reasonLabels: Record<string, string> = { publication: "出版与发布", community: "社区使用", longevity: "长期使用", adoption: "项目采纳", enterprise: "企业规范" };

function LibraryEntryExamples({ entry }: { entry: LibraryEntry }) {
  const [open, setOpen] = useState(false);
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>正反例代码</summary>{open && <>
    <h4>反例</h4><RuleExample source={entry.badExample} language={entry.exampleLanguage} />
    <h4>正确示例</h4><RuleExample source={entry.goodExample} language={entry.exampleLanguage} />
  </>}</details>;
}

function LibrarySetCard({ set, canManage, canImport, onApplied, onRemoved }: { set: LibrarySet; canManage: boolean; canImport: boolean; onApplied: (setId: string, appliedCount: number) => void; onRemoved: () => void }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open || entries) return;
    const controller = new AbortController(); setError("");
    void getRuleLibraryEntries(set.id, controller.signal).then((result) => { if (!controller.signal.aborted) setEntries(result.entries); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取条目失败"); });
    return () => controller.abort();
  }, [open, entries, set.id, reload]);
  const appliedCount = set.appliedCount;
  async function apply(ids?: string[]) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try { const result = await applyRuleLibrary(set.id, ids); setNotice(`已创建并启用 ${result.created} 条规则，已存在的 ${result.rules.length - result.created} 条已跳过。`); setSelected([]); const updated = await getRuleLibraryEntries(set.id); setEntries(updated.entries); onApplied(set.id, updated.entries.filter((entry) => entry.appliedRuleId).length); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "应用规范集失败"); }
    finally { setBusy(false); }
  }
  async function removeImported() {
    if (!window.confirm(`删除已发布的规范集「${set.name}」？已应用的团队规范会保留。`)) return;
    setBusy(true); setError("");
    try { await deleteImportedLibrarySet(set.id); onRemoved(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "删除规范集失败"); }
    finally { setBusy(false); }
  }
  return <article className="library-card" aria-label={set.name}>
    <div className="library-card-heading"><div><h2>{set.name}</h2><div className="rule-detail-tags"><RuleHierarchyTags rule={set} /><span className="status-badge">{set.entryCount} 条</span><span className="status-badge">{licenseLabels[set.license.tier] ?? set.license.tier}</span></div></div><span className="muted">版本 {set.libraryVersion}</span></div>
    {set.sourceType === "imported" && <div><span className="status-badge">企业导入</span><p>来源文件：{set.sourceFilename}</p><p>发布人：{set.publishedBy} · {new Date(set.publishedAt!).toLocaleString("zh-CN")}</p>{canImport && <button className="button secondary-button" disabled={busy} onClick={() => void removeImported()}>删除导入规范集</button>}</div>}
    <div className="library-sources">{set.sources.map((source) => <p key={source.id}>{source.url ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}<Icon name="arrow-up-right" size={13} /></a> : <span>{source.title}</span>}<span>{source.author} · {source.license}</span></p>)}</div>
    <ul className="library-inclusion">{set.inclusionReasons.map((reason) => <li key={reason.kind}><strong>{reasonLabels[reason.kind] ?? reason.kind}</strong>：{reason.explanation}</li>)}</ul>
    <details className="library-license"><summary>许可与署名</summary><p>{set.license.attribution}</p><p>{set.license.notice}</p>{set.sources.filter((source) => source.licenseUrl).map((source) => <a href={source.licenseUrl} key={source.id} target="_blank" rel="noreferrer">{source.license} 许可</a>)}</details>
    <details className="library-entries" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>查看条目 <span>{appliedCount} 条已应用</span></summary>
      {open && <>{!entries && !error && <p role="status">正在读取条目…</p>}{!entries && error && <button onClick={() => setReload((value) => value + 1)}>重试读取条目</button>}{canManage && entries && entries.length > 0 && <div className="library-selection"><label><input type="checkbox" checked={entries.every((entry) => selected.includes(entry.id))} onChange={(event) => setSelected(event.target.checked ? entries.map((entry) => entry.id) : [])} disabled={busy} />选择全部条目</label><button className="button secondary-button" disabled={busy || !selected.length} onClick={() => void apply(selected)}>{busy ? "正在应用…" : `应用所选 ${selected.length} 条`}</button></div>}
      {entries?.map((entry) => <section className="library-entry" key={entry.id}><div className="library-entry-heading">{canManage && <input type="checkbox" aria-label={`选择 ${entry.title}`} checked={selected.includes(entry.id)} disabled={busy} onChange={(event) => setSelected((current) => event.target.checked ? [...current, entry.id] : current.filter((id) => id !== entry.id))} />}<h3>{entry.title}</h3>{entry.judgement && <span className="status-badge">判断题</span>}{entry.appliedRuleId && <a className="status-badge rule-status-active" href={ruleDetailUrl(`managed:${entry.appliedRuleId}`)}>已应用</a>}</div>
        <p className="library-original-name">{entry.originalName}</p><p className="library-summary">{entry.summary}</p><p className="rule-body">{entry.body}</p>
        <dl className="library-guidance"><div><dt>检查什么</dt><dd>{entry.check}</dd></div><div><dt>为什么</dt><dd>{entry.why}</dd></div><div><dt>怎么改</dt><dd>{entry.fix}</dd></div></dl>
        <div className="library-entry-meta"><span>{ruleCategoryLabels[entry.category]} · {ruleSeverityLabels[entry.severity]}</span><span>出处：{entry.source.reference}</span></div>
        <LibraryEntryExamples entry={entry} />
      </section>)}</>}
    </details>
    <div className="library-card-actions">{canManage ? <><button className="button primary-button" disabled={busy || !set.entryCount} onClick={() => void apply()}>{busy ? "正在应用…" : "应用整个规范集"}</button><p className="muted">应用后直接创建并启用规则，已存在的条目会跳过。</p></> : <p className="muted">团队管理员可以应用规范集。</p>}</div>
    {error && <p className="feedback feedback-error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}<a href="/?rules=1">查看规范</a></p>}
  </article>;
}

export function RuleLibrary({ canManage, onChanged, initialLayer }: { canManage: boolean; onChanged: () => void; initialLayer?: RuleLayer }) {
  const { user } = useSession();
  const metadata = useContext(RuleMetadataContext);
  const [layer, setLayer] = useState<RuleLayer | "">(initialLayer ?? "");
  const [language, setLanguage] = useState("");
  const [sets, setSets] = useState<LibrarySet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void getRuleLibrary(layer || undefined, language || undefined, controller.signal).then((result) => { if (!controller.signal.aborted) setSets(result.sets); }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "规范库读取失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [layer, language, revision]);
  function applied(setId: string, appliedCount: number) {
    setSets((current) => current.map((set) => set.id === setId ? { ...set, appliedCount } : set));
    onChanged();
  }
  function removed() { setRevision((value) => value + 1); onChanged(); }
  return <section aria-label="规范库">{user?.serviceRole === "service_admin" && <RuleImports onPublished={() => setRevision((value) => value + 1)} />}<div className="toolbar rules-toolbar"><label className="rules-filter">层级<select aria-label="筛选规范库层级" value={layer} onChange={(event) => setLayer(event.target.value as RuleLayer | "")}><option value="">全部层级</option>{metadata.layers.map((item) => <option key={item} value={item}>{ruleLayerLabels[item]}</option>)}</select></label><label className="rules-filter">语言<select aria-label="筛选规范库语言" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="">全部语言</option>{metadata.languages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><p className="muted">适用于全部语言的规范集会包含在语言筛选中。</p></div>
    {loading && <p role="status">正在读取规范库…</p>}{error && <p className="feedback feedback-error" role="alert">{error}<button className="text-button" onClick={() => setRevision((value) => value + 1)}>重试</button></p>}
    <div className="library-grid">{sets.map((set) => <LibrarySetCard key={set.id} set={set} canManage={canManage} canImport={user?.serviceRole === "service_admin"} onApplied={applied} onRemoved={removed} />)}</div>{!loading && !error && !sets.length && <div className="empty-state rules-empty"><h2>没有匹配的规范集</h2><p>调整层级或语言筛选。</p></div>}
  </section>;
}
