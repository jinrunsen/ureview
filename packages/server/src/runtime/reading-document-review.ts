import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import { createUserMessage, HarnessError } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { READING_REVIEW_KINDS, type ReadingDocumentContent, type ReadingDocumentInput, type ReadingReviewIssue } from "../reviews/reading-document.js";
import { ReportRejection, ReviewError } from "../reviews/types.js";
import type { ReviewModel } from "./config.js";
import { READING_REVIEW_PRESET } from "./profile.js";
import { decodeEntities, elementContents } from "./reading-document-html.js";
import { captureSession, type SessionRecorder } from "./session-capture.js";
import { AgentTrace } from "./trace.js";

const REVIEW_STEP_LIMIT = 6;
const MAX_ISSUES = 25;
const kindLabels: Record<ReadingReviewIssue["kind"], string> = {
  jargon: "照抄缩写或内部说法，没有先翻译成白话（标题、正文和图里的文字都查）",
  undefined_term: "术语第一次出现时没有解释",
  title: "章节标题不是有主语的完整句子，只看标题不知道这一节讲了什么",
  inaccurate: "说法与随附的代码摘录或需求原文不符",
  order: "先讲细节后讲整体，或跳步，读者跟不上",
  figure: "图看不懂，或没有画出改前改后的行为差异",
  judgment: "越界做了评价：指出问题、风险、建议，或判断需求是否达成。解读只讲实现，这些交给评审结论",
  other: "其他妨碍理解的问题",
};
const attribute = (tag: string, name: string) => decodeEntities(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(tag)?.[1] ?? "");

/** 把文档转成审读人能读的纯文本：组件展开成带标记的文字，代码附上宿主保存的摘录。 */
export function documentText(content: ReadingDocumentContent): string {
  const render = (source: string) => {
    let html = source.replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
    html = html.replace(/<ur-code\b([^>]*)>([\s\S]*?)<\/ur-code>/gi, (_element, attributes: string, inner: string) => {
      const ref = attribute(attributes, "ref");
      const excerpt = content.excerpts[ref];
      const notes = elementContents(inner, "ur-note").map((note) => `  注（第 ${note.attributes.line} 行）：${decodeEntities(note.content.replace(/<[^>]*>/g, ""))}`);
      const lines = excerpt ? excerpt.excerpt.split("\n").map((line, index) => `${excerpt.startLine + index} | ${line}`) : ["（没有找到摘录）"];
      return `\n［代码 ${ref}${attribute(attributes, "title") ? `：${attribute(attributes, "title")}` : ""}］\n${lines.join("\n")}\n${notes.join("\n")}\n［代码结束］\n`;
    });
    html = html.replace(/<ur-diagram\b([^>]*)>([\s\S]*?)<\/ur-diagram>/gi, (_element, attributes: string, inner: string) =>
      `\n［Mermaid 图${attribute(attributes, "title") ? `：${attribute(attributes, "title")}` : ""}］\n${decodeEntities(inner).trim()}\n［图结束］\n`);
    html = html.replace(/<svg\b[\s\S]*?<\/svg>/gi, (svg) => {
      const texts = [...svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)].map((match) => decodeEntities(match[1]!.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim()).filter(Boolean);
      return `\n［SVG 图，图中文字依次为：${texts.join(" / ") || "（无文字）"}］\n`;
    });
    html = html.replace(/<ur-source\b([^>]*)>/gi, (_tag, attributes: string) =>
      `\n［引用 ${attribute(attributes, "source")} 原文「${attribute(attributes, "quote")}」］\n`).replace(/<\/ur-source>/gi, "");
    html = html.replace(/<ur-term\b([^>]*)>([\s\S]*?)<\/ur-term>/gi, (_element, attributes: string, inner: string) =>
      `${inner}（术语定义：${attribute(attributes, "def")}）`);
    html = html.replace(/<ur-before\b([^>]*)>/gi, (_tag, attributes: string) => `\n［改前${attribute(attributes, "label") ? `：${attribute(attributes, "label")}` : ""}］\n`)
      .replace(/<ur-after\b([^>]*)>/gi, (_tag, attributes: string) => `\n［改后${attribute(attributes, "label") ? `：${attribute(attributes, "label")}` : ""}］\n`);
    html = html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|h3|h4|h5|tr|div|pre|blockquote|dd|dt)>/gi, "\n").replace(/<(td|th)\b[^>]*>/gi, " | ");
    return decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  };
  return content.outline.map((entry) => `## [${entry.id}] ${entry.label}｜${entry.title}\n\n${render(content.sections[entry.id] ?? "")}`).join("\n\n");
}

export interface ReadingReviewResult { issues: ReadingReviewIssue[]; durationMs: number }

