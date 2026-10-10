import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser, parseHTML } from "linkedom";
import { listReadings, referenceInDiff, regenerateReading } from "./reading-api";
import { highlightReadingLines, ReadingMarkdown } from "./reading-code";
import { createReadingHtml, safeDiagramImage } from "./reading-export";
import { readingTerms } from "./reading";

const excerpt = { path: "src/reserve.ts", startLine: 3, endLine: 5, excerpt: "export function reserve() {\n  return stock - 1;\n}" };
const content = {
  outline: [{ id: "summary", label: "概要", title: "释放库存改为按订单幂等" }, { id: "design", label: "方案与行为变化", title: "改动后释放前先查订单状态" }],
  sections: {
    summary: '<p>本轮把<ur-term name="幂等" def="同一操作执行多次结果相同">幂等</ur-term>检查放进释放入口。</p>',
    design: '<ur-code ref="src/reserve.ts#L3-L5"><ur-note line="4">库存减一</ur-note></ur-code><p>再次提到<ur-term name="幂等" def="重复的释义">幂等</ur-term>和<ur-term name="订单状态" def="订单当前所处阶段">订单状态</ur-term>。</p>',
  },
  excerpts: { "src/reserve.ts#L3-L5": excerpt },
};
const reading = {
  id: "reading-one", reviewId: "review-one", status: "completed", failureReason: null, content,
  metrics: { steps: 12, nudges: 0, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, durationMs: 60_000, accepted: 4, rejected: 1, warnings: 2,
    review: { issues: [], revisedSections: [], failed: null, durationMs: 3000 } },
  submissions: [{ tool: "write_section", outcome: "rejected", code: "unread_code", reason: "未读取", warnings: [] }],
  model: { provider: "fixture", model: "deepseek-chat", vendor: "deepseek" },
  createdAt: "2026-10-08T00:00:00Z", startedAt: "2026-10-08T00:00:00Z", completedAt: "2026-10-08T00:01:00Z",
};
function respond(body: unknown, status = 200) { vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status })); }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("解读接口", () => {
  it("读取本轮全部解读，生成中的解读没有内容", async () => {
    respond({ documents: [{ ...reading, id: "reading-two", status: "running", content: null, metrics: null }, reading] });
    const result = await listReadings("review-one");
    expect(result.documents.map((item) => item.status)).toEqual(["running", "completed"]);
    expect(result.documents[1]?.content?.excerpts["src/reserve.ts#L3-L5"]?.excerpt).toBe(excerpt.excerpt);
  });
  it.each([
    { ...reading, content: null },
    { ...reading, status: "done" },
    { ...reading, content: { ...content, excerpts: { bad: { ...excerpt, endLine: 1 } } } },
    { ...reading, submissions: [{ tool: "report_reading_summary", outcome: "accepted", code: null, reason: null, warnings: [] }] },
  ])("拒绝不完整的解读记录", async (invalid) => {
    respond({ documents: [invalid] });
    await expect(listReadings("review-one")).rejects.toThrow("数据不完整");
  });
  it("重新生成被拒绝时给出服务端原因", async () => {
    respond({ error: { code: "conflict", message: "这一轮已有解读正在生成，请等它完成" } }, 409);
    await expect(regenerateReading("review-one")).rejects.toThrow("这一轮已有解读正在生成");
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe("POST");
  });
  it("只有实际渲染的新侧 hunk 范围可以跳转", () => {
    const file = { oldPath: excerpt.path, newPath: excerpt.path, patch: "@@ -3,3 +3,3 @@\n old\n-old\n+new\n old", newFile: false, deletedFile: false, renamedFile: false };
    expect(referenceInDiff(excerpt, [file])).toBe(true);
    expect(referenceInDiff({ ...excerpt, startLine: 2 }, [file])).toBe(false);
    expect(referenceInDiff({ ...excerpt, path: "docs/architecture.md" }, [file])).toBe(false);
    expect(referenceInDiff(excerpt, [{ ...file, deletedFile: true }])).toBe(false);
  });
  it("术语表按首次出现汇总，同名术语只保留第一个释义", () => {
    expect(readingTerms(content)).toEqual([["幂等", "同一操作执行多次结果相同"], ["订单状态", "订单当前所处阶段"]]);
  });
});

