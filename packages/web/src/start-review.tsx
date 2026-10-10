import { useEffect, useRef, useState, type FormEvent } from "react";
import { requestIdentifier } from "./request-id";
import { startReview } from "./review-api";
import { useSession } from "./auth";
import { Icon } from "./icons";

function StartReviewForm({ submitting, onSubmittingChange }: { submitting: boolean; onSubmittingChange: (value: boolean) => void }) {
  const { user } = useSession();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const submission = useRef<{ url: string; requestId: string } | undefined>(undefined);
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) feedback.current?.focus(); }, [error]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    const trimmed = url.trim();
    if (!trimmed) return;
    if (submission.current?.url !== trimmed) submission.current = { url: trimmed, requestId: requestIdentifier() };
    pending.current = true;
    onSubmittingChange(true);
    setError("");
    try {
      const result = await startReview(submission.current.url, submission.current.requestId);
      window.location.assign(`/?review=${encodeURIComponent(result.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "评审未能发起，请重试。");
      pending.current = false;
      onSubmittingChange(false);
    }
  }

  return <section id="start-review" className="panel start-review-panel" aria-labelledby="start-review-heading">
    <div className="panel-heading"><h2 id="start-review-heading">发起评审</h2>
      <p>输入已接入仓库的 GitLab MR 链接，评审当前提交。</p></div>
    <form className="panel-body" onSubmit={(event) => void submit(event)} aria-busy={submitting}>
      <label htmlFor="pull-request-url">PR / MR 链接</label>
      <div className="start-review-controls">
        <input id="pull-request-url" name="url" type="url" required maxLength={4096}
          placeholder="https://gitlab.com/group/project/-/merge_requests/1"
          autoComplete="off" autoCapitalize="none" spellCheck={false} value={url} disabled={submitting}
          aria-describedby="start-review-hint" onChange={(event) => { setUrl(event.target.value); setError(""); }} />
        <button className="button primary-button" type="submit" disabled={submitting}>
          {submitting && <span className="spinner" aria-hidden="true" />}{submitting ? "正在提交…" : "开始评审"}
        </button>
      </div>
      <p id="start-review-hint" className="field-hint">{user?.role === "admin" ? <>首次使用该仓库，请先<a href="/?repositories=1&tab=connect">接入仓库</a>。</> : "首次使用该仓库，请联系团队管理员接入。"}提交后自动进入评审页面。</p>
      {submitting && <p role="status">正在读取 MR 信息并加入评审队列…</p>}
      {error && <div ref={feedback} className="feedback feedback-error" role="alert" tabIndex={-1}>
        <strong>评审未能发起</strong><p>{error}</p>
      </div>}
    </form>
  </section>;
}

export function StartReviewDialog({ onClose }: { onClose: () => void }) {
  const [submitting, setSubmitting] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      requestAnimationFrame(() => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); });
    };
  }, []);
  return <dialog ref={dialog} className="start-review-dialog" aria-labelledby="start-review-heading" onCancel={(event) => { event.preventDefault(); if (!submitting) onClose(); }} onClick={(event) => {
    if (submitting || event.target !== event.currentTarget) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
  }}>
    <button type="button" className="icon-button start-review-close" aria-label="关闭发起评审" disabled={submitting} onClick={onClose}><Icon name="close" /></button>
    <StartReviewForm submitting={submitting} onSubmittingChange={setSubmitting} />
  </dialog>;
}
