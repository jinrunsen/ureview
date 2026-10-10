import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader, formatDate } from "./layout";
import { useSession } from "./auth";
import { Icon } from "./icons";
import { DetailDrawer } from "./ui";
import { listRepositories, type RepositorySummary } from "./api";
import { getRules, updateRules, type CatalogRule, type CatalogManagedRule, type CatalogLint, type SyncState } from "./rules-api";
import { ruleCategoryLabels, ruleSeverityLabels, type RuleCategory, type RuleSeverity } from "./managed-rules-api";
import { LintTable, LintDetail } from "./lint-catalog";
import { RuleSessionEditor } from "./rule-session-editor";
import { createRuleSession, listRuleSessions, updateRuleSession, type RuleSession } from "./rule-sessions-api";
import { getRuleMetadata, isRuleLayer, ruleLayerLabels, type RuleLayer, type RuleMetadata } from "./rule-metadata";
import { RuleHierarchyOverview, RuleHierarchyTags, RuleMetadataContext, ruleLayerDescriptions } from "./rule-hierarchy";
import { RuleLibrary } from "./rule-library";
import { RuleProposals } from "./rule-proposals";
import { RuleDetailPage } from "./rule-detail";
import { ruleDetailUrl } from "./rule-detail-api";
import "./rules.css";

type Scope = "all" | "global" | "repository";
type Source = "all" | "managed" | "git" | "library";
type Count = "hits" | "adopted" | "dismissed" | "ignored";
type RuleEntry = { kind: "managed"; rule: CatalogManagedRule } | { kind: "git"; rule: CatalogRule };
const scopeName = (rule: CatalogRule) => rule.scope === "global" ? rule.inherited ? "继承的全局规范" : "全局规范" : "仓库规范";

function RuleSyncRecords({ sync, repositoryName }: { sync: SyncState[]; repositoryName: (id: string) => string }) {
  const failures = sync.filter((state) => state.syncError || state.miningError);
  const failureKind = failures.some((state) => state.miningError) ? "同步或挖掘" : "同步";
  return <details className={`rules-sync${failures.length ? " rules-sync-failures" : ""}`}>
    <summary><span><Icon name="clock" size={16} />{failures.length ? `${failures.length} 个仓库${failureKind}失败` : "同步与挖掘记录"}</span><span>{failures.length ? "查看原因" : `${sync.length} 个仓库`}<Icon name="chevron-right" size={14} /></span></summary>
    <div className="rules-sync-body">{sync.length === 0 && <p className="muted">尚未执行同步。</p>}{sync.map((state) => <article className="rule-sync-record" key={state.repositoryId}>
      <h3>{repositoryName(state.repositoryId)}</h3><dl className="rule-sync-times"><div><dt>最后同步</dt><dd>{state.syncedAt ? formatDate(state.syncedAt) : "尚未完成"}</dd></div><div><dt>最后挖掘</dt><dd>{state.minedAt ? formatDate(state.minedAt) : "尚未完成"}</dd></div></dl>
      {state.syncError && <p className="rule-sync-error">同步：{state.syncError}</p>}{state.miningError && <p className="rule-sync-error">挖掘：{state.miningError}</p>}{state.warnings.map((warning) => <p className="rule-sync-warning" key={warning}>{warning}</p>)}{state.miningSummary && <p className="muted">扫描 {state.miningSummary.scanned} 个已合并 PR；未找到落实证据 {state.miningSummary.skippedNoAdoption} 个。</p>}
    </article>)}</div>
  </details>;
}