describe("代码与 Markdown", () => {
  it("Markdown 保留段落与强调且不加载图片、HTML 或危险链接", () => {
    const html = renderToStaticMarkup(createElement(ReadingMarkdown, { children: '**库存**\n\n<script>alert(1)</script>\n\n![图片](https://tracking.invalid/image.png)\n\n[恶意](javascript:alert(1))\n\n[文档](https://example.com/docs)' }));
    expect(html).toContain("<strong>库存</strong>");
    expect(html).not.toMatch(/<script|<img|javascript:|tracking\.invalid/);
    expect(html).toContain('href="https://example.com/docs"');
  });
  it("跨行注释保持高亮且代码中的 HTML 被转义", () => {
    const lines = highlightReadingLines('/* 库存\n释放 */\nconst label = "<script>";', "src/reserve.ts");
    expect(lines[0]).toContain('class="hljs-comment"');
    expect(lines[1]).toContain('class="hljs-comment"');
    expect(lines.every((line) => (line.match(/<span/g)?.length ?? 0) === (line.match(/<\/span>/g)?.length ?? 0))).toBe(true);
    expect(lines.join("")).not.toContain("<script>");
    expect(lines[2]).toContain("&lt;script&gt;");
  });
});

describe("离线解读 HTML", () => {
  function environment() {
    const { document } = parseHTML("<!doctype html><html><body></body></html>");
    vi.stubGlobal("document", document); vi.stubGlobal("DOMParser", DOMParser);
    return document;
  }
  it("导出正文、摘录、术语与已绘制的图，去掉按钮、脚本和外部资源", () => {
    const document = environment();
    const root = document.createElement("div");
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 20"><text x="1" y="10">库存释放</text></svg>';
    root.innerHTML = `<article><section class="doc-section" id="doc-design"><h2 class="doc-title">改动后释放前先查订单状态</h2>
      <ur-code ref="src/reserve.ts#L3-L5"><div class="code-head"><span>src/reserve.ts:3–5</span><button class="code-link">在代码中查看 ↗</button></div><div class="code-body"><code>return stock - 1;</code><div class="code-note">库存减一</div></div></ur-code>
      <ur-compare><ur-before label="改动前">直接释放</ur-before><ur-after label="改动后">先查状态</ur-after></ur-compare>
      <svg viewBox="0 0 10 10"><path marker-end="url(#arrow)" d="M0 0L1 1"/></svg>
      <div class="diagram"><img alt="流程" src="${safeDiagramImage(svg)}"></div>
      <a href="https://example.com">外部来源</a><a href="#doc-design">本节</a><script>alert(1)</script><img src="https://tracking.invalid/a.png"><iframe src="https://example.com"></iframe>
    </section></article>`;
    root.querySelector("section")!.setAttribute("onclick", "alert(2)");
    const html = createReadingHtml({ title: "库存 <script>标题</script>", subtitle: "第 2 轮", outline: [{ id: "design", label: "方案与行为变化" }], body: root });
    const result = new DOMParser().parseFromString(html, "text/html");
    const text = result.querySelector("article")?.textContent ?? "";
    expect(text).toContain("return stock - 1;");
    expect(text).toContain("库存减一");
    expect(result.querySelector("ur-before")?.getAttribute("label")).toBe("改动前");
    expect(result.querySelector("path")?.getAttribute("marker-end")).toBe("url(#arrow)");
    expect(result.querySelector("style")?.textContent).toContain("ur-compare");
    expect(result.querySelector(".diagram img")?.getAttribute("src")).toContain("data:image/svg+xml;charset=utf-8,");
    expect(result.querySelectorAll("script,button,iframe,[onclick],img[src^=http],link")).toHaveLength(0);
    expect(result.querySelector('a[href^="https:"]')).toBeNull();
    expect(result.querySelector('nav a[href="#doc-design"]')?.textContent).toBe("方案与行为变化");
    expect(result.querySelector("title")?.textContent).toBe("库存 <script>标题</script> · 解读");
    expect(html).toContain("default-src 'none'");
  });
  it("图剔除脚本、事件、外部图像与样式资源，保留绘制结果", () => {
    environment();
    const image = safeDiagramImage('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><style>@import "https://external.invalid/font.css"; .node{fill:url(https://external.invalid/image)}</style><image href="https://external.invalid/a.png"/><foreignObject><div>外部内容</div></foreignObject><a href="https://external.invalid"><text>可读节点</text></a><path marker-end="url(#arrow)" d="M0 0L1 1"/></svg>');
    const svg = decodeURIComponent(image.slice("data:image/svg+xml;charset=utf-8,".length));
    expect(svg).not.toMatch(/<script|onload|https:|foreignObject|<image/);
    expect(svg).toContain("可读节点");
    expect(svg).toContain('marker-end="url(#arrow)"');
  });
});
