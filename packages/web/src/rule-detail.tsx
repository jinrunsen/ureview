import { useEffect, useState } from "react";
import { AppHeader, formatDate } from "./layout";
import { listRepositories, type RepositorySummary } from "./api";
import { useSession } from "./auth";
import { getRuleMetadata, type RuleMetadata } from "./rule-metadata";
import { RuleHierarchyTags, RuleMetadataContext, RuleWaivers } from "./rule-hierarchy";
import { ManagedRuleEditor } from "./managed-rule-editor";
import { ManagedRuleDeletion } from "./managed-rule-deletion";
import { getRules, type CatalogRule } from "./rules-api";
import { getRuleDetail, ruleDetailUrl, type RuleDetail } from "./rule-detail-api";
import { dispositionReasonLabels } from "./review-api";
import { ruleCategoryLabels, ruleSeverityLabels } from "./managed-rules-api";
import { createRuleSession, listRuleSessions } from "./rule-sessions-api";
import { RuleSessionEditor } from "./rule-session-editor";
import { RuleExample } from "./rule-example";
import { ReadingMarkdown } from "./reading-code";
import "./rules.css";

const statusLabels = { Pending: "待处置", Resolved: "已采纳", Dismissed: "已驳回", Ignored: "被无视", Outdated: "已过时" };
const ruleStatusLabels = { active: "已启用", draft: "草稿", disabled: "注入已停用", lazy: "惰性文档", snapshot: "评审快照" };

