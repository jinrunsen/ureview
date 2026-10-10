/** 把解读正文的受限 HTML 转成纯文本，供待办与推送摘取第一句。 */
export function htmlText(html: string): string {
  return html.replace(/<ur-code\b[\s\S]*?<\/ur-code>/gi, " ").replace(/<ur-diagram\b[\s\S]*?<\/ur-diagram>/gi, " ")
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, " ").replace(/<[^>]*>/g, "")
    .replace(/&(lt|gt|quot|apos|amp|nbsp);/g, (_match, name: string) => ({ lt: "<", gt: ">", quot: "\"", apos: "'", amp: "&", nbsp: " " })[name] ?? "")
    .replace(/\s+/g, " ").trim();
}
