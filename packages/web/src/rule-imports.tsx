import { RuleMetadataContext } from "./rule-hierarchy";
import { useCallback, useContext, useEffect, useState } from "react";
import { isRecord, request } from "./api";
import { ruleLayerLabels, type RuleLayer } from "./rule-metadata";
import { ruleCategoryLabels, ruleSeverityLabels } from "./managed-rules-api";
import type { LibraryEntry } from "./rule-library-api";
import { RuleExample } from "./rule-example";
interface ImportSummary { id: string; status: string; error: string | null; all_published: boolean }
interface ImportListItem extends ImportSummary { filenames: string[]; created_at: string }
type ImportEntry = Omit<LibraryEntry, "appliedRuleId" | "appliedVersion" | "hasUpdate">;
interface ImportSet { id: string; file_id: string; name: string; layer: RuleLayer; languages: string[]; published_at: string | null; entry_count: number }
interface ImportDetail extends ImportSummary {
  version: number;
  files: Array<{ id: string; name: string; plan: { skipped: Array<{ sectionId: string; reference?: string; reason: string }> } | null }>;
  sets: ImportSet[];
  chunks: Array<{ id: string; set_id: string | null; file_id: string; path: string; status: string; error: string | null; skipped: Array<{ reference: string; reason: string }> }>;
  progress: { ended: number; total: number };
}
const importLabel = (item: ImportSummary) => item.all_published ? "已全部发布" : labels[item.status];
const labels: Record<string, string> = { queued: "排队", planning: "规划中", generating: "生成中", ready: "待发布", partial_failed: "部分失败", failed: "失败" };
function isSummary(value: unknown): value is ImportSummary { return isRecord(value) && typeof value.id === "string" && typeof value.status === "string"; }
function isDetail(value: unknown): value is ImportDetail {
  return isSummary(value) && isRecord(value) && typeof value.version === "number" && Array.isArray(value.files) && Array.isArray(value.sets)
    && value.sets.every((set) => isRecord(set) && typeof set.id === "string" && typeof set.entry_count === "number") && Array.isArray(value.chunks) && isRecord(value.progress);
}
function ImportEntryView({ entry, onDelete, busy }: { entry: ImportEntry; onDelete?: () => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  return <details className="library-entry" onToggle={(event) => setOpen(event.currentTarget.open)}><summary>{entry.title} · {ruleSeverityLabels[entry.severity]} · 出处：{entry.source.reference}</summary>{open && <><p>{entry.originalName}</p><p>{entry.summary}</p><p className="rule-body">{entry.body}</p>
    <dl className="library-guidance"><div><dt>检查什么</dt><dd>{entry.check}</dd></div><div><dt>为什么</dt><dd>{entry.why}</dd></div><div><dt>怎么改</dt><dd>{entry.fix}</dd></div></dl>
    <p>{ruleCategoryLabels[entry.category]} · {ruleSeverityLabels[entry.severity]} · {entry.judgement ? "判断题" : "普通规范"}</p><p>出处：{entry.source.reference}</p>
    {onDelete && <button disabled={busy} onClick={onDelete}>删除条目</button>}
    <h4>正确示例</h4><RuleExample source={entry.goodExample} language={entry.exampleLanguage} /><h4>反例</h4><RuleExample source={entry.badExample} language={entry.exampleLanguage} />
  </>}</details>;
}
function ImportSetView({ set, importId, version, busy, editable, eligible, selected, onSelect, mutate }: {
  set: ImportSet; importId: string; version: number; busy: string[]; editable: boolean; eligible: boolean; selected: boolean; onSelect: (checked: boolean) => void;
  mutate: (path: string, method: "PUT" | "DELETE", data?: object) => Promise<boolean>;
}) {
  const metadata = useContext(RuleMetadataContext);
  const [draft, setDraft] = useState<{ name: string; layer: RuleLayer; languages: string[]; version: number } | null>(null);
  const [open, setOpen] = useState(false), [entries, setEntries] = useState<ImportEntry[] | null>(null), [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!open || entries?.length === set.entry_count) return;
    const controller = new AbortController(); setError("");
    void request(`/api/rule-library-imports/${importId}/sets/${set.id}/entries`, (value): value is { entries: ImportEntry[] } => isRecord(value) && Array.isArray(value.entries), { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setEntries(value.entries); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取条目失败"); });
    return () => controller.abort();
  }, [open, importId, set.id, set.entry_count, entries, reload]);
  const setBusy = busy.includes(`/sets/${set.id}`);
  const mutable = editable && !set.published_at;
  return <article className="library-card" aria-label={`预览 ${set.name}`}><h4>{set.name}</h4><p>{ruleLayerLabels[set.layer]} · {set.languages.join("、") || "全部语言"} · {set.entry_count} 条</p>
    {set.published_at ? <p>已发布</p> : mutable && <label><input type="checkbox" aria-label={`发布 ${set.name}`} checked={selected} disabled={setBusy || !eligible} onChange={(event) => onSelect(event.target.checked)} />选择发布</label>}
    {mutable && <div><button disabled={setBusy} onClick={() => setDraft({ name: set.name, layer: set.layer, languages: [...set.languages], version })}>编辑规范集</button><button disabled={setBusy} onClick={() => { if (window.confirm(`删除规范集「${set.name}」？`)) void mutate(`/sets/${set.id}`, "DELETE"); }}>删除规范集</button></div>}
    {draft && mutable && <form onSubmit={(event) => { event.preventDefault(); void mutate(`/sets/${set.id}`, "PUT", draft).then((saved) => { if (saved) setDraft(null); }); }}>
      <label>规范集名称<input value={draft.name} maxLength={80} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>层级<select value={draft.layer} onChange={(event) => setDraft({ ...draft, layer: event.target.value as RuleLayer })}>{metadata.layers.map((layer) => <option key={layer} value={layer}>{ruleLayerLabels[layer]}</option>)}</select></label>
      <fieldset><legend>适用语言（全部不选表示全部语言）</legend>{metadata.languages.map((language) => <label key={language.id}><input type="checkbox" checked={draft.languages.includes(language.id)} onChange={(event) => setDraft({ ...draft, languages: event.target.checked ? [...draft.languages, language.id] : draft.languages.filter((item) => item !== language.id) })} />{language.label}</label>)}</fieldset>
      <button type="submit" disabled={setBusy}>保存规范集</button><button type="button" onClick={() => setDraft(null)}>取消</button>
    </form>}
    {!eligible && !set.published_at && <p>{set.entry_count === 0 ? "没有条目，不能发布。" : "片段尚未全部完成。"}</p>}
    <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>查看条目</summary>{open && <>{error && <p role="alert">{error}<button onClick={() => setReload((value) => value + 1)}>重试</button></p>}{!entries && !error && <p role="status">正在读取条目…</p>}{entries?.map((entry) => <ImportEntryView key={entry.id} entry={entry} busy={busy.includes(`/entries/${entry.id}`)} {...(mutable ? { onDelete: () => { void mutate(`/entries/${entry.id}`, "DELETE").then((saved) => { if (saved) setEntries((current) => current?.filter((item) => item.id !== entry.id) ?? null); }); } } : {})} />)}</>}</details>
  </article>;
}
const active = (status: string) => ["queued", "planning", "generating"].includes(status);
const isList = (value: unknown): value is { imports: ImportListItem[] } => isRecord(value) && Array.isArray(value.imports) && value.imports.every((item) => isSummary(item) && isRecord(item) && Array.isArray(item.filenames) && item.filenames.every((name) => typeof name === "string") && typeof item.created_at === "string");

export function RuleImports({ onPublished }: { onPublished: () => void }) {
  const [open, setOpen] = useState(false), [files, setFiles] = useState<File[]>([]), [items, setItems] = useState<ImportListItem[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [error, setError] = useState(""), [uploading, setUploading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refreshList = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void request("/api/rule-library-imports", isList, { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setItems(result.imports); })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取导入失败"); });
    return () => controller.abort();
  }, [open, revision]);
  async function upload() {
    setUploading(true); setError("");
    try {
      const encoded = await Promise.all(files.map(async (file) => { const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return { name: file.name, content: btoa(binary) }; }));
      const result = await request("/api/rule-library-imports", (value): value is { id: string } => isRecord(value) && typeof value.id === "string", { method: "POST", body: JSON.stringify({ files: encoded }) });
      setCurrentId(result.id); refreshList();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "上传失败"); } finally { setUploading(false); }
  }
  return <section aria-label="企业规范导入" className="library-import"><button className="button secondary-button" onClick={() => setOpen(!open)}>导入规范</button>{open && <div>
    <label>规范文件<input type="file" multiple accept=".md,.markdown,.txt" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /></label>
    <p>支持 UTF-8 Markdown 和文本；每个文件最多 1 MB，一次最多 10 个，合计最多 5 MB。</p>
    <button className="button primary-button" disabled={uploading || !files.length} onClick={() => void upload()}>{uploading ? "正在上传…" : "上传文件"}</button>
    {error && <p role="alert" className="feedback feedback-error">{error}</p>}
    <ul>{items.map((item) => <li key={item.id}><button onClick={() => setCurrentId(item.id)}>{item.filenames.join("、")} · {new Date(item.created_at).toLocaleString("zh-CN")} · {importLabel(item)}</button></li>)}</ul>
    {currentId && <ImportPreview key={currentId} id={currentId} onStatusChanged={refreshList} onPublished={onPublished} onClose={() => setOpen(false)} />}
  </div>}</section>;
}

