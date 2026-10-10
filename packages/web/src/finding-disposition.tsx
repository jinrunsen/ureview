import { useId, useState, type FormEvent } from "react";
import { ApiError } from "./api";
import { formatDate } from "./layout";
import {
  dispositionReasonLabels, setFindingDisposition,
  type DispositionReason, type FindingDisposition, type FindingStatus, type ReviewFinding,
} from "./review-api";
import "./finding-disposition.css";

export const findingStatusLabels: Record<FindingStatus, string> = {
  Pending: "待处理", Resolved: "已采纳", Dismissed: "已驳回", Ignored: "被无视", Outdated: "已过时",
};
export type RefreshDisposition = (updated?: ReviewFinding) => Promise<void>;

export function DispositionSummary({ status, disposition }: { status: FindingStatus; disposition?: FindingDisposition | null }) {
  return <div className="disposition-summary">
    <span className={`disposition-status disposition-${status.toLowerCase()}`}>{findingStatusLabels[status]}</span>
    {disposition?.actor && <span>{disposition.actor.name}</span>}
    {disposition?.updatedAt && <time dateTime={disposition.updatedAt}>{formatDate(disposition.updatedAt)}</time>}
    {disposition?.reasonCategory && <span>{dispositionReasonLabels[disposition.reasonCategory]}</span>}
    {disposition?.explanation && <p className="disposition-explanation">{disposition.explanation}</p>}
  </div>;
}

export function FindingComparison({ finding }: { finding: ReviewFinding }) {
  if (!finding.comparison) return null;
  const previous = finding.comparison.previousFinding;
  return <div className="finding-comparison">
    <span className="comparison-badge">{finding.comparison.kind === "new" ? "新出现" : "上一轮也有"}</span>
    {previous && (previous.status === "Resolved" || previous.status === "Dismissed") && <div className="previous-disposition">
      <p><a href={`/?review=${encodeURIComponent(previous.reviewId)}#finding-${encodeURIComponent(previous.findingId)}`}>第 {previous.round} 轮处置参考</a></p>
      <DispositionSummary status={previous.status} disposition={previous.disposition} />
    </div>}
  </div>;
}

export function FindingDispositionControls({ reviewId, finding, onRefresh }: {
  reviewId: string; finding: ReviewFinding; onRefresh: RefreshDisposition;
}) {
  const formId = useId();
  const [open, setOpen] = useState(false);
  const [reasonCategory, setReasonCategory] = useState<DispositionReason | "">("");
  const [explanation, setExplanation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const canChange = finding.status === "Pending" || finding.status === "Resolved" || finding.status === "Dismissed";

  async function save(status: "Resolved" | "Dismissed" | "Pending") {
    if (busy || needsRefresh) return;
    if (status === "Dismissed" && (!reasonCategory || (reasonCategory === "other" && !explanation.trim()))) return;
    setBusy(true); setError("");
    let saved = false;
    try {
      const updated = await setFindingDisposition(reviewId, finding.id, {
        version: finding.disposition?.version ?? 0, status,
        ...(status === "Dismissed" && reasonCategory ? { reasonCategory, explanation: explanation.trim() } : {}),
      });
      saved = true;
      setOpen(false); setReasonCategory(""); setExplanation("");
      await onRefresh(updated);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        setNeedsRefresh(true);
        setError("这条 finding 的处置已被修改。请刷新处置，核对后重新提交；填写的理由已保留。");
      } else {
        setNeedsRefresh(saved);
        setError(saved ? "处置已保存，评审详情暂时未能刷新。请刷新处置。" : cause instanceof Error ? cause.message : "处置未保存，请重试。");
      }
    } finally { setBusy(false); }
  }
  async function refresh() {
    if (busy) return;
    setBusy(true);
    try { await onRefresh(); setNeedsRefresh(false); setError(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "处置刷新失败，请重试。"); }
    finally { setBusy(false); }
  }
  function dismiss(event: FormEvent) { event.preventDefault(); void save("Dismissed"); }

  return <section className="finding-disposition" aria-label="Finding 处置">
    <DispositionSummary status={finding.status} disposition={finding.disposition} />
    {canChange && <div className="disposition-actions">
      {finding.status !== "Resolved" && <button type="button" className="button secondary-button" disabled={busy || needsRefresh} onClick={() => void save("Resolved")}>采纳</button>}
      <button type="button" className="button secondary-button" disabled={busy || needsRefresh} aria-expanded={open} aria-controls={formId}
        onClick={() => {
          if (!open && !reasonCategory) {
            setReasonCategory(finding.disposition?.reasonCategory ?? "");
            setExplanation(finding.disposition?.explanation ?? "");
          }
          setOpen(!open);
        }}>{finding.status === "Dismissed" ? "修改驳回理由" : "驳回"}</button>
      {(finding.status === "Resolved" || finding.status === "Dismissed") && <button type="button" className="text-button" disabled={busy || needsRefresh} onClick={() => void save("Pending")}>改回待处理</button>}
      {busy && <span role="status">正在保存或刷新…</span>}
    </div>}
    {open && canChange && <form id={formId} className="disposition-form" onSubmit={dismiss}>
      <label htmlFor={`${formId}-reason`}>驳回理由类别</label>
      <select id={`${formId}-reason`} value={reasonCategory} required disabled={busy} onChange={(event) => setReasonCategory(event.target.value as DispositionReason | "")}>
        <option value="">请选择理由</option>
        {Object.entries(dispositionReasonLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label htmlFor={`${formId}-explanation`}>{reasonCategory === "other" ? "说明（必填）" : "补充说明（可选）"}</label>
      <textarea id={`${formId}-explanation`} rows={3} maxLength={4000} value={explanation} required={reasonCategory === "other"} disabled={busy}
        onChange={(event) => setExplanation(event.target.value)} />
      <div className="disposition-actions">
        <button className="button primary-button" type="submit" disabled={busy || needsRefresh || !reasonCategory || (reasonCategory === "other" && !explanation.trim())}>确认驳回</button>
        <button className="button secondary-button" type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      </div>
    </form>}
    {error && <p className="disposition-error" role="alert">{error}</p>}
    {needsRefresh && <button type="button" className="button secondary-button" disabled={busy} onClick={() => void refresh()}>刷新处置</button>}
  </section>;
}
