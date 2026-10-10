import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReadingDocumentInput, ReadingDocumentSubmission } from "../reviews/reading-document.js";
import type { ReadRange } from "../reviews/types.js";
import { ReadingDocumentReport } from "./reading-document-report.js";
import { documentText } from "./reading-document-review.js";

let directory: string;
let input: ReadingDocumentInput;
let reads: ReadRange[];
let submissions: ReadingDocumentSubmission[];
const source = Array.from({ length: 90 }, (_, index) => `const value${index + 1} = ${index + 1};`).join("\n");
const outline = ["summary", "background", "scope", "design", "walkthrough"]
  .map((id) => ({ id, label: id, title: `${id} 一节说明了改动的事实。` }));
const comparison = `<svg viewBox="0 0 10 10"><rect class="c-ok" x="1" y="1" width="4" height="4"></rect><text>改前</text></svg>`;
const body = (id: string) => id === "background"
  ? `<p>入口原来接受任何金额。</p><ur-source source="pull_request" quote="拒绝负数金额"></ur-source>`
  : id === "walkthrough" ? `<ur-code ref="src/payment.ts#L1-L3"><ur-note line="2">第二项</ur-note></ur-code><ur-code ref="src/payment.ts#L4-L6"></ur-code><ur-code ref="src/payment.ts#L7-L9"></ur-code>`
  : id === "design" ? `<ur-diagram>flowchart TD\n  A["入口"] --&gt; B["校验"]</ur-diagram>${comparison}` : `<p>${id}</p>`;

function create(): ReadingDocumentReport {
  return new ReadingDocumentReport(input, reads);
}

