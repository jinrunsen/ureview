import Markdown from "react-markdown";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

for (const [name, language] of Object.entries({ bash, c, cpp, css, go, java, javascript, json, python, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}
const languages: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", rs: "rust", sh: "bash", bash: "bash", yml: "yaml", h: "c", hpp: "cpp", cc: "cpp", html: "xml", svg: "xml",
};

export function safeReadingUrl(value: string): string | undefined {
  if (value.startsWith("#")) return value;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}

export function ReadingMarkdown({ children }: { children: string }) {
  return <div className="reading-markdown"><Markdown skipHtml components={{
    img: ({ alt }) => <span>{alt ?? ""}</span>,
    a: ({ href, children: text }) => safeReadingUrl(href ?? "")
      ? <a href={safeReadingUrl(href ?? "")} target={href?.startsWith("#") ? undefined : "_blank"} rel="noreferrer">{text}</a> : <span>{text}</span>,
  }}>{children}</Markdown></div>;
}

export function highlightReadingLines(source: string, path: string): string[] {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const language = languages[extension] ?? extension;
  const highlighted = hljs.getLanguage(language) ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  const open: string[] = [];
  // 多行 token 的 span 在每一行闭合并重开，保留跨行注释的高亮。
  return highlighted.split("\n").map((line) => {
    const prefix = open.join("");
    for (const match of line.matchAll(/<span\b[^>]*>|<\/span>/g)) {
      if (match[0] === "</span>") open.pop(); else open.push(match[0]);
    }
    return `${prefix}${line}${"</span>".repeat(open.length)}`;
  });
}