function ImportPreview({ id, onStatusChanged, onPublished, onClose }: { id: string; onStatusChanged: () => void; onPublished: () => void; onClose: () => void }) {
  const [detail, setDetail] = useState<ImportDetail | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [revision, setRevision] = useState(0);
  const accept = useCallback((result: ImportDetail) => {
    setDetail((previous) => previous && previous.version > result.version ? previous : result);
    setSelected((current) => current.filter((id) => result.sets.some((set) => set.id === id && !set.published_at && set.entry_count > 0)));
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: string | undefined;
    const refresh = async () => {
      try {
        const result = await request(`/api/rule-library-imports/${id}`, isDetail, { signal: controller.signal });
        if (controller.signal.aborted) return;
        accept(result);
        if (status !== result.status) { status = result.status; onStatusChanged(); }
        if (active(result.status)) timer = setTimeout(() => void refresh(), 3000);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "读取导入失败"); }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, revision, accept, onStatusChanged]);
  async function retry(chunkId?: string) {
    const key = chunkId ?? "retry"; setBusy((current) => [...current, key]); setError("");
    try {
      await request(`/api/rule-library-imports/${id}/retry`, (value): value is { id: string } => isRecord(value) && typeof value.id === "string", { method: "POST", body: JSON.stringify(chunkId ? { chunkId } : {}) });
      setRevision((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "重试失败"); } finally { setBusy((current) => current.filter((item) => item !== key)); }
  }
  async function mutate(path: string, method: "PUT" | "DELETE" | "POST", data: object = {}): Promise<boolean> {
    if (!detail || busy.includes(path)) return false;
    setBusy((current) => [...current, path]); setError("");
    try {
      const updated = await request(`/api/rule-library-imports/${id}${path}`, isDetail, { method, body: JSON.stringify({ version: detail.version, ...data }) });
      accept(updated);
      if (path === "/publish") { setNotice(`已发布 ${selected.length} 个规范集`); onPublished(); onStatusChanged(); }
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "修改导入失败"); return false; }
    finally { setBusy((current) => current.filter((item) => item !== path)); }
  }
  const eligible = (set: ImportSet) => set.entry_count > 0 && !set.published_at && !detail?.chunks.some((chunk) => chunk.set_id === set.id && !["completed", "skipped"].includes(chunk.status));
  const eligibleIds = detail?.sets.filter(eligible).map((set) => set.id) ?? [];
  return <div aria-label="导入预览">
    {error && <p role="alert">{error}<button onClick={() => setRevision((value) => value + 1)}>刷新导入</button></p>}
    {notice && <p role="status">{notice}<button onClick={onClose}>前往规范库</button></p>}
    {!detail ? <p role="status">正在读取导入…</p> : <>
      <p role="status">{importLabel(detail)} · 已结束 {detail.progress.ended} / {detail.progress.total} 个片段{detail.error && `：${detail.error}`}</p>
      {["failed", "partial_failed"].includes(detail.status) && <button disabled={busy.includes("retry")} onClick={() => void retry()}>重试全部失败工作</button>}
      {["ready", "partial_failed"].includes(detail.status) && <div>
        <label><input type="checkbox" checked={eligibleIds.length > 0 && eligibleIds.every((id) => selected.includes(id))} onChange={(event) => setSelected(event.target.checked ? eligibleIds : [])} />全选可发布规范集</label>
        <button className="button primary-button" disabled={busy.includes("/publish") || !selected.length} onClick={() => void mutate("/publish", "POST", { setIds: selected })}>{busy.includes("/publish") ? "正在发布…" : `发布所选规范集（${selected.length}）`}</button>
      </div>}
      {detail.files.map((file) => <section key={file.id} aria-label={file.name}><h3>{file.name}</h3>
        {detail.sets.filter((set) => set.file_id === file.id).map((set) => <ImportSetView key={set.id} set={set} importId={id} version={detail.version} busy={busy} editable={["ready", "partial_failed"].includes(detail.status)} eligible={eligible(set)} selected={selected.includes(set.id)} onSelect={(checked) => setSelected((current) => checked ? [...current, set.id] : current.filter((id) => id !== set.id))} mutate={mutate} />)}
        <SkippedItems file={file} chunks={detail.chunks.filter((chunk) => chunk.file_id === file.id)} />
        {detail.chunks.filter((chunk) => chunk.file_id === file.id && chunk.status === "failed").map((chunk) => <p key={chunk.id} role="alert">{chunk.path}：{chunk.error}<button disabled={busy.includes(chunk.id)} onClick={() => void retry(chunk.id)}>重试此片段</button></p>)}
      </section>)}
    </>}
  </div>;
}

function SkippedItems({ file, chunks }: { file: ImportDetail["files"][number]; chunks: ImportDetail["chunks"] }) {
  const [open, setOpen] = useState(false);
  const items = [...(file.plan?.skipped ?? []).map((item) => ({ reference: item.reference ?? file.name, reason: item.reason })),
    ...chunks.filter((chunk) => chunk.set_id !== null).flatMap((chunk) => chunk.skipped)];
  return items.length > 0 && <details onToggle={(event) => setOpen(event.currentTarget.open)}><summary>已跳过 {items.length} 项</summary>
    {open && items.map((item, index) => <p key={index}>已跳过 {item.reference}：{item.reason}</p>)}
  </details>;
}
