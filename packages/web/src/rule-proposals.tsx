import { useEffect, useRef, useState, type FormEvent } from "react";
import { type RepositorySummary } from "./api";
import { formatDate } from "./layout";
import { DetailDrawer } from "./ui";
import { Icon } from "./icons";
import { CandidateDetail } from "./rule-candidate";
import { ManagedRuleEditor } from "./managed-rule-editor";
import { type ManagedRule } from "./managed-rules-api";
import { getRuleDetail, isManagedRuleId, ruleDetailUrl } from "./rule-detail-api";
import { dispositionReasonLabels } from "./review-api";
import { batchReviewTargets, getRuleProposals, proposalNeedsEditing, reviewRuleProposal, reviewRuleProposalBatch, proposalSourceLabels, proposalStatusLabels, type ProposalReviewStatus, type ProposalSource, type ProposalStatus, type RuleProposal } from "./rule-proposals-api";

function ProposalDetail({ proposal, canManage, repositories, onReviewed, onClose }: {
  proposal: RuleProposal; canManage: boolean; repositories: RepositorySummary[]; onReviewed: () => void; onClose: () => void;
}) {
  const [current, setCurrent] = useState(proposal);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copy, setCopy] = useState("");
  const [suggestedBody, setSuggestedBody] = useState(proposal.body);
  const [editing, setEditing] = useState<ManagedRule | null>(null);
  const [snapshotDetailAvailable, setSnapshotDetailAvailable] = useState(false);
  const ruleId = current.ruleId ?? (current.managedRuleId ? `managed:${current.managedRuleId}` : null);
  const deletedManagedRule = Boolean(!current.managedRuleId && ruleId && isManagedRuleId(ruleId));
  const needsSnapshotDetail = deletedManagedRule || Boolean(ruleId?.startsWith("managed:") && !isManagedRuleId(ruleId));
  const gitFeedback = current.source === "feedback" && !current.managedRuleId && ruleId && !isManagedRuleId(ruleId);
  useEffect(() => {
    setSnapshotDetailAvailable(false);
    if (!needsSnapshotDetail || !ruleId || !deletedManagedRule && !current.repositoryId) return;
    const controller = new AbortController();
    void getRuleDetail(ruleId, deletedManagedRule ? undefined : current.repositoryId ?? undefined, controller.signal)
      .then(() => { if (!controller.signal.aborted) setSnapshotDetailAvailable(true); }).catch(() => {});
    return () => controller.abort();
  }, [needsSnapshotDetail, deletedManagedRule, ruleId, current.repositoryId]);
  const detailUrl = ruleId && (!needsSnapshotDetail || snapshotDetailAvailable) ? ruleDetailUrl(ruleId, deletedManagedRule ? undefined : current.repositoryId ?? undefined) : null;
  const gitSuggestion = ["# 规范修改建议", "", suggestedBody, "", "## 驳回反馈", ...current.feedback.map((entry) => `- ${entry.title}${entry.explanation ? `：${entry.explanation}` : ""}`)].join("\n");
  async function review(status: "accepted" | "rejected") {
    if (busy) return; setBusy(true); setError("");
    try {
      if (status === "accepted" && current.source === "feedback" && current.managedRuleId) {
        const result = await getRuleDetail(`managed:${current.managedRuleId}`);
        if (!result.rule.managedRule) throw new Error("工作台规范不可用");
        setEditing(result.rule.managedRule);
      } else { const result = await reviewRuleProposal(current.id, { status, ...(status === "rejected" ? { reason: reason.trim() } : {}) }); setCurrent(result.proposal); setRejecting(false); onReviewed(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "提案审核失败"); }
    finally { setBusy(false); }
  }
  function reject(event: FormEvent) { event.preventDefault(); if (reason.trim()) void review("rejected"); }
  async function copySuggestion() {
    try { await navigator.clipboard.writeText(gitSuggestion); setCopy("已复制修改建议"); }
    catch { setCopy("请从下方文本框中选中并复制。"); }
  }
  if (editing) return <ManagedRuleEditor rule={editing} repositories={repositories} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onReviewed(); onClose(); }} saveOverride={async (input, existing, signal) => {
    if (!existing) throw new Error("缺少当前规范版本");
    const result = await reviewRuleProposal(current.id, { status: "accepted", rule: { ...input, version: existing.version } }, signal);
    if (!result.rule) throw new Error("审核结果未包含规范，请刷新提案列表。");
    return { rule: result.rule };
  }} />;
  return <DetailDrawer title={current.name} onClose={() => { if (!busy) onClose(); }}><div className="rule-detail proposal-detail"><div className="rule-detail-tags"><span className="status-badge">{proposalSourceLabels[current.source]}</span><span className={`status-badge ${current.status === "accepted" ? "rule-status-active" : ""}`}>{proposalStatusLabels[current.status]}</span>{current.candidate?.active && <span className="status-badge rule-status-active">已在 Git 中生效</span>}</div>
    <p className="muted">创建于 {formatDate(current.createdAt)}</p>{deletedManagedRule && <p className="rule-notice">关联规范已删除，提案历史保留。</p>}{detailUrl && <p><a href={detailUrl}>查看关联规范与执行记录 →</a></p>}
    {current.candidate ? <CandidateDetail candidate={current.candidate} repositoryName={repositories.find((entry) => entry.id === current.candidate?.repositoryId)?.pathWithNamespace ?? "仓库"} /> : <section><h3>提案正文</h3><p className="rule-body">{current.body}</p></section>}
    {current.source === "feedback" && <section><h3>驳回反馈 · {current.feedbackCount} 次</h3><p>{current.reasonCategory && dispositionReasonLabels[current.reasonCategory]}</p><ul className="proposal-feedback-list">{current.feedback.map((entry) => <li key={`${entry.reviewId}:${entry.findingId}:${entry.createdAt}`}><a href={`/?review=${encodeURIComponent(entry.reviewId)}#finding-${encodeURIComponent(entry.findingId)}`}>{entry.title}</a>{entry.explanation && <p className="rule-body">{entry.explanation}</p>}<time dateTime={entry.createdAt}>{formatDate(entry.createdAt)}</time></li>)}</ul></section>}
    {gitFeedback && <section><h3>Git 规范修改建议</h3><p className="muted">结合驳回反馈调整规范，由人在仓库提交，再同步目录。</p><div className="managed-rule-form"><label htmlFor="git-suggestion-body">建议规范正文</label><textarea id="git-suggestion-body" readOnly={!canManage} rows={7} value={suggestedBody} onChange={(event) => setSuggestedBody(event.target.value)} /></div><button className="button secondary-button" onClick={() => void copySuggestion()}><Icon name="copy" size={15} />复制修改建议</button>{copy && <p role="status">{copy}</p>}<details className="rule-markdown"><summary>查看可复制内容</summary><textarea readOnly aria-label="Git 规范修改建议" value={gitSuggestion} /></details></section>}
    {current.reviewedBy && <section><h3>审核记录</h3><p>{current.reviewedBy.name} · {current.reviewedAt ? formatDate(current.reviewedAt) : ""} · {proposalStatusLabels[current.status]}</p>{current.rejectionReason && <p className="rule-body">拒绝理由：{current.rejectionReason}</p>}</section>}
    {current.status === "pending" && !deletedManagedRule && (canManage ? <section className="proposal-review"><h3>审核提案</h3>{current.source === "feedback" && current.managedRuleId && <p className="muted">打开编辑器修改规范，保存后完成采纳。</p>}{current.source === "mining" && <p className="muted">采纳后由人在仓库提交上方规范内容。同步目录后显示生效状态。</p>}
      {!rejecting ? <div className="managed-editor-actions"><button className="button primary-button" disabled={busy} onClick={() => void review("accepted")}>{busy ? "正在处理…" : current.source === "feedback" && current.managedRuleId ? "采纳并修改规范" : "采纳提案"}</button><button className="button secondary-button" disabled={busy} onClick={() => setRejecting(true)}>拒绝提案</button></div> : <form className="managed-rule-form" onSubmit={reject}><div className="field"><label htmlFor="proposal-rejection-reason">拒绝理由</label><textarea id="proposal-rejection-reason" required maxLength={2000} rows={3} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></div><div className="managed-editor-actions"><button className="button primary-button" disabled={busy || !reason.trim()}>{busy ? "正在拒绝…" : "确认拒绝"}</button><button className="button secondary-button" type="button" disabled={busy} onClick={() => setRejecting(false)}>取消</button></div></form>}
    </section> : <p className="rule-notice">团队管理员可以审核此提案。</p>)}{error && <p className="feedback feedback-error" role="alert">{error}</p>}
  </div></DetailDrawer>;
}

