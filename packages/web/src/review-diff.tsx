import { Component, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import "@git-diff-view/react/styles/diff-view.css";
import { anchorInPatch, patchForDiff } from "./diff-location";
import { findingStatusLabels } from "./finding-disposition";
import { diffLineContent, findingCountsByPath, findingTarget, groupDiffFiles, placedInPatch, type DiffLineContent } from "./review-diff-data";
import type { CodeRange, CodeTarget, FilePatch, ReviewDetail, ReviewFinding } from "./review-api";
import "./review-diff.css";

const severityLabels = { high: "高危", medium: "中危" } as const;

function formatLines(range: CodeRange) {
  return `${range.startLine}${range.endLine === range.startLine ? "" : `–${range.endLine}`}`;
}

function sameRange(left: CodeRange, right: CodeRange) {
  return left.path === right.path && left.startLine === right.startLine && left.endLine === right.endLine;
}

interface FindingCard { finding: ReviewFinding; number: number; expanded: boolean; onToggle: () => void; body: ReactNode }

function InlineFinding({ card }: { card: FindingCard }) {
  const { finding } = card;
  return <article id={`finding-${finding.id}`} className={`code-inline-finding${card.expanded ? " expanded" : ""}`} data-severity={finding.severity}
    aria-label={`问题 ${card.number}：${finding.title}`}>
    <button type="button" className="code-inline-heading" aria-expanded={card.expanded} onClick={card.onToggle}>
      <span className="finding-number">{String(card.number).padStart(2, "0")}</span>
      <span className="severity-badge">{severityLabels[finding.severity]}</span>
      <span className="code-inline-title">{finding.title}</span>
      <span className="code-inline-lines">第 {formatLines(findingTarget(finding))} 行</span>
      <span className={`code-inline-status disposition-${finding.status.toLowerCase()}`}>{findingStatusLabels[finding.status]}</span>
    </button>
    <div className="code-inline-body" hidden={!card.expanded}>{card.body}</div>
  </article>;
}

function CodeExcerpt({ code, startLine }: { code: string; startLine: number }) {
  return <pre className="code-block code-excerpt"><code>{code.split("\n").map((line, index) =>
    <span key={index} className="code-excerpt-line"><span className="code-excerpt-number" aria-hidden="true">{startLine + index}</span>{line}{"\n"}</span>)}</code></pre>;
}

function ReturnButton({ onReturn }: { onReturn?: () => void }) {
  return onReturn ? <button type="button" className="text-button" onClick={onReturn}>← 返回刚才阅读的位置</button> : null;
}

function useLocatedFocus<T extends HTMLElement>(target: CodeRange): RefObject<T | null> {
  const element = useRef<T>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      element.current?.scrollIntoView({ block: "center", behavior: "instant" });
      element.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);
  return element;
}

function LocatedLine({ location, onReturn }: { location: CodeRange; onReturn?: () => void }) {
  const element = useLocatedFocus<HTMLDivElement>(location);
  return <div ref={element} tabIndex={-1} className="code-location-marker" data-code-path={location.path} data-code-line={location.startLine}>
    已定位到 <code>{location.path}:{formatLines(location)}</code> <ReturnButton onReturn={onReturn} />
  </div>;
}

/** 定位目标不在本轮差异片段内：显示评审时读取的代码，没有保存代码的旧评审才给平台链接。 */
function TargetExcerpt({ target, onReturn }: { target: CodeTarget; onReturn?: () => void }) {
  const element = useLocatedFocus<HTMLElement>(target);
  return <section ref={element} tabIndex={-1} className="panel outside-diff code-target-excerpt" aria-label="定位的代码"
    data-code-path={target.path} data-code-line={target.startLine}>
    <div className="panel-body">
      <p role="status">{target.code === undefined ? "该位置不在本轮差异片段内，本轮评审没有保存这段代码。" : "该位置不在本轮差异片段内，以下为评审时读取的代码。"}</p>
      <p><code>{target.path}:{formatLines(target)}</code></p>
      {target.code !== undefined ? <CodeExcerpt code={target.code} startLine={target.startLine} />
        : target.url && <p><a href={target.url} target="_blank" rel="noreferrer">在 GitLab 查看 ↗</a></p>}
      <ReturnButton onReturn={onReturn} />
    </div>
  </section>;
}

class DiffBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function FileDiff({ file, findings, location, cardFor, onReturn }: {
  file: FilePatch; findings: ReviewFinding[]; location: CodeRange | null;
  cardFor: (finding: ReviewFinding) => FindingCard; onReturn?: () => void;
}) {
  const data = useMemo(() => ({ oldFile: { fileName: file.oldPath }, newFile: { fileName: file.newPath }, hunks: [patchForDiff(file)] }),
    [file.oldPath, file.newPath, file.patch, file.newFile, file.deletedFile, file.renamedFile]);
  const extendData = useMemo(() => diffLineContent(file, findings, location), [file, findings, location]);
  const content = (item: DiffLineContent) => <>
    {item.location && <LocatedLine location={item.location} onReturn={onReturn} />}
    {item.findings.map((finding) => <InlineFinding key={finding.id} card={cardFor(finding)} />)}
  </>;
  return <DiffBoundary fallback={<div className="panel-body"><p role="status">差异暂时无法排版，以下为平台原始差异。</p>
    <pre className="code-block"><code>{file.patch}</code></pre>
    {Object.entries(extendData.newFile).map(([line, { data: item }]) => <div key={line}>
      <p className="code-location"><code>{file.newPath}:{line}</code></p>{content(item)}
    </div>)}
  </div>}>
    <DiffView<DiffLineContent> data={data} extendData={extendData} diffViewMode={DiffModeEnum.Unified}
      diffViewHighlight diffViewWrap diffViewTheme="light" diffViewFontSize={13}
      renderExtendLine={({ data: item }) => <div className="code-line-content">{content(item)}</div>} />
  </DiffBoundary>;
}

function FilePathLine({ value, className }: { value: string; className?: string }) {
  const tailLength = Math.min(8, Math.floor(value.length / 2));
  return <code className={`code-file-path ${className ?? ""}`}><span>{value.slice(0, value.length - tailLength)}</span><span>{value.slice(value.length - tailLength)}</span></code>;
}

function FileTreeLabel({ path }: { path: string }) {
  const separator = path.lastIndexOf("/");
  return <><FilePathLine value={path.slice(separator + 1)} /><FilePathLine className="code-file-directory" value={separator < 0 ? "." : path.slice(0, separator)} /></>;
}

function FileTreeButton({ path, current, count, theme, onSelect }: {
  path: string; current: boolean; count?: { count: number; high: boolean }; theme?: string; onSelect: () => void;
}) {
  return <button type="button" aria-current={current ? "true" : undefined} onClick={onSelect} title={path}
    aria-label={count ? `${path}，${count.count} 个问题` : path}>
    <FileTreeLabel path={path} />{theme && <span>{theme}</span>}
    {count && <b className={`code-file-findings${count.high ? " high" : ""}`} aria-hidden="true">{count.count}</b>}
  </button>;
}

/**
 * 代码与问题的代码画布。finding 卡片挂在它所指代码的末行之后，同一时间展开一条；
 * focus 每递增一次表示一次主动选中，画布切到对应文件并滚到卡片。
 */
