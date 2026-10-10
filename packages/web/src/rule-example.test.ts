import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuleExample } from "./rule-example";

describe("规范代码示例", () => {
  it.each(["c", "java", "go", "javascript", "typescript"])("按 %s 高亮并转义示例中的 HTML", (language) => {
    const html = renderToStaticMarkup(createElement(RuleExample, { language, source: 'return "<script>alert(1)</script>";' }));
    expect(html).toContain('class="hljs-keyword"');
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("未知语言保留代码文本和换行", () => {
    const html = renderToStaticMarkup(createElement(RuleExample, { language: "design", source: "caller -> port\n<script>" }));
    expect(html).toContain("caller -&gt; port\n&lt;script&gt;");
  });
});
