/**
 * 解读文档 HTML 的宿主侧检查。这里只做证据与协议的核对和格式修正；
 * 安全净化由浏览器端在渲染前统一完成。
 */

export interface ScannedTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  attributes: Record<string, string>;
  start: number;
  end: number;
}

const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
const ATTRIBUTE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower.startsWith("#x")) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " " }[lower] ?? "";
  });
}

export function scanTags(html: string): ScannedTag[] {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, (comment) => " ".repeat(comment.length));
  const tags: ScannedTag[] = [];
  for (const match of withoutComments.matchAll(TAG)) {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[3] ?? "").matchAll(ATTRIBUTE)) {
      const name = attribute[1]!.toLowerCase();
      attributes[name] = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    tags.push({ name: match[2]!.toLowerCase(), closing: match[1] === "/", selfClosing: match[4] === "/",
      attributes, start: match.index!, end: match.index! + match[0].length });
  }
  return tags;
}

/** HTML 中自定义元素不能自闭合；`<ur-code .../>` 会吞掉后面的内容，统一补成成对标签。 */
export function closeCustomElements(html: string): { html: string; fixed: number } {
  let fixed = 0;
  const result = html.replace(/<(ur-[a-z-]+)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/>/g, (_match, name: string, attributes: string) => {
    fixed++;
    return `<${name}${attributes}></${name}>`;
  });
  return { html: result, fixed };
}

export const COMPONENT_TAGS = new Set(["ur-code", "ur-note", "ur-diagram", "ur-compare", "ur-before", "ur-after",
  "ur-source", "ur-term", "ur-callout"]);
export const TEXT_TAGS = new Set(["p", "br", "hr", "h3", "h4", "h5", "ul", "ol", "li", "strong", "em", "b", "i", "u", "s",
  "code", "pre", "kbd", "sub", "sup", "mark", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption",
  "details", "summary", "figure", "figcaption", "div", "span", "section", "dl", "dt", "dd", "small"]);
export const SVG_TAGS = new Set(["svg", "g", "rect", "line", "path", "circle", "ellipse", "polygon", "polyline", "text", "tspan",
  "defs", "marker", "title", "desc"]);


export interface CodeReference { path: string; startLine: number; endLine: number; raw: string }

export function parseCodeReference(value: string): CodeReference | undefined {
  const match = /^(.+?)#L(\d+)(?:-L?(\d+))?$/.exec(value.trim());
  if (!match) return undefined;
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine) return undefined;
  return { path: match[1]!, startLine, endLine, raw: value };
}

export function formatCodeReference(reference: Pick<CodeReference, "path" | "startLine" | "endLine">): string {
  return `${reference.path}#L${reference.startLine}-L${reference.endLine}`;
}

/** 比较引用原文时忽略空白、引号和全半角标点差异。 */
export function compactText(value: string): string {
  return decodeEntities(value).normalize("NFKC").toLowerCase()
    .replace(/[\s"'`“”‘’「」『』《》〈〉()（）[\]【】,，.。;；:：!！?？、…—–-]+/g, "");
}

/** 去掉标签，得到元素内的纯文本。 */
export function textContent(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""));
}

/**
 * 找出文本中原样出现在需求来源里的连续片段（至少 6 个字，含至少 3 个汉字）。
 * 用来提醒模型不要照搬 PR 作者的缩写，代码标识符和路径不算。
 */
export function copiedPhrases(text: string, corpus: string[], minimum = 6): string[] {
  const found: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = start;
    while (end < text.length && corpus.some((source) => source.includes(text.slice(start, end + 1)))) end++;
    const phrase = text.slice(start, end).trim();
    if (end - start >= minimum && (phrase.match(/\p{Script=Han}/gu)?.length ?? 0) >= 3) {
      found.push(phrase);
      start = end;
    } else start++;
  }
  return [...new Set(found)];
}

/** 每个组件允许的属性；说明文字必须写在标签之间，写进其他属性会在渲染时丢失。 */
export const COMPONENT_ATTRIBUTES: Record<string, string[]> = {
  "ur-code": ["ref", "title"], "ur-note": ["line"], "ur-diagram": ["title"], "ur-compare": [], "ur-before": ["label"], "ur-after": ["label"],
  "ur-source": ["source", "quote"], "ur-term": ["name", "def"], "ur-callout": ["tone"],
};
/** 这些组件的正文就是说明本身，不能为空。 */
export const COMPONENTS_WITH_BODY = new Set(["ur-callout", "ur-before", "ur-after", "ur-term", "ur-note"]);

let mermaid: Promise<{ parse(text: string): Promise<unknown> }> | undefined;
/** 在服务端解析 Mermaid 源码，返回错误说明；解析通过返回 null。 */
export async function mermaidError(source: string): Promise<string | null> {
  mermaid ??= (async () => {
    // Mermaid 在解析时会注册 DOMPurify 钩子；服务端没有 DOM，只需要语法检查，补上空实现即可。
    const purify = (await import("dompurify")).default as unknown as Record<string, unknown>;
    for (const name of ["addHook", "removeHook", "removeHooks", "removeAllHooks"]) if (typeof purify[name] !== "function") purify[name] = () => {};
    if (typeof purify.sanitize !== "function") purify.sanitize = (value: string) => value;
    return (await import("mermaid")).default;
  })();
  try {
    await (await mermaid).parse(source);
    return null;
  } catch (error) {
    return (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 4).join("\n");
  }
}

export function elementContents(html: string, name: string): Array<{ attributes: Record<string, string>; content: string; start: number; end: number }> {
  const pattern = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)</${name}>`, "gi");
  return [...html.matchAll(pattern)].map((match) => {
    const attributes: Record<string, string> = {};
    for (const attribute of (match[1] ?? "").matchAll(ATTRIBUTE)) {
      attributes[attribute[1]!.toLowerCase()] = decodeEntities(attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    return { attributes, content: match[2]!, start: match.index!, end: match.index! + match[0].length };
  });
}