export function RuleDetailPage({ ruleId, repositoryId }: { ruleId: string; repositoryId?: string }) {
  const { user } = useSession(); const canManage = user?.role === "admin";
  const [detail, setDetail] = useState<RuleDetail | null>(null);
  const [repositories, setRepositories] = useState<RepositorySummary[]>([]);
  const [gitRules, setGitRules] = useState<CatalogRule[]>([]);
  const [metadata, setMetadata] = useState<RuleMetadata>({ layers: [], languages: [] });
  const [sessionId, setSessionId] = useState<string | null>(null); const [sessionBusy, setSessionBusy] = useState(false);
  const [error, setError] = useState(""); const [loading, setLoading] = useState(true); const [editing, setEditing] = useState(false); const [revision, setRevision] = useState(0);
  function refresh() { setRevision((value) => value + 1); }
  async function openSession() {
    const managedRule = detail?.rule.managedRule; if (!managedRule || sessionBusy) return;
    setSessionBusy(true); setError("");
    try { const history = await listRuleSessions(managedRule.id); setSessionId(history.sessions[0]?.id ?? (await createRuleSession(managedRule.id)).session.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "规范会话读取失败"); }
    finally { setSessionBusy(false); }
  }
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    void Promise.all([getRuleDetail(ruleId, repositoryId, controller.signal), listRepositories(), getRuleMetadata(controller.signal), getRules(undefined, controller.signal)]).then(([result, connected, options, catalog]) => { if (!controller.signal.aborted) { setDetail(result); setRepositories(connected.repositories); setMetadata(options); setGitRules(catalog.rules); } }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "规范详情读取失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ruleId, repositoryId, revision]);
  const rule = detail?.rule;
  const exampleLanguage = rule?.managedRule?.librarySource?.exampleLanguage ?? rule?.languages[0];
  const repositoryName = (id: string) => repositories.find((item) => item.id === id)?.pathWithNamespace ?? id;
  return <RuleMetadataContext.Provider value={metadata}><AppHeader currentPage="规范详情" /><main className="review-main rules-page rule-detail-page"><a className="text-button" href="/?rules=1">← 返回规范</a>
    {loading && <p role="status">正在读取规范详情…</p>}{error && <p className="feedback feedback-error" role="alert">{error}<button className="text-button" onClick={refresh}>重试</button></p>}
    {detail && rule && <><div className="page-title-row"><div><h1>{rule.name}</h1><div className="rule-detail-tags"><RuleHierarchyTags rule={rule} /><span className="status-badge">{ruleStatusLabels[rule.status]}</span><span className="status-badge">{rule.source.kind === "git" ? "Git" : rule.source.kind === "library" ? "工作台 · 规范库来源" : "工作台"}</span>{rule.managedRule && <><span className="status-badge">{ruleCategoryLabels[rule.managedRule.category]}</span><span className="status-badge">{ruleSeverityLabels[rule.managedRule.severity]}</span></>}</div></div>{canManage && rule.managedRule && <div className="rules-title-actions"><button className="button secondary-button" disabled={sessionBusy} onClick={() => void openSession()}>{sessionBusy ? "正在读取…" : "对话调整"}</button><button className="button primary-button" onClick={() => setEditing(true)}>编辑规范</button><ManagedRuleDeletion rule={rule.managedRule} disabled={loading || sessionBusy} onDeleted={() => window.location.assign("/?rules=1")} /></div>}</div>
      {rule.status === "snapshot" && <p className="feedback" role="status">当前规范目录中没有此条目，展示最近一次已完成评审保存的规范。</p>}
      <dl className="rule-counts"><div><dt>命中</dt><dd>{detail.summary.hits}</dd></div><div><dt>采纳</dt><dd>{detail.summary.adopted}</dd></div><div><dt>驳回</dt><dd>{detail.summary.dismissed}</dd></div></dl>
      <div className="rule-detail-columns"><div className="rule-detail-main"><section><h2>规范正文</h2><ReadingMarkdown>{rule.body}</ReadingMarkdown></section>{rule.goodExample && <section><h2>正确示例</h2><RuleExample source={rule.goodExample} language={exampleLanguage} /></section>}{rule.badExample && <section><h2>反例</h2><RuleExample source={rule.badExample} language={exampleLanguage} /></section>}
        <section><h2>覆盖关系</h2>{rule.overrides.length ? <ul>{rule.overrides.map((id) => <li key={id}>{id.startsWith("managed:") ? <a href={ruleDetailUrl(id)}><code>{id}</code></a> : <><code>{id}</code>{gitRules.filter((target) => target.id === id && (repositoryId ? target.file.repositoryId === repositoryId : rule.scope === "global" || rule.repositories.some((entry) => entry.repositoryId === target.file.repositoryId))).map((target) => <div key={target.file.repositoryId}><a href={ruleDetailUrl(id, target.file.repositoryId)}>{target.file.repositoryName} · {target.name}</a></div>)}</>}</li>)}</ul> : <p className="muted">未覆盖其他规范。</p>}{rule.overriddenBy.length > 0 && <><h3>覆盖此规范</h3><ul>{rule.overriddenBy.map((entry) => <li key={`${entry.repositoryId}:${entry.id}`}><a href={ruleDetailUrl(entry.id, entry.repositoryId)}>{entry.name}</a></li>)}</ul></>}</section>
        {rule.managedRule && rule.scope === "global" ? <RuleWaivers rule={rule.managedRule} repositories={repositories} canManage={canManage} onChanged={refresh} /> : <section><h2>仓库豁免</h2><p className="muted">此规范没有仓库豁免。</p></section>}
      </div><aside className="rule-detail-aside"><section><h2>作用范围</h2>{rule.scope === "global" ? <p>当前团队的全部仓库</p> : rule.repositories.map((entry) => <div className="managed-scope-detail" key={entry.repositoryId}><strong>{repositoryName(entry.repositoryId)}</strong><p>{entry.paths.length ? entry.paths.map((path) => <code key={path}>{path}</code>) : rule.status === "lazy" ? "惰性文档，无自动匹配路径" : "全部路径"}</p></div>)}</section><section><h2>来源与版本</h2><dl className="rule-metadata"><div><dt>版本</dt><dd><code>{rule.version}</code></dd></div>{rule.source.kind === "git" && <><div><dt>仓库</dt><dd>{rule.source.file.repositoryName}</dd></div><div><dt>Git 文件</dt><dd><a href={rule.source.file.url} target="_blank" rel="noreferrer">{rule.source.file.path}</a></dd></div><div><dt>提交</dt><dd><code>{rule.source.file.commitSha}</code></dd></div></>}{rule.source.kind === "library" && <><div><dt>规范集</dt><dd>{rule.source.setName}</dd></div><div><dt>来源文件</dt><dd>{rule.source.sourceFilename}</dd></div><div><dt>库版本</dt><dd>{rule.source.libraryVersion}</dd></div></>}{rule.managedRule && <><div><dt>更新时间</dt><dd>{formatDate(rule.managedRule.updatedAt)}</dd></div><div><dt>存储位置</dt><dd>uReview 工作台</dd></div></>}</dl>{rule.source.kind === "git" && <p className="muted">修改后由人在 Git 中提交，再同步目录。</p>}</section></aside></div>
      <section className="rule-executions" aria-label="执行记录"><div className="rules-list-heading"><h2>执行记录</h2><p className="muted">统计已完成评审中的展示 finding，处置为当前状态。</p></div><div className="rule-reason-distribution"><h3>驳回理由分布</h3>{Object.entries(detail.summary.dismissalReasons).length ? Object.entries(detail.summary.dismissalReasons).map(([reason, total]) => <span className="status-badge" key={reason}>{dispositionReasonLabels[reason as keyof typeof dispositionReasonLabels]} {total}</span>) : <p className="muted">暂无驳回记录。</p>}</div>
        <div className="table-scroll rules-table-wrap"><table className="data-table rule-execution-table"><thead><tr><th>PR 与 finding</th><th>轮次</th><th>严重度</th><th>处置</th><th>驳回理由</th><th>操作人 / 时间</th></tr></thead><tbody>{detail.records.map((record) => <tr key={`${record.reviewId}:${record.findingId}`}><td><a href={`/?review=${encodeURIComponent(record.reviewId)}#finding-${encodeURIComponent(record.findingId)}`}>{record.findingTitle}</a><div className="table-secondary">{record.repositoryName} · {record.pullRequestUrl ? <a href={record.pullRequestUrl} target="_blank" rel="noreferrer">PR !{record.iid} {record.title}</a> : <>PR !{record.iid} {record.title}</>}</div></td><td>第 {record.round} 轮<div className="table-secondary">规范 {String(record.ruleVersion).slice(0, 12)}</div></td><td>{record.severity === "high" ? "高危" : "中危"}</td><td>{statusLabels[record.status]}</td><td>{record.disposition.reasonCategory ? dispositionReasonLabels[record.disposition.reasonCategory] : "—"}{record.disposition.explanation && <p className="rule-body">{record.disposition.explanation}</p>}</td><td>{record.disposition.actor?.name ?? "—"}<div className="table-secondary">{record.disposition.updatedAt ? formatDate(record.disposition.updatedAt) : ""}</div></td></tr>)}</tbody></table>{!detail.records.length && <p className="empty-state rules-empty">暂无执行记录。</p>}</div>
      </section>{editing && rule.managedRule && <ManagedRuleEditor key={`${rule.managedRule.id}:${rule.managedRule.version}`} rule={rule.managedRule} repositories={repositories} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); refresh(); }} />}
    </>}
    {sessionId && canManage && <RuleSessionEditor key={sessionId} sessionId={sessionId} repositories={repositories} onClose={() => setSessionId(null)} onSaved={refresh} />}
  </main></RuleMetadataContext.Provider>;
}
