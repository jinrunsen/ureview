import type { RequirementSource } from "./requirement-sources.js";
import type { CodeRange, ModelIdentity, ReadRange, ReviewInput } from "./types.js";

export type ReadingDocumentStatus = "queued" | "running" | "completed" | "failed";

/** 解读的必需章节；接口配置与数据变化（interfaces）、测试（tests）有才写，模型也可以插入自定义章节。 */
export const REQUIRED_DOCUMENT_SECTIONS = ["summary", "background", "scope", "design", "walkthrough"] as const;
/** 标准章节的目录短名与顺序由宿主固定，不同 PR 的目录保持一致；自定义章节沿用模型给的短名。 */
export const STANDARD_DOCUMENT_SECTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "summary", label: "概要" }, { id: "background", label: "背景" }, { id: "scope", label: "改动范围" },
  { id: "design", label: "方案与行为变化" }, { id: "interfaces", label: "接口与数据变化" }, { id: "tests", label: "测试" },
  { id: "walkthrough", label: "代码导读" },
];

export interface DocumentOutlineEntry {
  id: string;
  /** 目录里显示的短名。 */
  label: string;
  /** 正文标题：有主语的完整句子。 */
  title: string;
}

export interface DocumentExcerpt extends CodeRange { excerpt: string }

export const READING_REVIEW_KINDS = ["jargon", "undefined_term", "title", "inaccurate", "order", "figure", "judgment", "other"] as const;
export interface ReadingReviewIssue {
  section: string;
  kind: typeof READING_REVIEW_KINDS[number];
  quote: string;
  problem: string;
  suggestion: string;
}

export interface ReadingDocumentMetrics {
  steps: number;
  /** 模型未结束就停下时宿主提醒的次数。 */
  nudges: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  accepted: number;
  rejected: number;
  warnings: number;
  /** 读者审读：意见、按意见重写的章节；审读失败时记录原因，文档照常保存。 */
  review: { issues: ReadingReviewIssue[]; revisedSections: string[]; failed: string | null; durationMs: number } | null;
}

export interface ReadingDocumentContent {
  outline: DocumentOutlineEntry[];
  sections: Record<string, string>;
  excerpts: Record<string, DocumentExcerpt>;
}

export interface ReadingDocumentSubmission {
  tool: "submit_outline" | "write_section" | "finish_document";
  outcome: "accepted" | "rejected";
  code: string | null;
  reason: string | null;
  warnings: string[];
}

/** 解读只讲实现，与 Generator 并行生成，输入里没有本轮的 finding。 */
export interface ReadingDocumentInput extends Omit<ReviewInput, "onFinding" | "onReportSubmission" | "onRules"> {
  requirementSources: RequirementSource[];
  architectureCandidates: string[];
  onSubmission?: (submission: ReadingDocumentSubmission) => Promise<void>;
}

export interface ReadingDocumentOutput {
  content: ReadingDocumentContent;
  metrics: ReadingDocumentMetrics;
  readFiles: ReadRange[];
  model: ModelIdentity;
}

export interface ReadingDocumentRecord {
  id: string;
  reviewId: string;
  status: ReadingDocumentStatus;
  failureReason: string | null;
  content: ReadingDocumentContent | null;
  metrics: ReadingDocumentMetrics | null;
  submissions: ReadingDocumentSubmission[];
  model: ModelIdentity | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