function RuleTable({ entries, repositories, sort, onSort }: { entries: RuleEntry[]; repositories: RepositorySummary[]; sort: { count: Count; descending: boolean } | null; onSort: (count: Count) => void }) {
  return <div className="table-scroll rules-table-wrap"><table className="data-table rules-table"><thead><tr><th scope="col">规范名称</th><th scope="col">作用范围</th><th scope="col">分类</th><th scope="col">严重度</th><th scope="col">来源</th>{([["hits", "命中"], ["adopted", "采纳"], ["dismissed", "驳回"], ["ignored", "被无视"]] as const).map(([count, label]) => <th scope="col" className="rule-number" aria-sort={sort?.count === count ? sort.descending ? "descending" : "ascending" : "none"} key={count}><button className="rule-sort" onClick={() => onSort(count)}>{label}<span aria-hidden="true">{sort?.count === count ? sort.descending ? "↓" : "↑" : "↕"}</span></button></th>)}</tr></thead>
    <tbody>{entries.map((entry) => {
      const rule = entry.rule; const managed = entry.kind === "managed" ? entry.rule : null; const git = entry.kind === "git" ? entry.rule : null;
      const href = managed ? ruleDetailUrl(`managed:${managed.id}`) : ruleDetailUrl(git!.id, git!.file.repositoryId);
      return <tr key={managed ? `managed:${managed.id}` : `${git!.file.repositoryId}:${git!.id}`}><td><a className="rule-title-button table-primary" href={href}><span>{rule.name}</span><Icon name="chevron-right" size={15} /></a><div className="rule-row-tags"><RuleHierarchyTags rule={rule} /></div><div className="rule-row-notes">{rule.overrides.length > 0 && <span>覆盖 {rule.overrides.length} 条规范</span>}{managed && managed.waivers.length > 0 && <span>{managed.waivers.length} 个仓库已豁免</span>}{git?.lazy && <span>惰性文档</span>}</div></td>
        <td>{managed ? managed.scope === "global" ? <span className="status-badge">团队全局</span> : <><span className="status-badge">{managed.repositories.length} 个仓库</span><div className="table-secondary">{managed.repositories.map((target) => repositories.find((repository) => repository.id === target.repositoryId)?.pathWithNamespace ?? "所选仓库").join("、")}</div></> : <><span className="status-badge">{scopeName(git!)}</span><div className="table-secondary">{git!.file.repositoryName}</div></>}</td>
        <td>{managed ? ruleCategoryLabels[managed.category] : "—"}</td><td>{managed ? <span className={`managed-severity managed-severity-${managed.severity}`}>{ruleSeverityLabels[managed.severity]}</span> : "按具体问题判定"}</td><td>{managed ? <>{managed.librarySource ? "工作台 · 规范库" : "工作台"}<div className="table-secondary">版本 {managed.version}</div>{managed.librarySource && <div className="table-secondary">规范库 {managed.librarySource.version}</div>}</> : <>Git · {git!.source.kind === "manual" ? "人工" : "历史挖掘"}</>}</td>
        {(["hits", "adopted", "dismissed", "ignored"] as const).map((count) => <td key={count} className="rule-number">{rule.counts?.[count] ?? 0}</td>)}</tr>;
    })}</tbody></table></div>;
}

export function RuleCatalogPage() {
  const params = new URLSearchParams(window.location.search); const ruleId = params.get("rule");
  if (ruleId) return <RuleDetailPage key={`${ruleId}:${params.get("ruleRepository")}`} ruleId={ruleId} repositoryId={params.get("ruleRepository") ?? undefined} />;
  return <><AppHeader currentPage="团队规范" /><main className="review-main rules-page"><RuleCatalogContent /></main></>;
}

