import { isRecord, request } from "./api";
import { anchorInPatch } from "./diff-location";
import type { CodeRange, FilePatch } from "./review-api";

export type ReadingStatus = "queued" | "running" | "completed" | "failed";
export interface ReadingOutlineEntry { id: string; label: string; title: string }
export interface ReadingExcerpt extends CodeRange { excerpt: string }
export interface ReadingContent {
  outline: ReadingOutlineEntry[];
  sections: Record<string, string>;
  excerpts: Record<string, ReadingExcerpt>;
}
export interface ReadingReviewIssue { section: string; kind: string; quote: string; problem: string; suggestion: string }
export interface ReadingMetrics {
  steps: number; nudges: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; durationMs: number;
  accepted: number; rejected: number; warnings: number;
  review: { issues: ReadingReviewIssue[]; revisedSections: string[]; failed: string | null; durationMs: number } | null;
}
export interface ReadingSubmission {
  tool: "submit_outline" | "write_section" | "finish_document"; outcome: "accepted" | "rejected";
  code: string | null; reason: string | null; warnings: string[];
}
export interface Reading {
  id: string; reviewId: string; status: ReadingStatus; failureReason: string | null;
  content: ReadingContent | null; metrics: ReadingMetrics | null; submissions: ReadingSubmission[];
  model: { provider: string; model: string; vendor: string } | null;
  createdAt: string; startedAt: string | null; completedAt: string | null;
}

export const readingReviewKindLabels: Record<string, string> = {
  jargon: "照抄缩写", undefined_term: "术语没解释", title: "标题说不清", inaccurate: "与代码或原文不符",
  order: "顺序跳跃", figure: "图没讲清", judgment: "越界评价", other: "其他",
};
export const readingStatusLabels: Record<ReadingStatus, string> = { queued: "排队中", running: "生成中", completed: "已完成", failed: "失败" };

const nullableText = (value: unknown): value is string | null => value === null || typeof value === "string";
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function isExcerpt(value: unknown): value is ReadingExcerpt {
  return isRecord(value) && typeof value.path === "string" && positive(value.startLine) && positive(value.endLine)
    && Number(value.endLine) >= Number(value.startLine) && typeof value.excerpt === "string";
}
function isContent(value: unknown): value is ReadingContent {
  return isRecord(value) && Array.isArray(value.outline) && value.outline.every((entry: unknown) => isRecord(entry)
      && ["id", "label", "title"].every((key) => typeof entry[key] === "string"))
    && isRecord(value.sections) && Object.values(value.sections).every((html) => typeof html === "string")
    && isRecord(value.excerpts) && Object.values(value.excerpts).every(isExcerpt);
}
function isSubmission(value: unknown): value is ReadingSubmission {
  return isRecord(value) && ["submit_outline", "write_section", "finish_document"].includes(String(value.tool))
    && ["accepted", "rejected"].includes(String(value.outcome)) && nullableText(value.code) && nullableText(value.reason)
    && Array.isArray(value.warnings) && value.warnings.every((warning: unknown) => typeof warning === "string");
}
function isReading(value: unknown): value is Reading {
  return isRecord(value) && typeof value.id === "string" && typeof value.reviewId === "string"
    && ["queued", "running", "completed", "failed"].includes(String(value.status)) && nullableText(value.failureReason)
    && (value.content === null || isContent(value.content)) && (value.status !== "completed" || value.content !== null)
    && (value.metrics === null || isRecord(value.metrics))
    && Array.isArray(value.submissions) && value.submissions.every(isSubmission) && typeof value.createdAt === "string";
}

export function listReadings(reviewId: string, signal?: AbortSignal) {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/reading-documents`,
    (body): body is { documents: Reading[] } => isRecord(body) && Array.isArray(body.documents) && body.documents.every(isReading),
    signal ? { signal } : undefined);
}

export function regenerateReading(reviewId: string) {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/reading-documents`,
    (body): body is { document: Reading } => isRecord(body) && isReading(body.document), { method: "POST" });
}

export function referenceInDiff(reference: CodeRange, files: FilePatch[]): boolean {
  return files.some((file) => anchorInPatch(file, reference));
}
