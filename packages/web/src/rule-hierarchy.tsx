import { createContext, useContext, useEffect, useState, type FormEvent } from "react";
import { type RepositorySummary } from "./api";
import { getRules } from "./rules-api";
import { getRuleWaivers, setRuleWaiver, type GeneratedRuleDraft, type ManagedRule, type RuleWaiver } from "./managed-rules-api";
import { ruleLayerLabels, type RuleLayer, type RuleMetadata } from "./rule-metadata";
import { formatDate } from "./layout";

export const RuleMetadataContext = createContext<RuleMetadata>({ layers: [], languages: [] });

export const ruleLayerDescriptions: Record<RuleLayer, string> = {
  principle: "指导评审判断的设计原则。",
  general: "适用于不同语言的编码规范。",
  language: "针对特定语言的编码规范。",
  team: "团队约定的编码规范。",
};

export function RuleHierarchyOverview({ counts, layer, onSelect, libraryUrl }: {
  counts: Record<RuleLayer, number>; layer: RuleLayer | "";
  onSelect: (layer: RuleLayer | "") => void; libraryUrl: string;
}) {
  const layers: RuleLayer[] = ["principle", "general", "language", "team"];
  return <section className="rule-hierarchy-overview" aria-label="层级概览">
    <div className="rule-hierarchy-overview-heading"><h2>层级概览</h2><a href={libraryUrl}>从规范库添加经典规范</a></div>
    <div className="rule-hierarchy-overview-grid">{layers.map((item) => <button key={item} type="button" className={`rule-hierarchy-overview-item${layer === item ? " is-selected" : ""}`} aria-pressed={layer === item} onClick={() => onSelect(layer === item ? "" : item)}><strong>{ruleLayerLabels[item]}</strong><span>{counts[item]} 条</span></button>)}</div>
  </section>;
}

export function RuleHierarchyTags({ rule }: { rule: Pick<GeneratedRuleDraft, "layer" | "languages"> & { judgement?: boolean } }) {
  const metadata = useContext(RuleMetadataContext);
  return <><span className="status-badge">{ruleLayerLabels[rule.layer]}</span><span className="status-badge">{rule.languages.length ? rule.languages.map((id) => metadata.languages.find((language) => language.id === id)?.label ?? id).join("、") : "全部语言"}</span>{rule.judgement && <span className="status-badge">判断题</span>}</>;
}

export function RuleOverrideDetail({ overrides }: { overrides: string[] }) {
  return <section><h3>覆盖关系</h3>{overrides.length ? <ul className="rule-override-list">{overrides.map((id) => <li key={id}><code>{id}</code></li>)}</ul> : <p className="muted">未覆盖其他规范。</p>}</section>;
}

interface OverrideOption { id: string; name: string; layer: RuleLayer; source: string }
const canOverride = (layer: RuleLayer, target: RuleLayer) => layer === "team" ? target === "general" || target === "language" : layer === "language" && target === "general";

export function RuleHierarchyFields({ draft, overrides, ruleId, update, setOverrides }: {
  draft: GeneratedRuleDraft; overrides: string[]; ruleId?: string;
  update: <K extends keyof GeneratedRuleDraft>(key: K, value: GeneratedRuleDraft[K]) => void;
  setOverrides: (value: string[]) => void;
}) {
  const metadata = useContext(RuleMetadataContext);
  const [options, setOptions] = useState<OverrideOption[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void getRules(undefined, controller.signal).then((catalog) => {
      const entries = [...catalog.managedRules.map((rule) => ({ id: `managed:${rule.id}`, name: rule.name, layer: rule.layer, source: "工作台" })),
        ...catalog.rules.map((rule) => ({ id: rule.id, name: rule.name, layer: rule.layer, source: rule.file.repositoryName }))];
      setOptions([...new Map(entries.filter((rule) => rule.id !== `managed:${ruleId}`).map((rule) => [rule.id, rule])).values()]);
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "覆盖目标读取失败"); });
    return () => controller.abort();
  }, [ruleId]);
  const eligible = options.filter((rule) => canOverride(draft.layer, rule.layer));
  return <>
    <div className="field"><label htmlFor="managed-rule-layer">层级</label><select id="managed-rule-layer" value={draft.layer} onChange={(event) => {
      const layer = event.target.value as RuleLayer;
      update("layer", layer);
      setOverrides(layer === "principle" || layer === "general" ? [] : overrides.filter((id) => {
        const target = options.find((option) => option.id === id);
        return !target || canOverride(layer, target.layer);
      }));
    }}>{metadata.layers.map((layer) => <option key={layer} value={layer}>{ruleLayerLabels[layer]}</option>)}</select>
      {draft.layer === "principle" && <p className="field-hint">原则用于指导评审判断，不能作为 finding 的命中规范，也不能声明覆盖关系。</p>}</div>
    <div className="field"><span className="field-label" id="managed-rule-languages-label">适用语言</span><div className="rule-language-picker" role="group" aria-labelledby="managed-rule-languages-label">{metadata.languages.map((language) => <label key={language.id}><input type="checkbox" checked={draft.languages.includes(language.id)} onChange={(event) => update("languages", event.target.checked ? [...draft.languages, language.id] : draft.languages.filter((id) => id !== language.id))} />{language.label}</label>)}</div><p className="field-hint">留空适用全部语言。指定语言后，仅适用于对应语言的文件。</p></div>
    <div className="field"><span className="field-label" id="managed-rule-overrides-label">覆盖的规范</span><p className="field-hint">团队层可以覆盖语言层与通用层；语言层可以覆盖通用层。两条规范适用于同一文件时使用覆盖方。</p>
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
      <div className="rule-override-picker" role="group" aria-labelledby="managed-rule-overrides-label">{eligible.map((option) => <label key={option.id}><input type="checkbox" checked={overrides.includes(option.id)} onChange={(event) => setOverrides(event.target.checked ? [...overrides, option.id] : overrides.filter((id) => id !== option.id))} /><span>{option.name}<small>{ruleLayerLabels[option.layer]} · {option.source}</small></span></label>)}
        {overrides.filter((id) => !eligible.some((option) => option.id === id)).map((id) => <label key={id}><input type="checkbox" checked onChange={() => setOverrides(overrides.filter((value) => value !== id))} /><span><code>{id}</code><small>当前不可选，可取消关系。</small></span></label>)}</div>
      {eligible.length === 0 && overrides.length === 0 && <p className="muted">暂无可覆盖的规范。</p>}</div>
  </>;
}

