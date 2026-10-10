import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import DOMPurify from "dompurify";
import { ApiError } from "./api";
import { highlightReadingLines } from "./reading-code";
import { downloadReadingHtml, safeDiagramImage } from "./reading-export";
import { readingDocumentStyle } from "./reading-style";
import {
  listReadings, readingReviewKindLabels, readingStatusLabels, referenceInDiff, regenerateReading,
  type Reading, type ReadingContent, type ReadingExcerpt,
} from "./reading-api";
import type { CodeRange, FilePatch, ReviewStatus } from "./review-api";
import "./reading.css";

let renderer: Promise<typeof import("mermaid")["default"]> | undefined;
function loadRenderer() {
  return renderer ??= import("mermaid").then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", htmlLabels: false,
      suppressErrorRendering: true, maxTextSize: 50_000, flowchart: { useMaxWidth: false },
      secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "suppressErrorRendering", "maxEdges", "htmlLabels", "themeCSS", "themeVariables", "flowchart"],
    });
    return mermaid;
  });
}

const TEXT_TAGS = ["p", "br", "hr", "h3", "h4", "h5", "ul", "ol", "li", "strong", "em", "b", "i", "u", "s", "code", "pre", "kbd", "sub", "sup",
  "mark", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "details", "summary", "figure", "figcaption",
  "div", "span", "section", "dl", "dt", "dd", "small"];
const SVG_TAGS = ["svg", "g", "rect", "line", "path", "circle", "ellipse", "polygon", "polyline", "text", "tspan", "defs", "marker", "title", "desc"];
const COMPONENT_TAGS = ["ur-code", "ur-note", "ur-diagram", "ur-compare", "ur-before", "ur-after", "ur-source", "ur-term", "ur-callout"];
const COMPONENT_ATTRIBUTES = ["ref", "line", "source", "quote", "name", "def", "label", "tone", "title"];
const SVG_ATTRIBUTES = ["viewbox", "width", "height", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "transform",
  "text-anchor", "dominant-baseline", "font-size", "font-weight", "stroke-width", "stroke-dasharray", "marker-end", "marker-start",
  "refx", "refy", "markerwidth", "markerheight", "orient", "fill", "stroke", "opacity", "xmlns", "dx", "dy"];

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** 解读正文的白名单净化：去掉脚本、事件、样式属性与链接，只保留文本、受限 SVG 和 ur-* 组件。 */
export function sanitizeReadingHtml(html: string): string {
  if (!DOMPurify.isSupported) return escapeHtml(html);
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...TEXT_TAGS, ...SVG_TAGS, ...COMPONENT_TAGS],
    ALLOWED_ATTR: ["class", "colspan", "rowspan", "open", "id", ...COMPONENT_ATTRIBUTES, ...SVG_ATTRIBUTES],
    ADD_URI_SAFE_ATTR: COMPONENT_ATTRIBUTES,
    FORBID_ATTR: ["style"], ALLOW_DATA_ATTR: false,
    CUSTOM_ELEMENT_HANDLING: { tagNameCheck: /^ur-[a-z-]+$/, attributeNameCheck: new RegExp(`^(${COMPONENT_ATTRIBUTES.join("|")}|id)$`), allowCustomizedBuiltInElements: false },
  });
  // 图形属性里只允许引用文档内的标记，不允许 url() 指向外部。
  return clean.replace(/\s(fill|stroke|marker-end|marker-start)="url\((?!#)[^"]*\)"/gi, "");
}

function sourceLabel(id: string): string {
  if (id === "pull_request") return "PR 标题与描述";
  if (id.startsWith("commit:")) return `提交 ${id.slice(7, 15)}`;
  if (id.startsWith("issue:")) return "关联 issue";
  return id;
}

/** 文中 ur-term 的释义，按首次出现的顺序汇总成术语表。 */
export function readingTerms(content: ReadingContent): Array<[string, string]> {
  const found = new Map<string, string>();
  for (const entry of content.outline) {
    for (const match of (content.sections[entry.id] ?? "").matchAll(/<ur-term\b[^>]*>/gi)) {
      const name = /\bname\s*=\s*"([^"]*)"/i.exec(match[0])?.[1];
      const def = /\bdef\s*=\s*"([^"]*)"/i.exec(match[0])?.[1];
      if (name && def && !found.has(name)) found.set(name, def);
    }
  }
  return [...found];
}

