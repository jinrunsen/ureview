import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isExcludedPath } from "../reviews/exclusions.js";
import { REQUIRED_DOCUMENT_SECTIONS, STANDARD_DOCUMENT_SECTIONS, type DocumentExcerpt, type DocumentOutlineEntry,
  type ReadingDocumentContent, type ReadingDocumentInput, type ReadingDocumentSubmission } from "../reviews/reading-document.js";
import { ReportRejection, ReviewError, type ReadRange } from "../reviews/types.js";
import { COMPONENTS_WITH_BODY, COMPONENT_ATTRIBUTES, COMPONENT_TAGS, SVG_TAGS, TEXT_TAGS, closeCustomElements, compactText,
  copiedPhrases, decodeEntities, elementContents, formatCodeReference, mermaidError, parseCodeReference, scanTags } from "./reading-document-html.js";
import { workspacePath } from "./trace.js";

const SECTION_ID = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_SECTION_LENGTH = 30_000;
const MAX_EXCERPT_LINES = 60;

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ReportRejection("invalid_document", `${field} 必须是对象，请按工具字段重新提交。`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ReportRejection("invalid_document", `${field} 必须包含非空内容，请补齐后重新提交。`);
  return value.trim();
}

function parsedArray(value: unknown, field: string): unknown[] {
  // 部分模型会把数组参数序列化成字符串，能解析就照收。
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { /* 交给下面的类型检查 */ }
  }
  if (!Array.isArray(value)) throw new ReportRejection("invalid_document", `${field} 必须为数组，请修正后重新提交。`);
  return value;
}

interface Receipt { message: string; warnings: string[] }

/** 改前改后对比图：一张 SVG，或 ur-compare 两侧都放了图。 */
function hasComparisonFigure(html: string): boolean {
  if (/<svg\b/i.test(html)) return true;
  return elementContents(html, "ur-compare").some((compare) =>
    ["ur-before", "ur-after"].every((side) => elementContents(compare.content, side).some((part) => /<ur-diagram\b|<svg\b/i.test(part.content))));
}

/** 收集解读：提纲可重交，章节在结束前可重写；格式问题由宿主修正并在回执中说明。 */
export class ReadingDocumentReport {
  private outline: DocumentOutlineEntry[] | undefined;
  private readonly sections = new Map<string, string>();
  private readonly excerpts: Record<string, DocumentExcerpt> = {};
  private finished = false;
  private failure: ReviewError | undefined;
  private pending = Promise.resolve();
  private pendingSubmissions = Promise.resolve();
  accepted = 0;
  rejected = 0;
  warnings = 0;

  constructor(private readonly input: ReadingDocumentInput, private readonly reads: ReadRange[]) {}

  fail(error: ReviewError): void { this.failure ??= error; }
  assertHealthy(): void { if (this.failure) throw this.failure; }
  async settled(): Promise<void> { await this.pending; await this.pendingSubmissions; this.assertHealthy(); }

  get requiredSections(): string[] { return [...REQUIRED_DOCUMENT_SECTIONS]; }

  /** 记录调用参数校验阶段的拒绝；工具执行内的结果由 accept 记录。 */
  recordSchemaRejection(tool: ReadingDocumentSubmission["tool"], reason: string): void {
    this.rejected++;
    this.record({ tool, outcome: "rejected", code: "invalid_parameters", reason, warnings: [] });
  }