export function RuleWaivers({ rule, repositories, canManage, onChanged }: {
  rule: ManagedRule; repositories: RepositorySummary[]; canManage: boolean; onChanged: (rule: ManagedRule) => void;
}) {
  const [repositoryId, setRepositoryId] = useState("");
  const [reason, setReason] = useState("");
  const [history, setHistory] = useState<RuleWaiver[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void getRuleWaivers(rule.id, controller.signal).then(({ waivers }) => setHistory(waivers)).catch((cause) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "豁免记录读取失败");
    });
    return () => controller.abort();
  }, [rule]);
  async function change(target: string, value?: string) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const result = await setRuleWaiver(rule.id, target, value);
      onChanged(result.rule); setReason(""); setRepositoryId("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "豁免更新失败"); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); if (repositoryId && reason.trim()) void change(repositoryId, reason.trim()); }
  const repositoryName = (id: string) => repositories.find((entry) => entry.id === id)?.pathWithNamespace ?? id;
  const available = repositories.filter((repository) => !rule.waivers.some((waiver) => waiver.repositoryId === repository.id));
  return <section className="rule-waivers" aria-label="仓库豁免"><h3>仓库豁免</h3>
    {rule.waivers.length ? <ul className="rule-waiver-list">{rule.waivers.map((waiver) => <li key={waiver.repositoryId}><strong>{repositoryName(waiver.repositoryId)}</strong><p>{waiver.reason}</p><small>{waiver.createdBy} · {formatDate(waiver.createdAt)}</small>{canManage && <button type="button" className="button secondary-button" disabled={busy} onClick={() => void change(waiver.repositoryId)}>撤销豁免</button>}</li>)}</ul> : <p className="muted">暂无仓库豁免。</p>}
    {canManage && available.length > 0 && <form onSubmit={submit} className="managed-rule-form"><fieldset disabled={busy}><div className="field"><label htmlFor="rule-waiver-repository">豁免仓库</label><select id="rule-waiver-repository" required value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}><option value="">选择仓库</option>{available.map((repository) => <option key={repository.id} value={repository.id}>{repository.pathWithNamespace}</option>)}</select></div><div className="field"><label htmlFor="rule-waiver-reason">豁免理由</label><textarea id="rule-waiver-reason" required maxLength={2000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></div><button className="button secondary-button" disabled={!repositoryId || !reason.trim()}>{busy ? "正在保存…" : "添加豁免"}</button></fieldset></form>}
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}
    {history.some((waiver) => waiver.revokedAt) && <details className="rule-waiver-history"><summary>已撤销的豁免</summary>{history.filter((waiver) => waiver.revokedAt).map((waiver) => <div key={`${waiver.repositoryId}:${waiver.createdAt}`}><strong>{repositoryName(waiver.repositoryId)}</strong><p>{waiver.reason}</p><small>设置：{waiver.createdBy} · {formatDate(waiver.createdAt)}<br />撤销：{waiver.revokedBy} · {formatDate(waiver.revokedAt!)}</small></div>)}</details>}
  </section>;
}
