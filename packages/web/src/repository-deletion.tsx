import { useEffect, useState, type FormEvent } from "react";
import { ApiError, type RepositorySummary } from "./api";
import { deleteRepository, getRepositoryDeletionPreview, type RepositoryDeletionPreview } from "./repository-detail-api";

const message = (cause: unknown) => cause instanceof Error ? cause.message : "操作未完成，请重试。";
const deletionCounts: { key: keyof RepositoryDeletionPreview["counts"]; label: string }[] = [
  { key: "reviews", label: "评审轮次" },
  { key: "findings", label: "finding" },
  { key: "discussionComments", label: "讨论评论" },
  { key: "agentSessions", label: "Agent 会话" },
  { key: "webhookEvents", label: "Webhook 事件" },
  { key: "repositoryRules", label: "仓库规范与 lint" },
  { key: "historicalCandidates", label: "历史候选" },
];

export function RepositoryDeletion({ repository }: { repository: RepositorySummary }) {
  const [preview, setPreview] = useState<RepositoryDeletionPreview>();
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [previewError, setPreviewError] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setPreviewError(""); setError(""); setBlocked(false);
    void getRepositoryDeletionPreview(repository.id, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setPreview(result); })
      .catch((cause) => { if (!controller.signal.aborted) setPreviewError(message(cause)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [repository.id, attempt]);
  const canDelete = Boolean(preview && !loading && !previewError && !busy && !blocked && preview.runningReviews === 0 && path === preview.pathWithNamespace);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canDelete) return;
    setBusy(true); setError("");
    try {
      await deleteRepository(repository.id, path);
      window.location.assign("/?repositories=1");
    } catch (cause) {
      setError(message(cause));
      if (cause instanceof ApiError && cause.code === "repository_review_running") {
        setBlocked(true);
      }
      setBusy(false);
    }
  }
  return <section className="panel repository-deletion" aria-labelledby="repository-deletion-title">
    <div className="panel-heading"><h2 id="repository-deletion-title">删除仓库</h2><p>仓库及其关联数据将永久删除，无法恢复。</p></div>
    <div className="panel-body">
      <div className="repository-deletion-preview-heading"><h3>删除影响</h3><button type="button" className="button secondary-button" disabled={loading || busy} onClick={() => setAttempt((value) => value + 1)}>{loading ? "正在读取…" : "刷新影响预览"}</button></div>
      {loading && <p role="status">正在读取删除影响…</p>}
      {previewError && <p className="feedback feedback-error" role="alert">{previewError}</p>}
      {preview && <>
        <dl className="repository-deletion-counts">{deletionCounts.map(({ key, label }) => <div key={key}><dt>{label}</dt><dd>{preview.counts[key]}</dd></div>)}</dl>
        <p className="field-hint">{preview.counts.managedRules} 条工作台规范将移除该仓库的作用范围，规范本身保留。仓库凭据、排队中的评审及其他关联数据也将删除。</p>
        {preview.runningReviews > 0 && !error && <p className="feedback feedback-error" role="status">仓库有进行中的评审，请等待结束后刷新影响预览。</p>}
        <form className="repository-deletion-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="repository-deletion-path">输入仓库路径以确认删除</label>
          <p className="field-hint" id="repository-deletion-path-hint">请完整输入 <code>{preview.pathWithNamespace}</code>。</p>
          <input id="repository-deletion-path" name="pathWithNamespace" value={path} onChange={(event) => setPath(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="repository-deletion-path-hint" required />
          <button type="submit" className="button repository-delete-button" disabled={!canDelete}>{busy ? "正在删除…" : "确认删除仓库"}</button>
        </form>
      </>}
      {error && <p className="feedback feedback-error" role="alert">{error}</p>}
    </div>
  </section>;
}