  submitOutline(value: unknown): Promise<string> {
    return this.accept("submit_outline", () => {
      this.assertOpen();
      const input = object(value, "参数");
      const entries = parsedArray(input.sections, "sections").map((raw, index) => {
        const entry = object(raw, `sections[${index}]`);
        const id = text(entry.id, `sections[${index}].id`);
        if (!SECTION_ID.test(id)) throw new ReportRejection("invalid_section_id", `章节 id「${id}」只能使用小写字母、数字和连字符，并以字母开头。`);
        return { id, label: text(entry.label, `sections[${index}].label`), title: text(entry.title, `sections[${index}].title`) };
      });
      const ids = entries.map((entry) => entry.id);
      if (new Set(ids).size !== ids.length) throw new ReportRejection("duplicate_section", "提纲中的章节 id 不能重复。");
      // 标准章节按固定顺序排列并使用固定短名；自定义章节跟在它前面的标准章节之后。
      let anchor = -1;
      const ordered = entries.map((entry, index) => {
        const standard = STANDARD_DOCUMENT_SECTIONS.findIndex((section) => section.id === entry.id);
        if (standard >= 0) anchor = standard;
        return { entry: standard >= 0 ? { ...entry, label: STANDARD_DOCUMENT_SECTIONS[standard]!.label } : entry,
          rank: standard >= 0 ? standard : anchor + 0.5, index };
      }).sort((a, b) => a.rank - b.rank || a.index - b.index).map((item) => item.entry);
      const missing = this.requiredSections.filter((id) => !ids.includes(id));
      if (missing.length) throw new ReportRejection("outline_incomplete", `提纲缺少必需章节：${missing.join("、")}。可以增加自定义章节，但必需章节不能省略。`);
      const warnings: string[] = [];
      for (const entry of ordered) {
        if ([...entry.label].length > 16) warnings.push(`章节 ${entry.id} 的 label 超过 16 字，目录中可能显示不全。`);
      }
      const corpus = this.input.requirementSources.map((source) => `${source.title}\n${source.description}`);
      for (const entry of ordered) {
        const phrases = copiedPhrases(entry.title, corpus);
        for (const phrase of phrases) this.copied.add(phrase);
        if (phrases.length) warnings.push(`章节 ${entry.id} 的标题照搬了需求来源里的「${phrases.join("」「")}」。PR 作者的说法要先翻译成白话再用。`);
      }
      const dropped = [...this.sections.keys()].filter((id) => !ids.includes(id));
      for (const id of dropped) { this.sections.delete(id); warnings.push(`已写的章节 ${id} 不在新提纲中，已删除。`); }
      this.outline = ordered;
      return { message: `提纲已记录，共 ${ordered.length} 节：${ordered.map((entry) => `${entry.id}（${entry.label}）`).join("、")}。标准章节的目录短名和顺序由宿主固定。接下来按这个顺序逐节调用 write_section。`, warnings };
    });
  }

  writeSection(value: unknown): Promise<string> {
    return this.accept("write_section", async () => {
      this.assertOpen();
      if (!this.outline) throw new ReportRejection("outline_missing", "请先调用 submit_outline 提交提纲，再逐节写正文。");
      const input = object(value, "参数");
      const id = text(input.id, "id");
      if (!this.outline.some((entry) => entry.id === id)) {
        throw new ReportRejection("unknown_section", `章节 ${id} 不在提纲中。可用的章节：${this.outline.map((entry) => entry.id).join("、")}；需要新章节时先重新提交提纲。`);
      }
      let html = text(input.html, "html");
      if (html.length > MAX_SECTION_LENGTH) {
        throw new ReportRejection("section_too_long", `章节正文 ${html.length} 字符，超过 ${MAX_SECTION_LENGTH}。请把这一节拆成多个章节：先用 submit_outline 增加章节，再分别写。`);
      }
      const warnings: string[] = [];
      html = await this.checkComponents(html, warnings);
      const replaced = this.sections.has(id);
      this.sections.set(id, html);
      if (this.revising) this.revisedSections.add(id);
      const remaining = this.outline.filter((entry) => !this.sections.has(entry.id)).map((entry) => entry.id);
      return { message: `章节 ${id} 已${replaced ? "覆盖" : "记录"}。${remaining.length ? `尚未写的章节：${remaining.join("、")}。` : "全部章节已写完，检查无误后调用 finish_document。"}`, warnings };
    });
  }

  finish(): Promise<string> {
    return this.accept("finish_document", () => {
      this.assertOpen();
      if (!this.outline) throw new ReportRejection("outline_missing", "请先提交提纲并写完各章节。");
      const missing = this.outline.filter((entry) => !this.sections.has(entry.id)).map((entry) => entry.id);
      if (missing.length) throw new ReportRejection("sections_missing", `以下章节还没有正文：${missing.join("、")}。`);
      const problems: string[] = [];
      if (!hasComparisonFigure(this.sections.get("design") ?? "")) {
        problems.push("design 一节没有改前与改后的对比图：用 <svg> 左右对照画出改动前后的行为，或在 <ur-compare> 的改前、改后两侧各放一张图。");
      }
      if (!/<ur-source\b/i.test(this.sections.get("background") ?? "")) problems.push("background 一节没有 <ur-source>：引用 PR 描述或提交信息的原文，说明这个 PR 要解决什么。");
      if (((this.sections.get("walkthrough") ?? "").match(/<ur-code\b/gi)?.length ?? 0) < 3) problems.push("walkthrough 一节少于 3 个 <ur-code>：代码导读要按阅读顺序引用关键代码。");
      if (problems.length) throw new ReportRejection("document_incomplete", `还不能结束：${problems.join(" ")}`);
      this.finished = true;
      return { message: "解读文档已完成。", warnings: [] };
    });
  }