/** 正文的静态 HTML：章节标题由宿主按提纲生成，模型提交的正文先净化。 */
export function readingBodyHtml(content: ReadingContent): string {
  const sections = content.outline.map((entry) => `<section class="doc-section" id="doc-${escapeHtml(entry.id)}" tabindex="-1">
    <p class="doc-kicker">${escapeHtml(entry.label)}</p><h2 class="doc-title">${escapeHtml(entry.title)}</h2>
    ${sanitizeReadingHtml(content.sections[entry.id] ?? "")}</section>`).join("");
  const terms = readingTerms(content);
  const glossary = terms.length ? `<section class="doc-section" id="doc-glossary" tabindex="-1"><p class="doc-kicker">术语表</p><h2 class="doc-title">文中用到的术语</h2><dl class="glossary">${
    terms.map(([name, def]) => `<dt>${escapeHtml(name)}</dt><dd>${escapeHtml(def)}</dd>`).join("")}</dl></section>` : "";
  return `<article>${sections}${glossary}</article>`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderCode(code: Element, excerpt: ReadingExcerpt | undefined, files: FilePatch[], onNavigate: (range: CodeRange, origin: HTMLElement) => void) {
  const notes = new Map<number, string[]>();
  for (const note of code.querySelectorAll("ur-note")) {
    const line = Number(note.getAttribute("line"));
    notes.set(line, [...(notes.get(line) ?? []), note.innerHTML]);
  }
  code.replaceChildren();
  if (!excerpt) { code.append(element("p", "muted", `未找到代码摘录：${code.getAttribute("ref") ?? ""}`)); return; }
  const head = element("div", "code-head");
  const label = element("span");
  if (code.getAttribute("title")) label.append(element("span", "code-title", `${code.getAttribute("title")} · `));
  label.append(element("span", "code-path", `${excerpt.path}:${excerpt.startLine}–${excerpt.endLine}`));
  head.append(label);
  if (referenceInDiff(excerpt, files)) {
    const button = element("button", "code-link", "在代码中查看 ↗");
    button.type = "button";
    button.addEventListener("click", () => onNavigate(excerpt, button));
    head.append(button);
  }
  const body = element("div", "code-body");
  highlightReadingLines(excerpt.excerpt, excerpt.path).forEach((line, index) => {
    const number = excerpt.startLine + index;
    const row = element("div", "code-line");
    row.append(element("span", "num", String(number)));
    const text = element("code");
    text.innerHTML = line || " ";
    row.append(text);
    for (const note of notes.get(number) ?? []) {
      const box = element("div", "code-note");
      box.innerHTML = note;
      row.append(box);
    }
    body.append(row);
  });
  code.append(head, body);
}

/** 把净化后的组件展开成摘录、引用和图；返回取消函数与全部图绘制结束的承诺。 */
function enhanceComponents(root: ParentNode, content: ReadingContent, files: FilePatch[], onNavigate: (range: CodeRange, origin: HTMLElement) => void) {
  let cancelled = false;
  for (const code of root.querySelectorAll("ur-code")) renderCode(code, content.excerpts[code.getAttribute("ref") ?? ""], files, onNavigate);
  for (const node of root.querySelectorAll("ur-source")) {
    node.prepend(element("div", "source-head", `引用 · ${sourceLabel(node.getAttribute("source") ?? "")}`),
      element("blockquote", "source-quote", node.getAttribute("quote") ?? ""));
  }
  for (const term of root.querySelectorAll("ur-term")) term.setAttribute("title", term.getAttribute("def") ?? "");
  // 没写宽度的 SVG 按 viewBox 的宽度显示，窄屏再按比例缩小，避免小图被拉到整栏宽。
  for (const svg of root.querySelectorAll("svg:not(svg svg)")) {
    const width = Number(svg.getAttribute("viewBox")?.trim().split(/[\s,]+/)[2]);
    if (!svg.getAttribute("width") && Number.isFinite(width) && width > 0) svg.setAttribute("width", String(width));
  }
  const drawn = [...root.querySelectorAll("ur-diagram")].map(async (diagram, index) => {
    const source = diagram.textContent ?? "";
    const title = diagram.getAttribute("title");
    const box = element("div", "diagram");
    box.append(element("p", "status", "正在绘制图…"));
    diagram.replaceChildren(box);
    try {
      const mermaid = await loadRenderer();
      const { svg } = await mermaid.render(`reading-diagram-${Date.now()}-${index}`, source);
      if (cancelled) return;
      const image = element("img");
      image.src = safeDiagramImage(svg);
      image.alt = title || "解读中的图";
      box.replaceChildren(image);
      if (title) box.append(element("p", "status", title));
    } catch {
      if (cancelled) return;
      const pre = element("pre");
      pre.textContent = source;
      box.replaceChildren(element("p", "status", "图无法绘制，以下是源码。"), pre);
    }
  });
  return { cancel: () => { cancelled = true; }, settled: Promise.all(drawn).then(() => undefined) };
}

interface DocumentProps {
  /** 已完成的解读内容不再变化，按 id 渲染，轮询返回的新对象不会触发重绘。 */
  id: string;
  content: ReadingContent;
  files: FilePatch[];
  heading: ReactNode;
  onNavigate: (range: CodeRange, origin: HTMLElement) => void;
  onRendered: (root: ShadowRoot | null) => void;
}

function ReadingDocument({ id, content, files, heading, onNavigate, onRendered }: DocumentProps) {
  const host = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(content.outline[0]?.id ?? "");
  const latest = useRef({ content, files, onNavigate, onRendered });
  latest.current = { content, files, onNavigate, onRendered };
  const terms = useMemo(() => readingTerms(content), [id]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const root = node.shadowRoot ?? node.attachShadow({ mode: "open" });
    const { content: current, files: currentFiles } = latest.current;
    root.innerHTML = `<style>${readingDocumentStyle}</style>${readingBodyHtml(current)}`;
    latest.current.onRendered(null);
    const enhanced = enhanceComponents(root, current, currentFiles, (range, origin) => latest.current.onNavigate(range, origin));
    void enhanced.settled.then(() => latest.current.onRendered(root));
    return enhanced.cancel;
  }, [id]);
  const entries = [...content.outline.map((entry) => ({ id: entry.id, label: entry.label })), ...(terms.length ? [{ id: "glossary", label: "术语表" }] : [])];
  return <div className="reading-layout">
    <nav className="reading-toc" aria-label="解读目录"><h2>本页目录</h2>
      {entries.map((entry) => <button key={entry.id} type="button" aria-current={active === entry.id ? "location" : undefined}
        onClick={() => {
          const target = host.current?.shadowRoot?.getElementById(`doc-${entry.id}`);
          target?.scrollIntoView({ block: "start", behavior: "instant" });
          target?.focus({ preventScroll: true });
          setActive(entry.id);
        }}>{entry.label}</button>)}
    </nav>
    <article className="reading-document">{heading}<div ref={host} className="reading-body" /></article>
  </div>;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

function GenerationRecord({ reading }: { reading: Reading }) {
  const metrics = reading.metrics;
  const rejected = reading.submissions.filter((submission) => submission.outcome === "rejected");
  const warned = reading.submissions.filter((submission) => submission.warnings.length);
  const review = metrics?.review;
  return <details className="panel review-trace reading-record"><summary>
    生成记录 · {reading.submissions.length} 次提交，{rejected.length} 次被拒{review && !review.failed ? ` · 审读意见 ${review.issues.length} 条` : ""}{metrics ? ` · ${metrics.steps} 步 · ${formatDuration(metrics.durationMs)}` : ""}
  </summary><div className="panel-body">
    {metrics && <p className="muted">输入 {metrics.inputTokens.toLocaleString()} token（缓存命中 {metrics.cacheReadTokens.toLocaleString()}），输出 {metrics.outputTokens.toLocaleString()} token；接受 {metrics.accepted} 次，拒绝 {metrics.rejected} 次，宿主修正提醒 {metrics.warnings} 条{metrics.nudges ? `，提醒继续 ${metrics.nudges} 次` : ""}。{reading.model ? ` 模型 ${reading.model.model}。` : ""}</p>}
    {review && <><h3>读者审读</h3>
      {review.failed ? <p className="muted">审读未完成：{review.failed}</p>
        : <p className="muted">审读提出 {review.issues.length} 条意见，用时 {formatDuration(review.durationMs)}；重写了 {review.revisedSections.length} 节{review.revisedSections.length ? `（${review.revisedSections.join("、")}）` : ""}。</p>}
      {review.issues.length > 0 && <ol>{review.issues.map((issue, index) => <li key={index}>
        <code>{issue.section}</code> · {readingReviewKindLabels[issue.kind] ?? issue.kind}：「{issue.quote}」{issue.problem} <span className="muted">建议：{issue.suggestion}</span>
      </li>)}</ol>}</>}
    {rejected.length > 0 && <><h3>被拒绝的提交</h3><ol>{rejected.map((submission, index) => <li key={index}><code>{submission.tool}</code> · {submission.code}：{submission.reason}</li>)}</ol></>}
    {warned.length > 0 && <><h3>宿主修正与提醒</h3><ul>{warned.flatMap((submission, index) => submission.warnings.map((warning, warningIndex) =>
      <li key={`${index}-${warningIndex}`}><code>{submission.tool}</code> · {warning}</li>))}</ul></>}
  </div></details>;
}

export interface ReadingPanelProps {
  reviewId: string;
  reviewStatus: ReviewStatus;
  title: string;
  round: number;
  files: FilePatch[];
  onNavigate: (range: CodeRange, origin: HTMLElement | null) => void;
  sessionAction: (failed: boolean) => ReactNode;
}

export function ReadingPanel({ reviewId, reviewStatus, title, round, files, onNavigate, sessionAction }: ReadingPanelProps) {
  const [readings, setReadings] = useState<Reading[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [rendered, setRendered] = useState<ShadowRoot | null>(null);
  const [exportMessage, setExportMessage] = useState("");
  const reviewActive = reviewStatus === "queued" || reviewStatus === "running";
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const tick = async () => {
      try {
        const next = (await listReadings(reviewId, controller.signal)).documents;
        if (controller.signal.aborted) return;
        setReadings(next); setError("");
        if (reviewActive || next.some((item) => item.status === "queued" || item.status === "running")) timer = window.setTimeout(() => void tick(), 3000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "解读加载失败。");
        if (!(cause instanceof ApiError && [401, 403, 404].includes(cause.status))) timer = window.setTimeout(() => void tick(), 5000);
      }
    };
    void tick();
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [reviewId, reviewActive, refresh]);
  const current = readings?.find((item) => item.id === selected) ?? readings?.find((item) => item.status === "completed") ?? readings?.[0];
  const generating = readings?.some((item) => item.status === "queued" || item.status === "running") ?? false;
  const regenerate = async () => {
    setRequesting(true); setError("");
    try { const result = await regenerateReading(reviewId); setSelected(result.document.id); setRefresh((value) => value + 1); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "重新生成的请求未完成，请重试。"); }
    finally { setRequesting(false); }
  };
  const exportDocument = () => {
    if (!rendered || !current?.content) return;
    try {
      downloadReadingHtml({ title, subtitle: `第 ${round} 轮 · 生成于 ${new Date(current.createdAt).toLocaleString("zh-CN")}`, body: rendered,
        outline: [...current.content.outline, ...(readingTerms(current.content).length ? [{ id: "glossary", label: "术语表" }] : [])] }, reviewId);
      setExportMessage("已导出 HTML，可离线阅读。");
    } catch { setExportMessage("导出失败，请重试。"); }
  };
  const canRegenerate = !reviewActive && !generating && !requesting;
  const regenerateButton = <button className="button secondary-button" type="button" disabled={!canRegenerate} onClick={() => void regenerate()}
    title={reviewActive ? "评审结束后才能重新生成" : undefined}>{generating ? "正在生成…" : readings?.length ? "重新生成" : "生成解读"}</button>;
  const accepted = current?.submissions.filter((item) => item.outcome === "accepted").length ?? 0;
  const rejectedCount = current?.submissions.filter((item) => item.outcome === "rejected").length ?? 0;
  return <section className="reading-page" aria-label="解读">
    <div className="reading-toolbar"><span className="muted">解读 · 第 {round} 轮</span><div>
      {sessionAction(current?.status === "failed")}
      {regenerateButton}
      {current?.status === "completed" && <button className="button secondary-button" type="button" disabled={!rendered} onClick={exportDocument}>导出 HTML</button>}
    </div></div>
    {error && <div className="reading-notice" role="alert"><p>{error}</p></div>}
    {exportMessage && <p className="reading-export-message" role="status">{exportMessage}</p>}
    {!readings && !error && <p className="muted" role="status">正在读取解读…</p>}
    {readings && readings.length === 0 && <div className="reading-empty panel">
      <h2>{reviewActive ? "解读将与评审结论同时生成" : "这一轮没有解读"}</h2>
      <p>{reviewActive ? "评审读取代码与需求来源后开始生成解读。" : "可以为这一轮生成解读，需要几分钟。PR 已有新提交时无法按这一轮的代码生成。"}</p>
    </div>}
    {readings && readings.length > 1 && <div className="reading-runs" role="tablist" aria-label="本轮的解读">
      {readings.map((item, index) => <button key={item.id} type="button" role="tab" aria-selected={item.id === current?.id}
        onClick={() => setSelected(item.id)}>第 {readings.length - index} 份 · {readingStatusLabels[item.status]} · {new Date(item.createdAt).toLocaleString("zh-CN")}</button>)}
    </div>}
    {current && current.status !== "completed" && <div className="reading-empty panel" role={current.status === "failed" ? undefined : "status"}>
      <h2>{current.status === "failed" ? "解读生成失败" : current.status === "queued" ? "等待生成解读" : "正在生成解读"}</h2>
      <p>{current.status === "failed" ? current.failureReason ?? "生成未完成。" : `已提交 ${accepted} 次，被拒 ${rejectedCount} 次。`}</p>
    </div>}
    {current?.status === "completed" && current.content && <ReadingDocument key={current.id} id={current.id} content={current.content} files={files}
      onNavigate={(range, origin) => onNavigate(range, origin)} onRendered={setRendered}
      heading={<header className="reading-document-heading"><p className="reading-kicker">解读</p><h2>{title}</h2>
        <p className="muted">第 {round} 轮 · 生成于 {new Date(current.createdAt).toLocaleString("zh-CN")}{current.model ? ` · ${current.model.model}` : ""}</p></header>} />}
    {current && (current.submissions.length > 0 || current.metrics) && <GenerationRecord reading={current} />}
  </section>;
}
