import { readingDocumentStyle } from "./reading-style";

const pageStyle = `:root { --surface: #fff; --surface-subtle: #f1f5f3; --foreground: #253a36; --muted: #6e817b; --border: #e2eae6; --accent: #28816f; --accent-soft: #e8f3ee; }
* { box-sizing: border-box; }
body { margin: 0; padding: 40px 24px; color: var(--foreground); background: #f6f8f7; font: 14px/1.8 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
.export-page { display: grid; grid-template-columns: 172px minmax(0, 1fr); gap: 28px; max-width: 1080px; margin: auto; align-items: start; }
.export-toc { position: sticky; top: 24px; display: flex; flex-direction: column; gap: 2px; font-size: 12px; }
.export-toc a { padding: 6px 10px; border-radius: 6px; color: var(--muted); text-decoration: none; }
.export-toc a:hover { background: var(--accent-soft); color: var(--accent); }
.export-document { min-width: 0; padding: 32px 40px 40px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
.export-heading { padding-bottom: 18px; border-bottom: 1px solid var(--border); }
.export-heading p { margin: 0; color: var(--muted); font-size: 12px; }
.export-heading h1 { margin: 6px 0; font-size: 23px; line-height: 1.45; }
@media (max-width: 760px) { .export-page { display: block; } .export-toc { position: static; flex-direction: row; flex-wrap: wrap; margin-bottom: 14px; } .export-document { padding: 22px 16px; } }`;
const removedNodes = "script,style,iframe,object,embed,link,meta,form,input,textarea,select,foreignObject,image,button";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function safeDiagramImage(svg: string): string {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.documentElement.localName !== "svg") throw new Error("流程图格式无效");
  document.querySelectorAll("script,foreignObject,image,iframe,object,embed").forEach((node) => node.remove());
  for (const node of document.querySelectorAll("*")) {
    for (const attribute of [...node.attributes]) {
      if (/^on/i.test(attribute.name) || ((attribute.name === "href" || attribute.name === "xlink:href") && !attribute.value.startsWith("#"))
        || (/url\(/i.test(attribute.value) && !/^url\(\s*['"]?#[-\w]+['"]?\s*\)$/.test(attribute.value))) node.removeAttribute(attribute.name);
    }
    if (node.tagName === "style") node.textContent = (node.textContent ?? "").replace(/@import[^;]+;/gi, "").replace(/url\([^)]*\)/gi, "none");
  }
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(document.documentElement.outerHTML)}`;
}

export interface ReadingExport {
  title: string;
  subtitle: string;
  outline: Array<{ id: string; label: string }>;
  /** 已绘制完成的正文：摘录已展开，Mermaid 图已转为内嵌图片。 */
  body: ParentNode;
}

/** 单个 HTML 文件：正文、宿主样式、代码摘录和已绘制的图，不含脚本，不请求网络资源。 */
export function createReadingHtml({ title, subtitle, outline, body }: ReadingExport): string {
  const article = body.querySelector("article");
  if (!article) throw new Error("解读尚未渲染");
  const copy = article.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(removedNodes).forEach((node) => node.remove());
  for (const node of [copy, ...copy.querySelectorAll("*")]) {
    for (const attribute of [...node.attributes]) {
      const embeddedImage = node.tagName === "IMG" && attribute.name === "src" && attribute.value.startsWith("data:image/svg+xml;charset=utf-8,");
      if (/^on/i.test(attribute.name) || attribute.name === "style" || (["src", "href", "xlink:href"].includes(attribute.name) && !embeddedImage
        && !attribute.value.startsWith("#"))) node.removeAttribute(attribute.name);
    }
    if (node.tagName === "IMG") {
      const source = node.getAttribute("src");
      if (!source) node.remove();
      else {
        try { node.setAttribute("src", safeDiagramImage(decodeURIComponent(source.slice("data:image/svg+xml;charset=utf-8,".length)))); }
        catch { node.remove(); }
      }
    }
  }
  const toc = outline.map((entry) => `<a href="#doc-${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</a>`).join("");
  const style = readingDocumentStyle.replace(":host", ".export-body");
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(title)} · 解读</title><style>${pageStyle}\n${style}</style></head><body><div class="export-page"><nav class="export-toc" aria-label="解读目录">${toc}</nav><main class="export-document"><header class="export-heading"><p>解读</p><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></header><div class="export-body">${copy.outerHTML}</div></main></div></body></html>`;
}

export function downloadReadingHtml(input: ReadingExport, reviewId: string): void {
  const url = URL.createObjectURL(new Blob([createReadingHtml(input)], { type: "text/html;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url; link.download = `ureview-reading-${reviewId.replace(/[^a-zA-Z0-9_-]/g, "-")}.html`;
  document.body.append(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
