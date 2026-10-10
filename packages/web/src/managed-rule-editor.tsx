import { useEffect, useRef, useState, type FormEvent, type Dispatch, type SetStateAction } from "react";
import { ApiError, type RepositorySummary } from "./api";
import { DetailDrawer } from "./ui";
import { Icon } from "./icons";
import { formatDate } from "./layout";
import { RuleHierarchyFields, RuleHierarchyTags, RuleOverrideDetail } from "./rule-hierarchy";
import { generateRule, getManagedRules, saveManagedRule, ruleCategoryLabels, ruleSeverityLabels,
  type GeneratedRuleDraft, type ManagedRule, type ManagedRuleInput, type RuleCategory, type RuleSeverity } from "./managed-rules-api";

export function ManagedRuleDetail({ rule, repositories }: { rule: ManagedRule; repositories: RepositorySummary[] }) {
  return <div className="rule-detail"><div className="rule-detail-tags"><span className="status-badge">工作台规范</span><RuleHierarchyTags rule={rule} /><span className="status-badge">{rule.status === "active" ? "已启用" : "草稿"}</span><span className="status-badge">{ruleCategoryLabels[rule.category]}</span><span className="status-badge">{ruleSeverityLabels[rule.severity]}</span></div>
    <section><h3>规范正文</h3><p className="rule-body">{rule.body}</p></section>
    <section><h3>作用范围</h3>{rule.scope === "global" ? <p>当前团队的全部仓库</p> : rule.repositories.map((entry) => <div className="managed-scope-detail" key={entry.repositoryId}><strong>{repositories.find((item) => item.id === entry.repositoryId)?.pathWithNamespace ?? "所选仓库"}</strong><p>{entry.paths.length ? entry.paths.map((path) => <code key={path}>{path}</code>) : "全部路径"}</p></div>)}</section>
    <RuleOverrideDetail overrides={rule.overrides} />
    {rule.goodExample && <section><h3>正确示例</h3><pre className="code-block"><code>{rule.goodExample}</code></pre></section>}
    {rule.badExample && <section><h3>反例</h3><pre className="code-block"><code>{rule.badExample}</code></pre></section>}
    <section><h3>保存信息</h3><dl className="rule-metadata"><div><dt>版本</dt><dd>{rule.version}</dd></div><div><dt>更新时间</dt><dd>{formatDate(rule.updatedAt)}</dd></div><div><dt>存储位置</dt><dd>uReview 工作台</dd></div></dl><p className="muted">{rule.status === "active" ? "应用于之后发起的评审。已有评审保留当时的规范快照。" : "草稿尚未参与评审，管理员可以编辑并启用。"}</p></section>
  </div>;
}