/** 用 Grader 的模型槽位扮演目标读者审读文档，只提意见，不改文档。 */
export async function runReadingReview(ctx: Context, input: ReadingDocumentInput, content: ReadingDocumentContent, model: ReviewModel,
  copied: string[], recorder?: SessionRecorder): Promise<ReadingReviewResult> {
  const started = Date.now();
  const trace = new AgentTrace(input.cwd, "grader", model);
  const ids = new Set(content.outline.map((entry) => entry.id));
  let issues: ReadingReviewIssue[] | undefined;
  const sessionId = SessionId(`ureview-reading-review-${input.reviewId}-${randomUUID()}`);
  const recording = await captureSession(ctx, recorder, { dshSessionId: sessionId, kind: "review_grader",
    reviewId: input.reviewId, provider: model.provider, model: model.model });
  let handle: AgentHandle | undefined;
  let failure: unknown;
  try {
    handle = await ctx.agents.create({ sessionId, meta: { cwd: input.cwd, agentPreset: READING_REVIEW_PRESET },
      agentOptions: { provider: model.provider, model: model.model },
      setup: async (agentCtx, agent) => {
        await ctx.agentPresets.mount(agentCtx, READING_REVIEW_PRESET);
        // 审读人扮演只读文档的读者：不给读代码的工具，文档里已附宿主保存的代码摘录。
        agentCtx.tools.restrict({ allow: [] });
        agentCtx.on("session/event", (_session, event) => trace.observe(agentCtx, agent, event));
        agentCtx.tools.register(defineTool({
          name: "submit_review", description: `提交审读意见，只提交一次，最多 ${MAX_ISSUES} 条。每条写明章节 id、问题类型、从文档中原样复制的片段、问题和修改建议。没有问题时提交空数组。`,
          parameters: { issues: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            section: { type: "string", required: true }, kind: { type: "string", enum: READING_REVIEW_KINDS, required: true },
            quote: { type: "string", required: true }, problem: { type: "string", required: true }, suggestion: { type: "string", required: true },
          } } } },
          output: { schema: { type: "string" }, render: (_args, value) => [{ type: "text", text: value }] },
          execute: async (args) => {
            const list = Array.isArray((args as { issues?: unknown }).issues) ? (args as { issues: ReadingReviewIssue[] }).issues : [];
            const problems = [
              ...(list.length > MAX_ISSUES ? [`意见最多 ${MAX_ISSUES} 条，请合并或只保留最影响理解的。`] : []),
              ...list.filter((issue) => !ids.has(issue.section)).map((issue) => `章节 id「${issue.section}」不存在，可用的 id：${[...ids].join("、")}。`),
              ...list.filter((issue) => !issue.problem?.trim()).map(() => "每条意见都要写明问题。"),
            ];
            if (problems.length) {
              const rejection = new HarnessError([...new Set(problems)].join("\n"), "invalid_review");
              rejection.name = "ReportRejection";
              throw rejection;
            }
            if (issues) throw Object.assign(new HarnessError("审读意见已经提交。", "review_closed"), { name: "ReportRejection" });
            issues = list.map((issue) => ({ section: issue.section, kind: issue.kind, quote: issue.quote.trim(), problem: issue.problem.trim(), suggestion: issue.suggestion.trim() }));
            return `已记录 ${issues.length} 条审读意见。`;
          },
        }));
        let steps = 0;
        agentCtx.on("agent/pre-step", async (_payload, next) => {
          if (++steps <= REVIEW_STEP_LIMIT || issues) return next();
          agent.cancel({ kind: "hook", reason: "审读达到步数上限" });
          return { kind: "reject" };
        });
      },
    });
    handle.agent.followup(createUserMessage({ source: { kind: "ureview-review" }, content: [{ type: "text", text: [
      "本消息末尾「## 文档」之后就是一份 PR 解读文档的全文，它不在仓库里，也不需要去别处找。文档写给熟悉编程语言、但没读过这个模块和这个 PR 的工程师，任务是讲清这个 PR 的实现：改了什么、改动前后怎么工作、关键代码怎么读。它不负责找问题和做判断，问题由另外的评审结论负责。",
      "请以目标读者的身份通读一遍，找出读不懂、会读错，或越界做了评价的地方，然后调用 submit_review 提交意见。",
      "逐项检查：",
      ...Object.entries(kindLabels).map(([kind, label]) => `- ${kind}：${label}`),
      "要求：quote 从文档中原样复制，便于作者定位；problem 说清读者会卡在哪里或会读错什么；suggestion 给出具体改法，例如把缩写改成怎样的白话句子，或把评价改成怎样的事实描述。只报会影响理解的问题，不报措辞偏好。核对说法时以文档中附带的代码摘录和需求来源为准。",
      "",
      ...(copied.length ? ["", `宿主发现章节标题原样照搬了需求来源里的这些说法：「${copied.join("」「")}」。请判断它们对目标读者是否需要先翻译成白话。`] : []),
      "",
      "## 需求来源",
      ...input.requirementSources.map((source) => `[${source.id}] ${source.title}\n${source.description}`),
      "",
      "## 文档",
      documentText(content),
    ].join("\n") }] }));
    await handle.agent.whenIdle();
    if (!issues) {
      handle.agent.followup(createUserMessage({ source: { kind: "ureview-review" }, content: [{ type: "text", text: "请调用 submit_review 提交审读意见；没有问题时提交空数组。" }] }));
      await handle.agent.whenIdle();
    }
    if (!issues) throw new ReviewError("reading_review_failed", "审读未提交意见");
    return { issues, durationMs: Date.now() - started };
  } catch (error) {
    failure = error;
    if (error instanceof ReportRejection || error instanceof ReviewError) throw error;
    throw new ReviewError("reading_review_failed", "审读未能完成");
  } finally {
    try { await handle?.dispose(); }
    finally { await recording?.close(failure); }
  }
}
