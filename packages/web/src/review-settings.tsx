import { useEffect, useRef, useState } from "react";
import { ApiError } from "./api";
import { useSession } from "./auth";
import { getReviewSettings, saveReviewSettings, type ReviewSettings } from "./review-settings-api";

function message(cause: unknown): string { return cause instanceof Error ? cause.message : "评审范围未能保存，请重试。"; }

function DirectoryList({ directories }: { directories: string[] }) {
  return directories.length > 0 ? <ul className="excluded-directory-list">{directories.map((directory) => <li key={directory}><code>{directory}</code></li>)}</ul> : <p className="muted">未配置排除目录。</p>;
}

export function ReviewScopeSettings({ repositoryId }: { repositoryId: string }) {
  const { user } = useSession();
  return <RepositoryReviewScopeForm key={`${user?.teamId}:${user?.userId}:${user?.role}:${repositoryId}`} repositoryId={repositoryId} editable={user?.role === "admin"} />;
}

function RepositoryReviewScopeForm({ repositoryId, editable }: { repositoryId: string; editable: boolean }) {
  const [settings, setSettings] = useState<ReviewSettings>();
  const [value, setValue] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<ReviewSettings>();
  const pending = useRef(false);
  const requests = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    requests.current = controller;
    setError("");
    void getReviewSettings(repositoryId, controller.signal).then((result) => {
      if (!controller.signal.aborted) { setSettings(result); setValue(result.excludedDirectories.join("\n")); }
    }).catch((cause: unknown) => { if (!controller.signal.aborted) setError(message(cause)); });
    return () => controller.abort();
  }, [repositoryId, attempt]);

  async function loadLatest() {
    const controller = requests.current;
    if (!controller || controller.signal.aborted) return;
    setBusy(true); setError("");
    try {
      const result = await getReviewSettings(repositoryId, controller.signal);
      if (!controller.signal.aborted) setLatest(result);
    }
    catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }

  async function save() {
    const controller = requests.current;
    if (!settings || !editable || conflict || pending.current || !controller || controller.signal.aborted) return;
    pending.current = true; setBusy(true); setSaved(false); setError("");
    try {
      const result = await saveReviewSettings(repositoryId, { version: settings.version, excludedDirectories: value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) }, controller.signal);
      if (controller.signal.aborted) return;
      setSettings(result); setValue(result.excludedDirectories.join("\n")); setSaved(true);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && cause.code === "review_settings_conflict") {
        setConflict(true); setLatest(undefined); await loadLatest();
      } else setError(message(cause));
    } finally { pending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }

  return <section className="review-scope-settings">
    <p>配置适用于当前仓库。目录中的文件不参与评审，也不会作为代码上下文读取。</p>
    {!settings && !error && <p role="status">正在加载评审范围…</p>}
    {settings && (editable ? <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label htmlFor="excluded-directories">排除的目录</label>
      <textarea id="excluded-directories" rows={7} value={value} disabled={busy} placeholder="features/steps" aria-describedby="excluded-directories-hint"
        onChange={(event) => { setValue(event.target.value); setSaved(false); }} />
      <p className="field-hint" id="excluded-directories-hint">每行一个相对仓库根目录的路径，包含其全部子目录。不支持通配符。最多 100 个目录，每个路径最多 512 个字符；留空可取消目录排除。</p>
      <p className="field-hint">保存后对新发起的评审和重新评审生效，已有评审保留原来的范围。</p>
      {conflict && <div className="feedback review-settings-conflict" role="alert"><strong>其他管理员已更新评审范围，你的输入已保留。</strong>
        <p>请核对当前已保存的目录，再决定是否保存你的输入。</p>
        {latest ? <><DirectoryList directories={latest.excludedDirectories} /><button type="button" className="button secondary-button" disabled={busy}
          onClick={() => { setSettings(latest); setLatest(undefined); setConflict(false); setError(""); }}>已核对，保留我的输入</button></>
          : <button type="button" className="button secondary-button" disabled={busy} onClick={() => void loadLatest()}>读取最新配置</button>}
      </div>}
      <div className="review-settings-actions"><button type="submit" className="button primary-button" disabled={busy || conflict}>{busy ? "正在保存…" : "保存评审范围"}</button></div>
    </form> : <><h3>排除的目录</h3><DirectoryList directories={settings.excludedDirectories} /><p className="field-hint">仅团队管理员可修改评审范围。配置变更对新发起的评审和重新评审生效。</p></>)}
    {error && <div className="feedback feedback-error" role="alert"><p>{error}</p>{!settings && <button type="button" className="button secondary-button" onClick={() => setAttempt((current) => current + 1)}>重新加载</button>}</div>}
    {saved && <p role="status">评审范围已保存。</p>}
  </section>;
}