export function RuleProposals({ repositoryId, repositories, canManage, revision, onChanged }: { repositoryId?: string; repositories: RepositorySummary[]; canManage: boolean; revision: number; onChanged: () => void }) {
  const initialStatus = new URLSearchParams(window.location.search).get("proposalStatus");
  const [status, setStatus] = useState<ProposalStatus | "">(initialStatus === "accepted" || initialStatus === "rejected" || initialStatus === "withdrawn" ? initialStatus : "pending");
  const [source, setSource] = useState<ProposalSource | "">(""); const [search, setSearch] = useState("");
  const [proposals, setProposals] = useState<RuleProposal[]>([]); const [selected, setSelected] = useState<RuleProposal | null>(null);
  const [loading, setLoading] = useState(true); const [error, setError] = useState(""); const [localRevision, setLocalRevision] = useState(0);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchAction, setBatchAction] = useState<ProposalReviewStatus | null>(null);
  const [batchReason, setBatchReason] = useState(""); const [batchBusy, setBatchBusy] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ completed: number; total: number; succeeded: number; failed: number } | null>(null);
  const [batchFailures, setBatchFailures] = useState<Array<{ id: string; name: string; error: string }>>([]);
  const batchRequest = useRef<AbortController | null>(null);
  const selectAll = useRef<HTMLInputElement>(null);
  useEffect(() => {
    batchRequest.current?.abort(); batchRequest.current = null;
    setSelectedIds([]); setBatchAction(null); setBatchReason(""); setBatchBusy(false); setBatchProgress(null); setBatchFailures([]);
  }, [repositoryId, status, source, search, canManage]);
  useEffect(() => () => { batchRequest.current?.abort(); }, []);
  useEffect(() => {
    if (batchBusy) return;
    const controller = new AbortController(); setLoading(true); setError("");
    void getRuleProposals({ repositoryId, status: status || undefined, source: source || undefined }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setProposals(result.proposals);
      setSelectedIds((current) => current.filter((id) => result.proposals.some((proposal) => proposal.id === id && proposal.status === "pending")));
    }).catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "提案读取失败"); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repositoryId, status, source, revision, localRevision, batchBusy]);
  const visible = proposals.filter((proposal) => (!status || proposal.status === status) && (!source || proposal.source === source)
    && `${proposal.name} ${proposal.body}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const pending = visible.filter((proposal) => proposal.status === "pending");
  const selectedPending = pending.filter((proposal) => selectedIds.includes(proposal.id));
  const acceptedTargets = batchReviewTargets(selectedPending, "accepted");
  const deferredCount = selectedPending.filter(proposalNeedsEditing).length;
  const batchTargets = batchAction ? batchReviewTargets(selectedPending, batchAction) : [];
  const locked = loading || Boolean(error) || batchBusy;
  const allSelected = pending.length > 0 && selectedPending.length === pending.length;
  useEffect(() => { if (selectAll.current) selectAll.current.indeterminate = selectedPending.length > 0 && !allSelected; }, [selectedPending.length, allSelected]);
  function reviewed() { setLocalRevision((value) => value + 1); onChanged(); }
  function openBatch(action: ProposalReviewStatus) {
    if (!canManage || locked || !batchReviewTargets(selectedPending, action).length) return;
    setBatchAction(action); setBatchProgress(null); setBatchFailures([]);
  }
  async function submitBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || locked || batchRequest.current || !batchAction || !batchTargets.length) return;
    if (batchAction === "rejected" && (!batchReason.trim() || batchReason.trim().length > 2000)) return;
    const controller = new AbortController(); batchRequest.current = controller;
    const targets = batchTargets; const progress = { completed: 0, total: targets.length, succeeded: 0, failed: 0 };
    setBatchBusy(true); setBatchFailures([]); setBatchProgress({ ...progress });
    try {
      await reviewRuleProposalBatch(targets, { status: batchAction, ...(batchAction === "rejected" ? { reason: batchReason } : {}) }, (result) => {
        progress.completed++;
        if ("proposal" in result) {
          progress.succeeded++;
          setProposals((current) => current.map((proposal) => proposal.id === result.id ? result.proposal : proposal));
          setSelectedIds((current) => current.filter((id) => id !== result.id));
        } else {
          progress.failed++;
          setBatchFailures((current) => [...current, result]);
        }
        setBatchProgress({ ...progress });
      }, controller.signal);
    } finally {
      if (batchRequest.current === controller && !controller.signal.aborted) {
        batchRequest.current = null; setBatchBusy(false);
        if (progress.succeeded) onChanged();
      }
    }
  }
  const progressText = batchProgress && `${batchBusy ? "正在审核" : "审核完成"} ${batchProgress.completed}/${batchProgress.total} 条，成功 ${batchProgress.succeeded} 条，失败 ${batchProgress.failed} 条。`;
  return <section aria-label="规范提案"><div className="toolbar rules-toolbar"><label className="search-field"><Icon name="search" size={17} /><input aria-label="搜索提案" placeholder="搜索提案名称或正文…" value={search} disabled={batchBusy} onChange={(event) => setSearch(event.target.value)} /></label><label className="rules-filter">状态<select aria-label="筛选提案状态" value={status} disabled={batchBusy} onChange={(event) => setStatus(event.target.value as ProposalStatus | "")}><option value="">全部状态</option>{Object.entries(proposalStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="rules-filter">来源<select aria-label="筛选提案来源" value={source} disabled={batchBusy} onChange={(event) => setSource(event.target.value as ProposalSource | "")}><option value="">全部来源</option>{Object.entries(proposalSourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
    {loading && <p role="status">正在读取提案…</p>}{error && <p role="alert" className="feedback feedback-error">{error}<button className="text-button" disabled={batchBusy} onClick={() => setLocalRevision((value) => value + 1)}>重试</button></p>}
    {canManage && <div className="proposal-batch-toolbar"><span>已选 {selectedPending.length} 条待审核提案</span><div className="proposal-batch-actions">
      <button type="button" className="button primary-button" disabled={locked || !acceptedTargets.length} onClick={() => openBatch("accepted")}>批量采纳 {acceptedTargets.length} 条</button>
      <button type="button" className="button secondary-button" disabled={locked || !selectedPending.length} onClick={() => openBatch("rejected")}>批量拒绝 {selectedPending.length} 条</button>
      <button type="button" className="text-button" disabled={locked || !selectedPending.length} onClick={() => setSelectedIds([])}>取消选择</button>
    </div>{deferredCount > 0 && <p className="field-hint">所选中 {deferredCount} 条反馈需逐条修改规范后采纳，批量采纳后保留选择。</p>}</div>}
    {progressText && !batchAction && <p className="feedback" role="status">{progressText}</p>}
    <div className="table-scroll rules-table-wrap"><table className="data-table rules-table proposals-table"><thead><tr>
      {canManage && <th className="proposal-selection-cell"><input ref={selectAll} type="checkbox" aria-label="选择当前可见的待审核提案" checked={allSelected} disabled={locked || !pending.length} onChange={(event) => setSelectedIds(event.target.checked ? pending.map((proposal) => proposal.id) : [])} /></th>}
      <th>提案</th><th>来源</th><th>状态</th><th>关联与反馈</th><th>创建时间</th></tr></thead><tbody>{visible.map((proposal) => <tr key={proposal.id} className={selectedIds.includes(proposal.id) ? "proposal-selected" : undefined}>
        {canManage && <td className="proposal-selection-cell">{proposal.status === "pending" && <input type="checkbox" aria-label={`选择提案：${proposal.name}`} checked={selectedIds.includes(proposal.id)} disabled={locked} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, proposal.id] : current.filter((id) => id !== proposal.id))} />}</td>}
        <td className="proposal-title-cell"><button className="rule-title-button" disabled={batchBusy} onClick={() => setSelected(proposal)}>{proposal.name}<Icon name="chevron-right" size={15} /></button><div className="table-secondary rule-table-description">{proposal.body}</div></td><td>{proposalSourceLabels[proposal.source]}</td><td><span className="status-badge">{proposalStatusLabels[proposal.status]}</span>{proposal.candidate?.active && <div className="table-secondary">已在 Git 中生效</div>}</td><td>{proposal.source === "feedback" ? <>{proposal.feedbackCount} 次 · {proposal.reasonCategory && dispositionReasonLabels[proposal.reasonCategory]}</> : proposal.repositoryId ? repositories.find((repository) => repository.id === proposal.repositoryId)?.pathWithNamespace ?? "所选仓库" : "团队规范"}</td><td>{formatDate(proposal.createdAt)}</td></tr>)}</tbody></table>{!loading && !error && !visible.length && <div className="empty-state rules-empty"><h2>暂无匹配的提案</h2><p>生成草稿、挖掘历史候选或驳回规范问题后，提案会出现在这里。</p></div>}</div>
    {selected && <ProposalDetail key={selected.id} proposal={selected} repositories={repositories} canManage={canManage && !locked} onClose={() => setSelected(null)} onReviewed={reviewed} />}
    {batchAction && <DetailDrawer title={batchAction === "accepted" ? "批量采纳提案" : "批量拒绝提案"} onClose={() => { if (!batchRequest.current) setBatchAction(null); }}>
      <form className="managed-rule-form proposal-batch-form" onSubmit={(event) => void submitBatch(event)}>
        <p>{batchBusy ? `正在逐条审核 ${batchProgress?.total ?? 0} 条提案。` : batchProgress && !batchTargets.length ? "本次审核已完成。" : `将${batchAction === "accepted" ? "采纳" : "拒绝"}当前所选的 ${batchTargets.length} 条待审核提案。`}</p>
        {batchAction === "accepted" && deferredCount > 0 && <p className="rule-notice">另有 {deferredCount} 条反馈需逐条修改规范后采纳，本次保留其选择。</p>}
        {batchAction === "accepted" && batchTargets.some((proposal) => proposal.source === "mining" || proposal.source === "feedback") && <p className="muted">Git 规范的采纳结果会记录在工作台，规范内容需由人在仓库提交。</p>}
        {batchTargets.length > 0 && <ul className="proposal-batch-targets">{batchTargets.map((proposal) => <li key={proposal.id}>{proposal.name}<span>{proposalSourceLabels[proposal.source]}</span></li>)}</ul>}
        {batchAction === "rejected" && <div className="field"><label htmlFor="proposal-batch-reason">共同拒绝理由</label><textarea id="proposal-batch-reason" required maxLength={2000} rows={4} value={batchReason} disabled={batchBusy} onChange={(event) => setBatchReason(event.target.value)} /><p className="field-hint">所选提案使用同一拒绝理由，最多 2000 个字符。</p></div>}
        {progressText && <p className="feedback" role="status">{progressText}</p>}
        {batchFailures.length > 0 && <div className="feedback feedback-error" role="alert"><p>以下提案审核失败；仍待审核的提案保留选择，可重试。</p><ul className="proposal-batch-errors">{batchFailures.map((failure) => <li key={failure.id}><strong>{failure.name}</strong>：{failure.error}</li>)}</ul></div>}
        {error && <p className="feedback feedback-error" role="alert">{error}<button type="button" className="text-button" onClick={() => setLocalRevision((value) => value + 1)}>重新读取提案</button></p>}
        <div className="managed-editor-actions">{batchTargets.length > 0 && <button className="button primary-button" type="submit" disabled={locked || (batchAction === "rejected" && !batchReason.trim())}>{batchBusy ? "正在审核…" : `${batchFailures.length ? "重试" : "确认"}${batchAction === "accepted" ? "采纳" : "拒绝"} ${batchTargets.length} 条`}</button>}<button type="button" className="button secondary-button" disabled={batchBusy} onClick={() => setBatchAction(null)}>{batchProgress ? "关闭" : "取消"}</button></div>
      </form>
    </DetailDrawer>}
  </section>;
}
