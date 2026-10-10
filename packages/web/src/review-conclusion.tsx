import { useEffect, useState } from "react";
import type { ReviewConclusion, ReviewDetail } from "./review-api";
import { repairMarkdown } from "./fix-prompts";
import { ReviewSessionButton } from "./agent-sessions";

const labels: Record<ReviewConclusion["status"], string> = {
  queued: "待评审", running: "评审进行中", failed: "评审失败",
  requires_changes: "建议修改", manual_judgment: "需要人工判断", no_major_findings: "未发现高中危问题",
};

export function ConclusionBar({ review, onFirstHigh }: { review: ReviewDetail; onFirstHigh: (button: HTMLButtonElement) => void }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const conclusion = review.conclusion;
  const active = review.status === "queued" || review.status === "running";
  const markdown = repairMarkdown(review.title, review.findings);
  useEffect(() => { setCopied(false); setCopyError(false); }, [markdown]);
  const hasPrompts = review.findings.some((finding) => finding.status !== "Dismissed");
  async function copy() {
    try { await navigator.clipboard.writeText(markdown); setCopied(true); setCopyError(false); }
    catch { setCopyError(true); }
  }
  return <section className={`review-conclusion conclusion-${conclusion.status}`} aria-label="评审结论">
    <div className="conclusion-body">
      <div className="conclusion-title"><span className="conclusion-dot" aria-hidden="true" /><h2>{labels[conclusion.status]}</h2>
        <span className="finding-count high">高危 {conclusion.findingCounts.high}</span><span className="finding-count medium">中危 {conclusion.findingCounts.medium}</span>
        <span className="conclusion-disposed">已处置 {conclusion.disposedCount} / {review.findings.length}</span></div>
      {active && <p role="status">{review.statusMessage || "正在读取代码并生成评审，状态会自动更新。"}</p>}
      {review.status === "failed" && <p role="alert">{review.failureReason || "本次评审未能完成。"}</p>}
      {review.status === "completed" && review.statusMessage && <p>{review.statusMessage}</p>}
    </div>
    <div className="conclusion-actions">
      {review.status === "failed" && <ReviewSessionButton review={review} failed full label="查看失败会话" />}
      {review.findings.some((finding) => finding.severity === "high" && finding.anchor && finding.status !== "Outdated") && <button className="button secondary-button" onClick={(event) => onFirstHigh(event.currentTarget)}>跳到第一条高危</button>}
      <button className="button secondary-button" disabled={!hasPrompts} onClick={() => void copy()}>{copied ? "已复制修复提示词" : "复制修复提示词"}</button>
      <span role="status" className="visually-hidden">{copied ? "修复提示词已复制为 Markdown" : ""}</span>
    </div>
    {copyError && <div role="alert" className="conclusion-copy-fallback"><p>剪贴板不可用，请从下方选中并复制。</p><textarea aria-label="修复提示词 Markdown" readOnly value={markdown} onFocus={(event) => event.currentTarget.select()} /></div>}
  </section>;
}