export default function ReviewDiff({ review, findingId, location, focus, onSelectFinding, renderFinding, onReturn }: {
  review: ReviewDetail; findingId: string | null; location?: CodeTarget | null; focus: number;
  onSelectFinding: (id: string) => void; renderFinding: (finding: ReviewFinding) => ReactNode; onReturn?: () => void;
}) {
  const selected = review.findings.find((item) => item.id === findingId);
  const selectedRange = selected ? findingTarget(selected) : null;
  const findingLocation = useMemo<CodeRange | null>(() => selectedRange
    ? { path: selectedRange.path, startLine: selectedRange.startLine, endLine: selectedRange.endLine } : null,
  [selected?.id, selectedRange?.path, selectedRange?.startLine, selectedRange?.endLine]);
  const target = location ?? findingLocation;
  const [path, setPath] = useState(target?.path ?? review.files[0]?.newPath ?? "");
  useEffect(() => { if (target) setPath(target.path); }, [target]);
  const [collapsedId, setCollapsedId] = useState<string | null>(null);
  useEffect(() => { setCollapsedId(null); }, [focus]);
  const [onlyFindings, setOnlyFindings] = useState(false);

  const counts = useMemo(() => findingCountsByPath(review.findings), [review.findings]);
  const groups = useMemo(() => groupDiffFiles(review.files, review.fileGroups), [review.files, review.fileGroups]);
  const visibleGroups = onlyFindings
    ? groups.map((group) => ({ ...group, files: group.files.filter(({ file }) => counts.has(file.newPath)) })).filter((group) => group.files.length > 0)
    : groups;
  const outsidePaths = [...counts.keys()].filter((item) => !review.files.some((file) => file.newPath === item));
  const file = review.files.find((item) => item.newPath === path);
  const pathFindings = useMemo(() => review.findings.filter((item) => findingTarget(item).path === path), [review.findings, path]);
  const placed = useMemo(() => pathFindings.filter((item) => placedInPatch(file, item)), [pathFindings, file]);
  const unplaced = pathFindings.filter((item) => !placedInPatch(file, item));
  const excerpt = location && location.path === path && !(file && anchorInPatch(file, location))
    && !unplaced.some((item) => sameRange(item.location, location)) ? location : null;

  // 差异组件会复制行扩展数据，按 id 取回最新的 finding。
  const cardFor = (placedFinding: ReviewFinding): FindingCard => {
    const index = review.findings.findIndex((item) => item.id === placedFinding.id);
    const finding = review.findings[index] ?? placedFinding;
    const expanded = finding.id === findingId && collapsedId !== finding.id;
    return { finding, number: index + 1, expanded, body: renderFinding(finding), onToggle: () => {
      if (expanded) setCollapsedId(finding.id);
      else { setCollapsedId(null); onSelectFinding(finding.id); }
    } };
  };

  // 选中后等卡片渲染出来再滚动：差异由组件异步排版，切换文件后卡片要晚几帧才出现。
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!focus || handledFocus.current === focus || location || !findingId) return;
    let frame = 0;
    let attempts = 0;
    const scroll = () => {
      const card = document.getElementById(`finding-${findingId}`);
      if (!card) { if (++attempts < 60) frame = requestAnimationFrame(scroll); return; }
      handledFocus.current = focus;
      const block = card.closest<HTMLElement>(".outside-diff") ?? card;
      const offset = block === card ? window.innerHeight * 0.4 : 96;
      window.scrollTo({ top: window.scrollY + block.getBoundingClientRect().top - offset, behavior: "instant" });
      card.querySelector<HTMLElement>(".code-inline-heading")?.focus({ preventScroll: true });
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [focus, findingId, path, location]);

  return <section className="review-code-canvas" aria-label="变更代码">
    <div className="code-canvas-toolbar"><span className="muted">本轮差异 · {review.files.length} 个文件</span></div>
    <div className="code-canvas-layout">
      <nav className="code-file-tree panel" aria-label="变更文件">
        <div className="code-file-tree-heading"><h2>变更文件 <span className="count">{review.files.length}</span></h2>
          {counts.size > 0 && <label><input type="checkbox" checked={onlyFindings} onChange={(event) => setOnlyFindings(event.target.checked)} />只看有问题的文件</label>}</div>
        {visibleGroups.map((group, index) => <details className="code-file-group" key={`${index}:${group.name}`} open>
          <summary>{group.name}<span className="count">{group.files.length}</span></summary>
          {group.files.map(({ file: item, theme }) => <FileTreeButton key={item.newPath} path={item.newPath} current={item.newPath === path}
            count={counts.get(item.newPath)} theme={theme} onSelect={() => setPath(item.newPath)} />)}
        </details>)}
        {outsidePaths.length > 0 && <details className="code-file-group" open>
          <summary>差异以外的问题位置<span className="count">{outsidePaths.length}</span></summary>
          {outsidePaths.map((item) => <FileTreeButton key={item} path={item} current={item === path} count={counts.get(item)} onSelect={() => setPath(item)} />)}
        </details>}
        {groups.length === 0 && outsidePaths.length === 0 && <p className="muted code-tree-empty">本轮没有变更文件。</p>}
      </nav>
      <div className="code-diff-body">
        <header className="code-file-heading"><h2><code>{path || "变更代码"}</code></h2>
          {file?.renamedFile && <p className="muted">原路径：<code>{file.oldPath}</code></p>}
          {path && !file && <p className="muted">该文件不在本轮差异中。</p>}</header>
        {excerpt && <TargetExcerpt target={excerpt} onReturn={onReturn} />}
        {unplaced.map((finding) => <section className="panel outside-diff" key={finding.id}>
          <div className="panel-body"><p role="status">{finding.status === "Outdated" ? "该问题已过时，不再挂在代码行上。以下为评审时读取的代码。"
            : "该位置不在本轮差异片段内，以下为评审时读取的代码。"}</p>
            <p><code>{finding.location.path}:{formatLines(finding.location)}</code></p>
            <CodeExcerpt code={finding.code} startLine={finding.location.startLine} />
            <InlineFinding card={cardFor(finding)} /></div>
        </section>)}
        {file ? <div className="panel diff-panel"><FileDiff key={`${review.id}:${path}`} file={file} findings={placed}
          location={location ?? null} cardFor={cardFor} onReturn={onReturn} /></div>
          : unplaced.length === 0 && !excerpt && <p className="muted">本轮没有可展示的差异片段。</p>}
      </div>
    </div>
  </section>;
}