export type RuleRepositoryTarget = { repositoryId: string; paths: string };
export function ManagedRuleFields({ draft, scope, targets, repositories, disabled, update, setScope, setTargets, overrides, setOverrides, ruleId }: {
  draft: GeneratedRuleDraft; scope: ManagedRuleInput["scope"]; targets: RuleRepositoryTarget[]; repositories: RepositorySummary[]; disabled: boolean;
  overrides: string[]; setOverrides: (value: string[]) => void; ruleId?: string;
  update: <K extends keyof GeneratedRuleDraft>(key: K, value: GeneratedRuleDraft[K]) => void;
  setScope: (scope: ManagedRuleInput["scope"]) => void;
  setTargets: Dispatch<SetStateAction<RuleRepositoryTarget[]>>;
}) {
  return <fieldset disabled={disabled}><div className="field"><label htmlFor="managed-rule-name">规范名称</label><input id="managed-rule-name" value={draft.name} onChange={(event) => update("name", event.target.value)} required maxLength={160} /></div>
        <div className="field"><label htmlFor="managed-rule-body">规范正文</label><textarea id="managed-rule-body" value={draft.body} onChange={(event) => update("body", event.target.value)} required maxLength={12000} rows={7} /></div>
        <RuleHierarchyFields draft={draft} overrides={overrides} setOverrides={setOverrides} ruleId={ruleId} update={update} />
        <div className="field"><label className="managed-judgement-label" htmlFor="managed-rule-judgement"><input id="managed-rule-judgement" type="checkbox" checked={draft.judgement} onChange={(event) => update("judgement", event.target.checked)} aria-describedby="managed-judgement-hint" />判断题</label><p id="managed-judgement-hint" className="field-hint">用于需要结合上下文判断的规范。命中时以「可能的 X」表述，说明依据与例外，严重度最高为中危；与团队规范冲突时以团队规范为准。</p></div>
        <div className="managed-editor-columns"><div className="field"><label htmlFor="managed-rule-category">分类</label><select id="managed-rule-category" value={draft.category} onChange={(event) => update("category", event.target.value as RuleCategory)}>{Object.entries(ruleCategoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="field"><label htmlFor="managed-rule-severity">严重度</label><select id="managed-rule-severity" value={draft.severity} onChange={(event) => update("severity", event.target.value as RuleSeverity)} aria-describedby="managed-severity-hint">{Object.entries(ruleSeverityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></div>
        <p id="managed-severity-hint" className="field-hint managed-severity-hint">严重度用于评审中的处理优先级。建议级对应低危，低危结论默认不展示。</p>
        <div className="field"><label htmlFor="managed-rule-scope">作用域</label><select id="managed-rule-scope" value={scope} onChange={(event) => setScope(event.target.value as ManagedRuleInput["scope"])}><option value="global">全局 · 当前团队全部仓库</option><option value="repositories">指定仓库与路径</option></select></div>
        {scope === "repositories" && <section className="managed-repository-picker" aria-label="规范适用仓库"><p className="field-hint">选择至少一个仓库，每个仓库可单独限定路径。</p>
          {repositories.length === 0 && <p className="feedback" role="status">尚无可选仓库，请先接入仓库。</p>}
          {repositories.map((repository) => {
            const target = targets.find((entry) => entry.repositoryId === repository.id);
            return <div className="managed-repository-option" key={repository.id}><label className="managed-repository-label"><input type="checkbox" checked={Boolean(target)} onChange={(event) => setTargets((current) => event.target.checked ? [...current, { repositoryId: repository.id, paths: "" }] : current.filter((entry) => entry.repositoryId !== repository.id))} /><span>{repository.pathWithNamespace}</span></label>
              {target && <div className="managed-repository-paths"><label htmlFor={`paths-${repository.id}`}>适用路径</label><textarea id={`paths-${repository.id}`} value={target.paths} rows={3} onChange={(event) => setTargets((current) => current.map((entry) => entry.repositoryId === repository.id ? { ...entry, paths: event.target.value } : entry))} placeholder={"src/**/*.ts\npackages/payments/**"} aria-describedby={`paths-hint-${repository.id}`} /><p id={`paths-hint-${repository.id}`} className="field-hint">每行一个相对仓库根目录的 glob，留空适用全部路径。最多 64 行，每行 256 字符。</p></div>}
            </div>;
          })}
        </section>}
        <div className="field"><label htmlFor="managed-rule-good">正确示例 <span className="muted">可选</span></label><textarea className="managed-code-input" id="managed-rule-good" value={draft.goodExample} onChange={(event) => update("goodExample", event.target.value)} maxLength={12000} rows={5} spellCheck={false} /></div>
        <div className="field"><label htmlFor="managed-rule-bad">反例 <span className="muted">可选</span></label><textarea className="managed-code-input" id="managed-rule-bad" value={draft.badExample} onChange={(event) => update("badExample", event.target.value)} maxLength={12000} rows={5} spellCheck={false} /></div>
      </fieldset>;
}

export function ManagedRuleEditor({ rule, repositories, initialRepository, onClose, onSaved, saveOverride }: {
  rule?: ManagedRule; repositories: RepositorySummary[]; initialRepository?: string; onClose: () => void; onSaved: (rule: ManagedRule) => void;
  saveOverride?: (input: ManagedRuleInput, existing: { id: string; version: number } | undefined, signal: AbortSignal) => Promise<{ rule: ManagedRule }>;
}) {
  const [intent, setIntent] = useState("");
  const [baseRule, setBaseRule] = useState(rule);
  const [conflict, setConflict] = useState(false);
  const [latestRule, setLatestRule] = useState<ManagedRule>();
  const [versionNotice, setVersionNotice] = useState("");
  const [draft, setDraft] = useState<GeneratedRuleDraft | undefined>(() => rule ? {
    name: rule.name, body: rule.body, goodExample: rule.goodExample, badExample: rule.badExample, category: rule.category, severity: rule.severity,
    layer: rule.layer, languages: rule.languages, judgement: rule.judgement,
  } : undefined);
  const [overrides, setOverrides] = useState<string[]>(rule?.overrides ?? []);
  const [scope, setScope] = useState<ManagedRuleInput["scope"]>(rule?.scope ?? (initialRepository ? "repositories" : "global"));
  const [targets, setTargets] = useState<Array<{ repositoryId: string; paths: string }>>(() => rule?.repositories.map((entry) => ({ repositoryId: entry.repositoryId, paths: entry.paths.join("\n") })) ?? (initialRepository ? [{ repositoryId: initialRepository, paths: "" }] : []));
  const [busy, setBusy] = useState<"generating" | "saving" | "loading-version" | null>(null);
  const [error, setError] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const draftHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);
  function update<K extends keyof GeneratedRuleDraft>(key: K, value: GeneratedRuleDraft[K]) { setDraft((current) => current ? { ...current, [key]: value } : current); }
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (pending.current || !intent.trim()) return;
    pending.current = true; setBusy("generating"); setError("");
    const controller = new AbortController(); activeRequest.current = controller;
    try {
      const result = await generateRule(intent.trim(), controller.signal);
      if (controller.signal.aborted) return;
      setDraft(result.draft);
      requestAnimationFrame(() => draftHeading.current?.focus());
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "草稿生成失败，请重试。"); }
    finally { if (!controller.signal.aborted) { pending.current = false; setBusy(null); } }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || !draft || conflict) return;
    const submittedStatus = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-status");
    const status = submittedStatus === "draft" || submittedStatus === "active" ? submittedStatus : baseRule?.status ?? "draft";
    if (scope === "repositories" && targets.length === 0) { setError("请至少选择一个仓库。"); return; }
    if (scope === "repositories" && targets.length > 100) { setError("一条规范最多选择 100 个仓库。"); return; }
    if (scope === "repositories" && targets.some((entry) => {
      const paths = entry.paths.split("\n").map((path) => path.trim()).filter(Boolean);
      return paths.length > 64 || paths.some((path) => path.length > 256);
    })) { setError("每个仓库最多填写 64 条路径，每条不超过 256 字符。"); return; }
    pending.current = true; setBusy("saving"); setError("");
    const controller = new AbortController(); activeRequest.current = controller;
    const input: ManagedRuleInput = { name: draft.name.trim(), body: draft.body.trim(), goodExample: draft.goodExample,
      badExample: draft.badExample, category: draft.category, severity: draft.severity, scope,
      layer: draft.layer, languages: draft.languages, judgement: draft.judgement, overrides,
      repositories: scope === "global" ? [] : targets.map((entry) => ({ repositoryId: entry.repositoryId, paths: [...new Set(entry.paths.split("\n").map((path) => path.trim()).filter(Boolean))] })), status };
    try {
      const result = await (saveOverride ?? saveManagedRule)(input, baseRule, controller.signal);
      if (!controller.signal.aborted) onSaved(result.rule);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.code === "version_conflict") {
        setConflict(true); setLatestRule(undefined); setVersionNotice("");
        setError("这条规范已被其他人更新。当前编辑内容已保留，请载入最新版本进行核对。");
      } else setError(`${cause instanceof Error ? cause.message : "保存未完成。"} 当前编辑内容已保留。`);
    }
    finally { if (!controller.signal.aborted) { pending.current = false; setBusy(null); } }
  }
  async function loadLatest() {
    if (!baseRule || pending.current) return;
    pending.current = true; setBusy("loading-version");
    const controller = new AbortController(); activeRequest.current = controller;
    try {
      const result = await getManagedRules(undefined, controller.signal);
      if (controller.signal.aborted) return;
      const latest = result.rules.find((item) => item.id === baseRule.id);
      if (!latest) { setError("这条规范已不可用，当前编辑内容仍保留。请联系团队管理员。"); return; }
      setLatestRule(latest); setError("");
    } catch (cause) { if (!controller.signal.aborted) setError(`${cause instanceof Error ? cause.message : "最新版本读取失败。"} 当前编辑内容已保留。`); }
    finally { if (!controller.signal.aborted) { pending.current = false; setBusy(null); } }
  }
  return <DetailDrawer title={rule ? "编辑工作台规范" : "生成新规则"} onClose={() => { if (busy !== "saving") onClose(); }}>
    {!draft ? <form className="managed-rule-intent" onSubmit={(event) => void generate(event)} aria-busy={busy === "generating"}>
      <span className="managed-editor-icon"><Icon name="rules" size={24} /></span><h3>描述你希望团队遵守的约定</h3><p className="muted">AI 会整理出规范正文和示例。生成后可以修改，再选择保存方式。</p>
      <label htmlFor="rule-intent">规范要求</label><textarea id="rule-intent" value={intent} onChange={(event) => setIntent(event.target.value)} required maxLength={4000} rows={7} disabled={busy !== null} placeholder="例如：处理金额时使用整数分，避免浮点计算误差。请给出 TypeScript 的正确示例和反例。" />
      <p className="field-hint">说明要检查的行为、适用场景和例外，最多 4,000 字符。</p>
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
      <button type="submit" className="button primary-button" disabled={busy !== null || !intent.trim()}>{busy === "generating" ? <><span className="spinner" />正在生成草稿…</> : <><Icon name="rules" size={16} />生成草稿</>}</button>
      {busy === "generating" && <p role="status" className="field-hint">正在生成规范，关闭面板可取消等待。</p>}
    </form> : <form className="managed-rule-form" onSubmit={(event) => void save(event)} aria-busy={busy === "saving"}>
      <div className="managed-editor-intro"><h3 ref={draftHeading} tabIndex={-1}>{baseRule ? `版本 ${baseRule.version} · ${baseRule.status === "active" ? "已启用" : "草稿"}` : "检查生成的草稿"}</h3><p className="muted">规范保存在工作台。启用后按作用范围参与之后发起的评审。</p>{versionNotice && <p className="managed-version-notice" role="status">{versionNotice}</p>}</div>
      <ManagedRuleFields draft={draft} scope={scope} targets={targets} repositories={repositories} disabled={busy !== null} update={update} setScope={setScope} setTargets={setTargets} overrides={overrides} setOverrides={setOverrides} ruleId={rule?.id} />
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
      {conflict && <section className="managed-version-conflict" aria-label="核对最新规范"><p>你的编辑保留在上方。请先核对最新内容，再选择保存方式。</p><button type="button" className="button secondary-button" disabled={busy !== null} onClick={() => void loadLatest()}>{busy === "loading-version" ? "正在读取…" : "载入最新版本以核对"}</button>
        {latestRule && <><details open className="managed-latest-version"><summary>最新版本 {latestRule.version} · {latestRule.name}</summary><ManagedRuleDetail rule={latestRule} repositories={repositories} /></details><button type="button" className="button secondary-button" disabled={busy !== null} onClick={() => {
          setBaseRule(latestRule); setConflict(false); setLatestRule(undefined); setError(""); setVersionNotice(`已核对版本 ${latestRule.version}，当前编辑内容保持不变。请选择下方的保存方式。`);
        }}>已核对，使用最新版本继续保存</button></>}
      </section>}
      <div className="managed-editor-actions"><button type="submit" data-status="active" className="button primary-button" disabled={busy !== null || conflict}>{busy === "saving" ? "正在保存…" : saveOverride ? "保存修改并采纳提案" : baseRule?.status === "active" ? "保存更改" : "保存并启用"}</button><button type="submit" data-status="draft" className="button secondary-button" disabled={busy !== null || conflict}>{baseRule?.status === "active" ? "停用并保存草稿" : "保存草稿"}</button></div>
      <p className="field-hint">{baseRule?.status === "active" ? "停用后，后续评审将不再使用这条规范。" : "草稿保留在提案列表，尚不参与评审。"}已有评审的规范快照保持不变。</p>
      {!rule && <button type="button" className="text-button managed-back" disabled={busy !== null} onClick={() => { setDraft(undefined); setError(""); }}>返回修改要求</button>}
    </form>}
  </DetailDrawer>;
}