  get isFinished(): boolean { return this.finished; }

  private revising = false;
  readonly revisedSections = new Set<string>();
  /** 标题里照搬需求来源的说法，交给审读人重点检查。 */
  readonly copied = new Set<string>();

  /** 审读后重新打开文档，记录修订期间重写过的章节。 */
  reopen(): void {
    this.finished = false;
    this.revising = true;
  }

  snapshot(): ReadingDocumentContent {
    if (!this.outline) throw new ReviewError("reading_document_incomplete", "文档还没有提纲");
    return { outline: this.outline,
      sections: Object.fromEntries(this.outline.map((entry) => [entry.id, this.sections.get(entry.id) ?? ""])), excerpts: { ...this.excerpts } };
  }

  /** 模型提前停下时，告诉它还缺什么。 */
  outstanding(): string {
    if (!this.outline) return "还没有提交提纲";
    const missing = this.outline.filter((entry) => !this.sections.has(entry.id)).map((entry) => entry.id);
    return missing.length ? `以下章节还没有正文：${missing.join("、")}` : "全部章节已写完，但还没有成功调用 finish_document";
  }

  complete(): ReadingDocumentContent {
    this.assertHealthy();
    if (!this.finished || !this.outline) throw new ReviewError("reading_document_incomplete", "模型结束时解读未完成，没有成功调用 finish_document");
    return { outline: this.outline,
      sections: Object.fromEntries(this.outline.map((entry) => [entry.id, this.sections.get(entry.id)!])), excerpts: { ...this.excerpts } };
  }