export function RuleCatalogContent({ repositoryId }: { repositoryId?: string }) {
  const { user } = useSession(); const canGenerate = user?.role === "admin"; const canManage = !repositoryId && canGenerate;
  const rawTab = new URLSearchParams(window.location.search).get(repositoryId ? "ruleView" : "tab");
  const tab = repositoryId ? rawTab === "lints" ? "lints" : "rules" : rawTab === "candidates" ? "proposals" : rawTab === "proposals" || rawTab === "library" || rawTab === "lints" ? rawTab : "rules";
  const libraryLayer = new URLSearchParams(window.location.search).get("libraryLayer");
  const [repository, setRepository] = useState(() => repositoryId ?? new URLSearchParams(window.location.search).get("repository") ?? "");
  const [search, setSearch] = useState(""); const [scope, setScope] = useState<Scope>("all"); const [layer, setLayer] = useState<RuleLayer | "">(""); const [language, setLanguage] = useState(""); const [source, setSource] = useState<Source>("all");
  const [category, setCategory] = useState<RuleCategory | "">(""); const [severity, setSeverity] = useState<RuleSeverity | "">("");
  const [metadata, setMetadata] = useState<RuleMetadata>({ layers: [], languages: [] }); const [sort, setSort] = useState<{ count: Count; descending: boolean } | null>(null);
  const [selectedLint, setSelectedLint] = useState<CatalogLint | null>(null);
  const [ruleSessionId, setRuleSessionId] = useState<string | null>(() => new URLSearchParams(window.location.search).get("session"));
  const [sessionHistory, setSessionHistory] = useState<RuleSession[] | null>(null); const [sessionBusy, setSessionBusy] = useState(false);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]); const [rules, setRules] = useState<CatalogRule[]>([]); const [managedRules, setManagedRules] = useState<CatalogManagedRule[]>([]); const [lints, setLints] = useState<CatalogLint[]>([]); const [sync, setSync] = useState<SyncState[]>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [revision, setRevision] = useState(0);
  const requestVersion = useRef(0); const catalogRequest = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current; catalogRequest.current?.abort(); const controller = new AbortController(); catalogRequest.current = controller; setLoading(true); setError("");
    try { const [catalog, connected, options] = await Promise.all([getRules(repository || undefined, controller.signal), listRepositories(), getRuleMetadata(controller.signal)]); if (version !== requestVersion.current) return;
      setRules(catalog.rules); setManagedRules(catalog.managedRules); setLints(catalog.lints); setSync(catalog.sync); setRepositories(connected.repositories); setMetadata(options);
    } catch (cause) { if (version === requestVersion.current) setError(cause instanceof Error ? cause.message : "规范加载失败"); }
    finally { if (version === requestVersion.current) setLoading(false); }
  }, [repository]);
  useEffect(() => { void refresh(); return () => { requestVersion.current++; catalogRequest.current?.abort(); }; }, [refresh]);
  function changed() { setRevision((value) => value + 1); void refresh(); }
  async function update(operation: "sync" | "mine") {
    if (!repository || busy || !canManage) return; setBusy(true); setNotice(""); setError("");
    try { const result = await updateRules(repository, operation); setNotice(operation === "sync" ? "规范已同步" : `新增 ${result.added ?? 0} 条历史挖掘提案${result.nextAt ? `，下次挖掘可在 ${formatDate(result.nextAt)} 进行` : ""}`); changed(); }
    catch (cause) { await refresh(); setError(cause instanceof Error ? cause.message : "操作未完成"); }
    finally { setBusy(false); }
  }
  const repositoryName = (id: string) => repositories.find((item) => item.id === id)?.pathWithNamespace ?? "仓库";
  const query = search.trim().toLocaleLowerCase();
  const matchesHierarchy = (rule: { layer: RuleLayer; languages: string[] }) => (!layer || rule.layer === layer) && (!language || rule.languages.length === 0 || rule.languages.includes(language));
  const enabledGit = rules.filter((rule) => rule.enabled);
  const activeManaged = managedRules.filter((rule) => rule.status === "active");
  const layerCounts: Record<RuleLayer, number> = { principle: 0, general: 0, language: 0, team: 0 };
  for (const rule of [...enabledGit, ...activeManaged]) layerCounts[rule.layer]++;
  const entries: RuleEntry[] = [
    ...activeManaged.filter((rule) => source !== "git" && (source !== "library" || rule.librarySource) && matchesHierarchy(rule) && (!category || rule.category === category) && (!severity || rule.severity === severity) && (scope === "all" || rule.scope === (scope === "repository" ? "repositories" : "global")) && [rule.name, rule.body, ...rule.repositories.map((entry) => repositoryName(entry.repositoryId))].some((value) => value.toLocaleLowerCase().includes(query))).map((rule): RuleEntry => ({ kind: "managed", rule })),
    ...enabledGit.filter((rule) => (source === "all" || source === "git") && matchesHierarchy(rule) && !category && !severity && (scope === "all" || rule.scope === scope) && [rule.name, rule.id, rule.body, rule.file.path, rule.file.repositoryName].some((value) => value.toLocaleLowerCase().includes(query))).map((rule): RuleEntry => ({ kind: "git", rule })),
  ];
  entries.sort((left, right) => sort ? ((left.rule.counts?.[sort.count] ?? 0) - (right.rule.counts?.[sort.count] ?? 0)) * (sort.descending ? -1 : 1) || left.rule.name.localeCompare(right.rule.name) : left.rule.name.localeCompare(right.rule.name));
  const visibleLints = lints.filter((lint) => [lint.name, lint.description, lint.script, lint.file.path, lint.file.repositoryName, ...lint.paths].some((value) => value.toLocaleLowerCase().includes(query)));
  const failures = sync.filter((state) => state.syncError || state.miningError).length;
  function sortBy(count: Count) { setSort((previous) => ({ count, descending: previous?.count === count ? !previous.descending : true })); }
  function catalogUrl(view: string) { const params = repositoryId ? new URLSearchParams({ repository: repositoryId, tab: "rules" }) : new URLSearchParams({ rules: "1" }); if (view !== "rules") params.set(repositoryId ? "ruleView" : "tab", view); if (repository) params.set("repository", repository); return `/?${params}`; }
  function libraryUrl(group?: RuleLayer) { const params = new URLSearchParams({ rules: "1", tab: "library" }); if (group) params.set("libraryLayer", group); return `/?${params}`; }
  function changeRepository(value: string) { setNotice(""); setRules([]); setManagedRules([]); setLints([]); setSync([]); setLoading(true); setRepository(value); const location = new URL(window.location.href); if (value) location.searchParams.set("repository", value); else location.searchParams.delete("repository"); window.history.replaceState(null, "", location); }
  function openSession(id: string) { setSessionHistory(null); setRuleSessionId(id); const location = new URL(window.location.href); location.searchParams.set("session", id); window.history.replaceState(null, "", location); }
  function closeSession() { setRuleSessionId(null); const location = new URL(window.location.href); location.searchParams.delete("session"); window.history.replaceState(null, "", location); }
  async function startSession(initialLayer?: RuleLayer) {
    if (sessionBusy || !canGenerate) return; setSessionBusy(true); setError("");
    try { const result = await createRuleSession(); if (repository || initialLayer) await updateRuleSession(result.session.id, result.session.version, { name: "", body: "", goodExample: "", badExample: "", category: "quality", severity: "warning", judgement: false, layer: initialLayer ?? "team", languages: [], overrides: [], status: "draft", scope: repository ? "repositories" : "global", repositories: repository ? [{ repositoryId: repository, paths: [] }] : [] }); openSession(result.session.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "会话创建失败，请重试。"); } finally { setSessionBusy(false); }
  }
  async function showSessionHistory() { if (sessionBusy) return; setSessionBusy(true); setError(""); try { setSessionHistory((await listRuleSessions()).sessions); } catch (cause) { setError(cause instanceof Error ? cause.message : "生成记录读取失败，请重试。"); } finally { setSessionBusy(false); } }
  const Heading = repositoryId ? "h2" : "h1";
  return <RuleMetadataContext.Provider value={metadata}><section className="rules-page"><div className="page-title-row"><div><Heading>{repositoryId ? "仓库规范" : "团队规范"}</Heading><p className="page-description">{repositoryId ? "查看本仓库适用的规范与 Lint 配置。" : "按层级查看规范、执行记录与提案。"}</p>{repositoryId && <a className="rules-management-link" href={`/?rules=1&repository=${encodeURIComponent(repositoryId)}`}>在团队规范页管理</a>}</div><div className="rules-title-actions"><button className="button secondary-button" disabled={loading || busy} onClick={changed}><Icon name="refresh" size={16} />刷新列表</button>{canManage && <button className="button secondary-button" disabled={sessionBusy} onClick={() => void showSessionHistory()}><Icon name="clock" size={16} />生成记录</button>}{canGenerate && <button className="button primary-button" disabled={loading || busy || sessionBusy} onClick={() => void startSession()}><Icon name="plus" size={16} />{sessionBusy ? "正在读取…" : "生成新规则"}</button>}</div></div>
    <nav className="page-tabs" aria-label="规范视图"><a href={catalogUrl("rules")} aria-current={tab === "rules" ? "page" : undefined}>规范 <span>{enabledGit.length + activeManaged.length}</span></a>{!repositoryId && <><a href={catalogUrl("proposals")} aria-current={tab === "proposals" ? "page" : undefined}>提案</a><a href={catalogUrl("library")} aria-current={tab === "library" ? "page" : undefined}>规范库</a></>}<a href={catalogUrl("lints")} aria-current={tab === "lints" ? "page" : undefined}>Lint <span>{lints.length}</span></a></nav>
    {failures > 0 && <RuleSyncRecords sync={sync} repositoryName={repositoryName} />}
    {tab === "rules" && !repositoryId && <RuleHierarchyOverview counts={layerCounts} layer={layer} onSelect={setLayer} libraryUrl={libraryUrl()} />}
    {tab !== "library" && <div className="toolbar rules-toolbar">{tab !== "proposals" && <label className="search-field"><Icon name="search" size={17} /><input aria-label={tab === "lints" ? "搜索 Lint" : "搜索规范"} placeholder={tab === "lints" ? "搜索名称、路径或脚本…" : "搜索规范、正文或文件…"} value={search} onChange={(event) => setSearch(event.target.value)} /></label>}{!repositoryId && <label className="rules-filter"><span>仓库</span><select aria-label="筛选仓库" value={repository} disabled={busy} onChange={(event) => changeRepository(event.target.value)}><option value="">全部仓库</option>{repositories.map((item) => <option value={item.id} key={item.id}>{item.pathWithNamespace}</option>)}</select></label>}
      {tab === "rules" && <><label className="rules-filter">作用域<select aria-label="筛选规范作用域" value={scope} onChange={(event) => setScope(event.target.value as Scope)}><option value="all">全部作用域</option><option value="global">全局规范</option><option value="repository">仓库规范</option></select></label><label className="rules-filter">层级<select aria-label="筛选规范层级" value={layer} onChange={(event) => setLayer(event.target.value as RuleLayer | "")}><option value="">全部层级</option>{metadata.layers.map((value) => <option key={value} value={value}>{ruleLayerLabels[value]}</option>)}</select></label><label className="rules-filter">语言<select aria-label="筛选规范语言" value={language} onChange={(event) => setLanguage(event.target.value)}><option value="">全部语言</option>{metadata.languages.map((value) => <option key={value.id} value={value.id}>{value.label}</option>)}</select></label><label className="rules-filter">来源<select aria-label="筛选规范来源" value={source} onChange={(event) => setSource(event.target.value as Source)}><option value="all">全部来源</option><option value="managed">工作台</option><option value="git">Git</option><option value="library">规范库来源</option></select></label><label className="rules-filter">分类<select aria-label="筛选工作台规范分类" value={category} onChange={(event) => setCategory(event.target.value as RuleCategory | "")}><option value="">全部分类</option>{Object.entries(ruleCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="rules-filter">严重度<select aria-label="筛选工作台规范严重度" value={severity} onChange={(event) => setSeverity(event.target.value as RuleSeverity | "")}><option value="">全部严重度</option>{Object.entries(ruleSeverityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></>}
      {canManage && <div className="rules-actions"><button className="button secondary-button" disabled={!repository || busy || loading} title={!repository ? "请先选择仓库" : undefined} onClick={() => void update("sync")}><Icon name="git" size={16} />从 Git 重新同步</button>{tab !== "lints" && <button className="button primary-button" disabled={!repository || busy || loading} title={!repository ? "请先选择仓库" : undefined} onClick={() => void update("mine")}><Icon name="rules" size={16} />挖掘历史候选</button>}</div>}
    </div>}
    {loading && <p className="rules-progress" role="status">正在读取规范…</p>}{busy && <p className="rules-progress" role="status">正在读取 GitLab，请稍候…</p>}{error && <p className="feedback feedback-error" role="alert">{error}</p>}{notice && <p className="feedback" role="status">{notice}</p>}
    {tab === "library" && <RuleLibrary key={revision} initialLayer={isRuleLayer(libraryLayer) ? libraryLayer : undefined} canManage={canManage} onChanged={() => void refresh()} />}{tab === "proposals" && <RuleProposals repositoryId={repository || undefined} repositories={repositories} canManage={canManage} revision={revision} onChanged={() => void refresh()} />}
    {tab === "rules" && <><div className="rules-list-heading"><p>规范 <strong>{entries.length}</strong></p><p className="muted">已启用的规范按层级参与评审。</p></div>{(category || severity) && <p className="rules-explanation">分类和严重度筛选适用于工作台规范。</p>}{language && <p className="rules-explanation">语言筛选包含适用于全部语言的规范。</p>}
      {metadata.layers.map((group) => {
        const grouped = entries.filter((entry) => entry.rule.layer === group);
        return <section className="rule-layer-section" key={group} aria-label={ruleLayerLabels[group]}><div className="rule-layer-heading"><h2>{ruleLayerLabels[group]}</h2><span>{grouped.length} 条规范</span>{group === "principle" && grouped.length > 0 && <p>指导评审判断，不能被 finding 命中。</p>}</div>
          {grouped.length > 0 ? <RuleTable entries={grouped} repositories={repositories} sort={sort} onSort={sortBy} /> : <div className="rule-layer-empty"><p>{layerCounts[group] ? "没有匹配的规范。" : ruleLayerDescriptions[group]}</p>{!layerCounts[group] && canManage && <div className="rule-layer-empty-actions"><a className="button secondary-button" href={libraryUrl(group)}>从规范库添加</a><button className="button secondary-button" disabled={loading || busy || sessionBusy} onClick={() => void startSession(group)}>生成新规则</button></div>}</div>}
        </section>;
      })}
      {!loading && !error && !entries.length && (query || scope !== "all" || layer || language || source !== "all" || category || severity) && <div className="rules-filter-empty"><p>暂无匹配的规范。</p><button className="button secondary-button" onClick={() => { setSearch(""); setScope("all"); setLayer(""); setLanguage(""); setSource("all"); setCategory(""); setSeverity(""); }}>清除搜索和筛选</button></div>}
    </>}
    {tab === "lints" && <><div className="rules-list-heading"><p>Lint <strong>{visibleLints.length}</strong></p><p className="muted">同步各层 .agents/lints/ 的检查配置，未执行脚本。</p></div><div className="table-scroll rules-table-wrap"><LintTable lints={visibleLints} onSelect={setSelectedLint} />{!loading && !error && !visibleLints.length && <div className="empty-state rules-empty"><h2>暂无匹配的 Lint 配置</h2><p>在仓库 .agents/lints/ 中添加声明 meta 的 .mjs 文件，提交后选择仓库并重新同步。</p></div>}</div></>}
    {tab !== "library" && failures === 0 && <RuleSyncRecords sync={sync} repositoryName={repositoryName} />}
    {selectedLint && <DetailDrawer title={selectedLint.name} onClose={() => setSelectedLint(null)}><LintDetail lint={selectedLint} /></DetailDrawer>}
    {sessionHistory && <DetailDrawer title="规范生成记录" onClose={() => setSessionHistory(null)}><p className="muted">打开会话查看历史要求和结果，或接着调整工作稿。</p><div className="rule-session-history">{sessionHistory.length === 0 ? <div className="empty-state"><h3>尚无生成记录</h3><p>点击生成新规则，开始可以继续调整的对话。</p></div> : sessionHistory.map((item) => <button key={item.id} className="rule-session-history-item" onClick={() => openSession(item.id)}><span><strong>{item.title}</strong><span>{item.turns.length} 轮对话 · {item.status === "running" ? "正在生成" : item.ruleId ? "已关联规范" : "尚未保存为规范"}</span><time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time></span><Icon name="chevron-right" size={17} /></button>)}</div></DetailDrawer>}
    {ruleSessionId && canGenerate && <RuleSessionEditor key={ruleSessionId} sessionId={ruleSessionId} repositories={repositories} onClose={closeSession} onSaved={changed} />}
  </section></RuleMetadataContext.Provider>;
}