async function writeAll(report: ReadingDocumentReport, html: (id: string) => string): Promise<void> {
  await report.submitOutline({ sections: outline });
  for (const entry of outline) await report.writeSection({ id: entry.id, html: html(entry.id) });
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ureview-reading-document-"));
  const cwd = join(directory, "repo");
  await mkdir(join(cwd, "src"), { recursive: true });
  await writeFile(join(cwd, "src/payment.ts"), source);
  submissions = [];
  input = { reviewId: "fixture-document", cwd,
    pullRequest: { iid: 7, title: "金额边界", description: "拒绝负数金额", author: "fixture",
      webUrl: "https://gitlab.example.test/payments/-/merge_requests/7", sourceBranch: "fix/payment", targetBranch: "main",
      headSha: "a".repeat(40), baseSha: "b".repeat(40), startSha: "b".repeat(40) },
    files: [], architectureCandidates: [],
    requirementSources: [{ id: "pull_request", kind: "pull_request", title: "fix: 金额边界", description: "拒绝负数金额，但是零元订单仍然放行。", url: null },
      { id: "commit:1", kind: "commit", title: "补齐校验", description: "补齐负数校验", url: null }],
    onSubmission: async (submission) => { submissions.push(submission); },
  };
  reads = [{ path: "src/payment.ts", startLine: 1, endLine: 80, phase: "reading", tool: "read" }];
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

describe("解读：写作协议", () => {
  it("标准章节使用固定短名并按固定顺序排列，自定义章节跟在前一个标准章节之后", async () => {
    const report = create();
    const ids = ["summary", "background", "scope", "design", "walkthrough", "deploy", "interfaces", "tests"];
    await report.submitOutline({ sections: ids.map((id) => ({ id, label: id === "deploy" ? "部署" : "走读", title: `${id} 一节说明了改动的事实。` })) });
    for (const id of ids) await report.writeSection({ id, html: body(id) });
    await report.finish();
    await report.settled();
    expect(report.complete().outline.map((entry) => `${entry.id}:${entry.label}`)).toEqual([
      "summary:概要", "background:背景", "scope:改动范围", "design:方案与行为变化", "interfaces:接口与数据变化", "tests:测试",
      "walkthrough:代码导读", "deploy:部署",
    ]);
  });

  it("提纲、章节、代码摘录与原文引用完整保存", async () => {
    const report = create();
    await writeAll(report, body);
    await report.finish();
    await report.settled();
    const content = report.complete();
    expect(content.outline.map((entry) => entry.id)).toEqual(outline.map((entry) => entry.id));
    expect(content.excerpts["src/payment.ts#L1-L3"]).toEqual({ path: "src/payment.ts", startLine: 1, endLine: 3,
      excerpt: source.split("\n").slice(0, 3).join("\n") });
    expect(submissions.filter((item) => item.outcome === "accepted")).toHaveLength(outline.length + 2);
  });

  it("提纲缺必需章节时拒绝", async () => {
    const report = create();
    await expect(report.submitOutline({ sections: outline.filter((entry) => entry.id !== "scope") })).rejects.toMatchObject({ code: "outline_incomplete" });
  });

  it("引用未读代码或改写需求原文时拒绝；不再接受需求结论与 finding 表态组件", async () => {
    const report = create();
    await report.submitOutline({ sections: outline });
    await expect(report.writeSection({ id: "design", html: `<ur-code ref="src/payment.ts#L81-L85"></ur-code>` })).rejects.toMatchObject({ code: "unread_evidence" });
    await expect(report.writeSection({ id: "background", html: `<ur-source source="pull_request" quote="拒绝所有非法金额"></ur-source>` }))
      .rejects.toThrow(/原文是：「fix: 金额边界/);
    const receipt = await report.writeSection({ id: "summary", html: `<ur-claim source="pull_request" verdict="match">x</ur-claim><ur-finding id="f-1">x</ur-finding>` });
    expect(receipt).toMatch(/ur-claim、ur-finding/);
    expect(report.rejected).toBe(2);
  });

  it("原文出自另一条来源时宿主改正来源 ID", async () => {
    const report = create();
    await report.submitOutline({ sections: outline });
    const receipt = await report.writeSection({ id: "background", html: `<ur-source source="pull_request" quote="补齐负数校验"></ur-source>` });
    expect(receipt).toContain("已把 source");
    expect(report.snapshot().sections.background).toContain(`source="commit:1"`);
  });

  it("格式问题由宿主修正：自闭合组件补成对、超长引用截到 60 行、越界注释去掉", async () => {
    const report = create();
    await report.submitOutline({ sections: outline });
    const receipt = await report.writeSection({ id: "walkthrough",
      html: `<ur-code ref="src/payment.ts#L1-L70"><ur-note line="75">越界</ur-note><ur-note line="5">保留</ur-note></ur-code><ur-code ref="src/payment.ts#L4-L5"/><p onclick="x()">完</p>` });
    expect(receipt).toContain("已只保存第 1–60 行");
    expect(receipt).toContain("自闭合");
    expect(receipt).toContain("onclick");
  });

  it("一节中的多处问题一次列出：属性写错、正文为空、图无法解析", async () => {
    const report = create();
    await report.submitOutline({ sections: outline });
    const rejected = report.writeSection({ id: "design", html: `<ur-source source="pull_request" quote="拒绝负数金额" verdict="match"></ur-source>
      <ur-callout tone="note"></ur-callout><ur-diagram>title: 流程\nflowchart TD\n  A["入口" --&gt; B</ur-diagram>` });
    await expect(rejected).rejects.toMatchObject({ code: "invalid_component_attribute" });
    await expect(rejected).rejects.toThrow(/3 处问题/);
  });

  it("结束前检查背景的原文引用、设计的改前改后对比图和代码导读", async () => {
    const report = create();
    await writeAll(report, (id) => id === "design" ? `<ur-diagram>flowchart TD\n  A --&gt; B</ur-diagram>` : `<p>${id}</p>`);
    const finished = report.finish();
    await expect(finished).rejects.toThrow(/background 一节没有 <ur-source>/);
    await expect(finished).rejects.toThrow(/改前与改后的对比图/);
    await expect(finished).rejects.toThrow(/walkthrough 一节少于 3 个/);
    await report.writeSection({ id: "design", html: `<ur-compare><ur-before label="改前"><ur-diagram>flowchart TD\n  A --&gt; B</ur-diagram></ur-before><ur-after label="改后"><ur-diagram>flowchart TD\n  A --&gt; C</ur-diagram></ur-after></ur-compare>` });
    await report.writeSection({ id: "background", html: body("background") });
    await report.writeSection({ id: "walkthrough", html: body("walkthrough") });
    await report.finish();
  });

  it("标题照搬需求来源的说法时在回执里提醒，并交给审读", async () => {
    const report = create();
    const receipt = await report.submitOutline({ sections: outline.map((entry) => entry.id === "summary"
      ? { ...entry, title: "改动拒绝负数金额，但是零元订单仍然放行" } : entry) });
    expect(receipt).toContain("照搬了需求来源里的「拒绝负数金额，但是零元订单仍然放行」");
    expect([...report.copied]).toEqual(["拒绝负数金额，但是零元订单仍然放行"]);
    const plain = create();
    await expect(plain.submitOutline({ sections: outline.map((entry) => entry.id === "summary"
      ? { ...entry, title: "扣款入口在执行前校验金额为正数" } : entry) })).resolves.not.toContain("照搬");
  });

  it("审读后重新打开文档，记录修订的章节，结束检查照常生效", async () => {
    const report = create();
    await writeAll(report, body);
    await report.finish();
    report.reopen();
    await report.writeSection({ id: "summary", html: "<p>改写后的概要。</p>" });
    await report.finish();
    expect([...report.revisedSections]).toEqual(["summary"]);
    expect(report.complete().sections.summary).toBe("<p>改写后的概要。</p>");
  });
});

describe("审读用的纯文本", () => {
  it("展开原文引用、代码摘录、术语与 SVG 文字", async () => {
    const report = create();
    await report.submitOutline({ sections: outline });
    await report.writeSection({ id: "background", html: `<ur-source source="pull_request" quote="拒绝负数金额"></ur-source><p><ur-term name="零元" def="金额为 0 的订单">零元</ur-term>仍放行。</p><ur-code ref="src/payment.ts#L1-L2"><ur-note line="2">第二行</ur-note></ur-code><svg viewBox="0 0 9 9"><text>改前</text><text>改后</text></svg>` });
    const text = documentText(report.snapshot());
    expect(text).toContain("［引用 pull_request 原文「拒绝负数金额」］");
    expect(text).toContain("零元（术语定义：金额为 0 的订单）");
    expect(text).toContain("1 | const value1 = 1;");
    expect(text).toContain("注（第 2 行）：第二行");
    expect(text).toContain("［SVG 图，图中文字依次为：改前 / 改后］");
  });
});