  private async checkComponents(source: string, warnings: string[]): Promise<string> {
    const closed = closeCustomElements(source);
    let html = closed.html;
    if (closed.fixed) warnings.push(`${closed.fixed} 个自闭合的 ur-* 组件已改为成对标签；HTML 中自定义元素必须写结束标签。`);
    const tags = scanTags(html);
    // 一次列出这一节的全部问题，避免模型逐个试错。
    const errors: Array<{ code: string; message: string }> = [];
    const reject = (code: string, message: string) => { errors.push({ code, message }); };
    const unknown = new Set<string>();
    const unsafe = new Set<string>();
    for (const tag of tags) {
      if (tag.closing) continue;
      if (tag.name === "h1" || tag.name === "h2") warnings.push(`<${tag.name}> 会被移除：章节标题由宿主按提纲生成，正文小标题从 <h3> 开始。`);
      else if (!TEXT_TAGS.has(tag.name) && !SVG_TAGS.has(tag.name) && !COMPONENT_TAGS.has(tag.name)) unknown.add(tag.name);
      for (const name of Object.keys(tag.attributes)) {
        if (name.startsWith("on") || name === "style" || name === "href" || name === "src" || name === "xlink:href") unsafe.add(name);
      }
      const allowed = COMPONENT_ATTRIBUTES[tag.name];
      if (allowed) {
        const extra = Object.keys(tag.attributes).filter((name) => name !== "class" && !allowed.includes(name));
        if (extra.length) reject("invalid_component_attribute", `<${tag.name}> 不支持属性 ${extra.join("、")}（允许：${allowed.join("、") || "无"}）。说明文字写在开始和结束标签之间，写进属性会在渲染时丢失。`);
      }
    }
    if (unknown.size) warnings.push(`以下标签不在白名单内，渲染时会被移除：${[...unknown].join("、")}。`);
    if (unsafe.size) warnings.push(`以下属性渲染时会被移除：${[...unsafe].join("、")}。版式请使用宿主提供的类名。`);
    for (const name of COMPONENT_TAGS) {
      const opened = tags.filter((tag) => tag.name === name && !tag.closing).length;
      const ended = tags.filter((tag) => tag.name === name && tag.closing).length;
      if (opened !== ended) reject("unbalanced_component", `<${name}> 有 ${opened} 个开始标签、${ended} 个结束标签，需要成对出现。`);
    }
    // 标签不成对时后面的成对匹配不可靠，先让模型补齐。
    if (errors.some((error) => error.code === "unbalanced_component")) throw this.combined(errors);
    for (const name of COMPONENTS_WITH_BODY) {
      for (const element of elementContents(html, name)) {
        if (!element.content.replace(/<[^>]*>/g, "").trim() && name !== "ur-code") reject("empty_component", `<${name}> 的开始和结束标签之间没有内容，说明文字要写在标签之间。`);
      }
    }

    const references = new Map<string, string>();
    for (const tag of tags.filter((item) => item.name === "ur-code" && !item.closing)) {
      const raw = tag.attributes.ref ?? "";
      if (references.has(raw)) continue;
      const parsed = parseCodeReference(raw);
      if (!parsed) { reject("invalid_code_reference", `<ur-code ref="${raw}"> 格式不对，应写成 ref="仓库相对路径#L起始行-L结束行"。`); continue; }
      let { startLine, endLine } = parsed;
      if (endLine - startLine + 1 > MAX_EXCERPT_LINES) {
        endLine = startLine + MAX_EXCERPT_LINES - 1;
        warnings.push(`${raw} 超过 ${MAX_EXCERPT_LINES} 行，已只保存第 ${startLine}–${endLine} 行。`);
      }
      try {
        const excerpt = await this.reference(parsed.path, startLine, endLine);
        const key = formatCodeReference(excerpt);
        this.excerpts[key] = excerpt;
        references.set(raw, key);
      } catch (error) {
        if (!(error instanceof ReportRejection)) throw error;
        reject(error.code, error.message);
      }
    }

    const sources = new Map(this.input.requirementSources.map((item) => [item.id, compactText(`${item.title}\n${item.description}`)]));
    const sourceFixes = new Map<number, string>();
    for (const tag of tags.filter((item) => !item.closing)) {
      if (tag.name === "ur-source") {
        const source = tag.attributes.source ?? "";
        const quote = tag.attributes.quote ?? "";
        const compact = compactText(quote);
        const owner = compact ? [...sources].find(([, value]) => value.includes(compact))?.[0] : undefined;
        if (owner && owner !== source) {
          // 原文出自另一条来源时直接改正来源 ID，不让模型为这类笔误重试。
          sourceFixes.set(tag.start, owner);
          warnings.push(`quote「${quote.slice(0, 30)}」出自来源 ${owner}，已把 source 从「${source}」改为它。`);
        } else if (!owner) {
          const original = this.input.requirementSources.find((item) => item.id === source);
          reject("quote_not_found", `<ur-source source="${source}" quote="${quote.slice(0, 40)}">：quote 在需求来源中找不到。quote 要从来源原文里复制一段连续文字，不能改写或概括。${original
            ? `来源 ${source} 的原文是：「${`${original.title}\n${original.description}`.trim().slice(0, 400)}」。` : `可用的来源 ID：${[...sources.keys()].join("、")}。`}`);
        }
      }
      if (tag.name === "ur-term" && (!tag.attributes.name || !tag.attributes.def)) warnings.push("<ur-term> 需要 name 与 def 两个属性，缺少时不会进入术语表。");
    }
    for (const [index, svg] of elementContents(html, "svg").entries()) {
      const shapes = (svg.content.match(/<[a-z][a-z0-9-]*/gi) ?? []).length;
      if (shapes > 400) reject("svg_too_large", `第 ${index + 1} 个 <svg> 有 ${shapes} 个元素，超过 400；请简化，或拆成几张图。`);
      if (!/\bviewbox\s*=/i.test(html.slice(svg.start, html.indexOf(">", svg.start)))) warnings.push(`第 ${index + 1} 个 <svg> 没有 viewBox，窄屏下不能按比例缩放。`);
    }
    for (const [index, diagram] of elementContents(html, "ur-diagram").entries()) {
      if (/<[a-zA-Z/]/.test(diagram.content)) { reject("invalid_diagram", `第 ${index + 1} 个 <ur-diagram> 的源码里有尖括号标签，会被当成 HTML 解析；源码中的 < 写成 &lt;。`); continue; }
      const text = decodeEntities(diagram.content).trim();
      if (!text) { reject("empty_diagram", `第 ${index + 1} 个 <ur-diagram> 里没有 Mermaid 源码。`); continue; }
      const problem = await mermaidError(text);
      if (problem) reject("invalid_diagram", `第 ${index + 1} 个 <ur-diagram> 无法解析，页面上会显示成源码：${problem}。图的标题写在 title 属性上，不要写进源码。`);
    }
    if (errors.length) throw this.combined(errors);
    for (const [start, owner] of [...sourceFixes].sort((a, b) => b[0] - a[0])) {
      const end = html.indexOf(">", start);
      html = html.slice(0, start) + html.slice(start, end).replace(/\bsource\s*=\s*(?:"[^"]*"|'[^']*')/i, `source="${owner}"`) + html.slice(end);
    }

    return html.replace(/<ur-code\b([^>]*)>([\s\S]*?)<\/ur-code>/gi, (element, attributes: string, content: string) => {
      const raw = /\bref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attributes);
      const original = raw ? (raw[1] ?? raw[2] ?? "") : "";
      const key = references.get(original.replace(/&amp;/g, "&"));
      if (!key) return element;
      const range = this.excerpts[key]!;
      const notes = content.replace(/<ur-note\b([^>]*)>([\s\S]*?)<\/ur-note>/gi, (note, noteAttributes: string) => {
        const line = Number(/\bline\s*=\s*["']?(\d+)/i.exec(noteAttributes)?.[1]);
        if (Number.isSafeInteger(line) && line >= range.startLine && line <= range.endLine) return note;
        warnings.push(`${key} 的逐行注释 line=${Number.isNaN(line) ? "?" : line} 不在引用范围内，已去掉。`);
        return "";
      });
      return `<ur-code${attributes.replace(/\bref\s*=\s*(?:"[^"]*"|'[^']*')/i, `ref="${key}"`)}>${notes}</ur-code>`;
    });
  }

  private combined(errors: Array<{ code: string; message: string }>): ReportRejection {
    const unique = [...new Map(errors.map((error) => [error.message, error])).values()];
    return new ReportRejection(unique[0]!.code, unique.length === 1 ? unique[0]!.message
      : `这一节有 ${unique.length} 处问题，请一并修正后重新提交：\n${unique.map((error, index) => `${index + 1}. ${error.message}`).join("\n")}`);
  }

  private async reference(path: string, startLine: number, endLine: number): Promise<DocumentExcerpt> {
    if (workspacePath(this.input.cwd, path) !== path || path.includes("\0")) {
      throw new ReportRejection("invalid_code_reference", `代码引用 ${path} 必须是仓库相对路径。`);
    }
    if (isExcludedPath(path, this.input.excludedDirectories ?? [])) throw new ReportRejection("excluded_reference", "不能引用已排除的代码。");
    let lines: string[];
    try {
      const root = await realpath(this.input.cwd);
      const target = await realpath(resolve(this.input.cwd, path));
      if (!workspacePath(root, target)) throw new ReportRejection("invalid_code_reference", "只能引用工作副本内的文件。");
      lines = (await readFile(target, "utf8")).split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
    } catch (error) {
      if (error instanceof ReportRejection) throw error;
      if (error instanceof Error && "code" in error && ["ENOENT", "ENOTDIR", "EISDIR"].includes(String(error.code))) {
        throw new ReportRejection("invalid_code_reference", `代码引用 ${path} 没有对应文件，请用 glob、read 核实。`);
      }
      throw new ReviewError("workspace_read_failed", "解读工作副本读取失败");
    }
    if (endLine > lines.length) throw new ReportRejection("invalid_code_reference", `${path} 只有 ${lines.length} 行，引用范围不存在。`);
    for (let line = startLine; line <= endLine; line++) {
      if (!this.reads.some((read) => read.path === path && read.startLine <= line && read.endLine >= line)) {
        throw new ReportRejection("unread_evidence", `引用了本会话尚未读取的代码 ${path}:${line}，请用 read 读取完整行号范围后重新提交。`);
      }
    }
    return { path, startLine, endLine, excerpt: lines.slice(startLine - 1, endLine).join("\n") };
  }

  private assertOpen(): void {
    if (this.finished) throw new ReportRejection("document_closed", "解读文档已结束，不能继续提交。");
  }

  private record(submission: ReadingDocumentSubmission): void {
    this.pendingSubmissions = this.pendingSubmissions.then(async () => {
      try { await this.input.onSubmission?.(submission); }
      catch { this.fail(new ReviewError("reading_document_submission_write_failed", "解读提交记录保存失败")); }
    });
  }

  private accept(tool: ReadingDocumentSubmission["tool"], execute: () => Receipt | Promise<Receipt>): Promise<string> {
    const work = this.pending.then(async () => {
      this.assertHealthy();
      try {
        const receipt = await execute();
        this.accepted++;
        this.warnings += receipt.warnings.length;
        this.record({ tool, outcome: "accepted", code: null, reason: null, warnings: receipt.warnings });
        return receipt.warnings.length ? `${receipt.message}\n宿主已做以下修正或提醒：\n- ${receipt.warnings.join("\n- ")}` : receipt.message;
      } catch (error) {
        if (error instanceof ReportRejection) {
          this.rejected++;
          this.record({ tool, outcome: "rejected", code: error.code, reason: error.message, warnings: [] });
          throw error;
        }
        this.failure ??= error instanceof ReviewError ? error : new ReviewError("reading_document_failed", "解读处理失败");
        throw this.failure;
      }
    });
    this.pending = work.then(() => {}, () => {});
    return work;
  }
}
