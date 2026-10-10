import { isRecord, request } from "./api";
import { ruleCategoryLabels, ruleSeverityLabels, type RuleCategory, type RuleSeverity } from "./managed-rules-api";
import { isRuleLayer, type RuleLayer } from "./rule-metadata";

export type ReviewStatus = "queued" | "running" | "completed" | "failed";
export type FindingStatus = "Pending" | "Resolved" | "Dismissed" | "Ignored" | "Outdated";
export const dispositionReasonLabels = {
  false_positive: "误报", rule_not_applicable: "规范不适用", rule_incorrect: "规范有误",
  not_worth_fixing: "不值得修改", other: "其他",
};
export type DispositionReason = keyof typeof dispositionReasonLabels;
export interface FindingDisposition {
  version: number;
  actor: { id: string; name: string } | null;
  updatedAt: string | null;
  reasonCategory: DispositionReason | null;
  explanation: string | null;
}
export interface FindingComparison {
  kind: "new" | "recurring";
  previousFinding: {
    reviewId: string; round: number; findingId: string; status: FindingStatus; disposition: FindingDisposition | null;
  } | null;
}
export interface DispositionInput {
  version: number;
  status: "Resolved" | "Dismissed" | "Pending";
  reasonCategory?: DispositionReason;
  explanation?: string;
}

export interface ReviewSummary {
  id: string;
  repositoryId: string;
  repositoryName: string;
  iid: number;
  title: string;
  author: string;
  headSha: string;
  status: ReviewStatus;
  statusMessage: string | null;
  failureReason: string | null;
  createdAt: string;
  completedAt: string | null;
  round: number;
  trigger: "automatic" | "manual";
  viewedAt: string | null;
  findingCounts: { high: number; medium: number };
}

export interface CodeRange { path: string; startLine: number; endLine: number }
/** 页面内定位的目标。位置不在本轮差异片段内时，用 code 显示评审时读取的代码；没有 code 时才给平台链接。 */
export interface CodeTarget extends CodeRange { code?: string; url?: string }
export interface ReadRange extends CodeRange { tool: "read" | "grep"; phase: "generator" | "grader" }
export interface ReportSubmission {
  phase: "generator" | "grader";
  /** report_overview 只出现在 Story 24 之前的轮次里。 */
  tool: "report_file_groups" | "report_overview" | "report_finding" | "finish_report" | "grade_finding";
  outcome: "accepted" | "rejected";
  code: string | null;
  reason: string | null;
}
interface ModelIdentity { vendor: string; provider: string; model: string }
export interface FindingAnchor extends CodeRange { side: "new"; fingerprint: string }
export interface FilePatch { oldPath: string; newPath: string; patch: string; newFile: boolean; deletedFile: boolean; renamedFile: boolean }
export interface FileGroup { name: string; files: Array<{ path: string; theme: string }> }

export interface ReviewFinding {
  id: string;
  title: string;
  description: string;
  severity: "high" | "medium";
  location: CodeRange;
  anchor: FindingAnchor | null;
  code: string;
  /** code 是评审时读取的证据代码，早于该字段的评审没有。 */
  evidence: Array<CodeRange & { description: string; url: string; code?: string }>;
  fixPrompt: string;
  ruleId: string | null;
  ruleCategory?: RuleCategory;
  ruleSeverity?: RuleSeverity;
  score: number;
  generatorModel: ModelIdentity;
  graderModel: ModelIdentity;
  readFiles: ReadRange[];
  generatedAt: string;
  status: FindingStatus;
  disposition?: FindingDisposition;
  fingerprint?: string;
  comparison?: FindingComparison;
}

export function mergeFindingDisposition(current: ReviewFinding, incoming: ReviewFinding): ReviewFinding {
  return (current.disposition?.version ?? 0) > (incoming.disposition?.version ?? 0)
    ? { ...current, ...incoming, status: current.status, disposition: current.disposition }
    : { ...current, ...incoming };
}

export interface ReviewDetail extends ReviewSummary {
  conclusion: ReviewConclusion;
  scope: { excludedDirectories: string[]; excludedFileCount: number };
  pullRequest: {
    iid: number; title: string; description: string; author: string; webUrl: string;
    sourceBranch: string; targetBranch: string; headSha: string; baseSha: string; startSha: string;
  } | null;
  findings: ReviewFinding[];
  readFiles: ReadRange[];
  reportSubmissions: ReportSubmission[];
  rules: ReviewRule[];
  files: FilePatch[];
  fileGroups: FileGroup[];
  foldedCount: number;
  comparison: { previousReview: { id: string; round: number } | null; absentFindings: ReviewFinding[] };
}

export interface ReviewConclusion {
  status: "queued" | "running" | "failed" | "requires_changes" | "manual_judgment" | "no_major_findings";
  findingCounts: { high: number; medium: number };
  disposedCount: number;
}

export interface ReviewRule {
  id: string;
  layer?: RuleLayer;
  judgement?: boolean;
  body: string;
  source: { kind: "manual" | "mined" | "generated"; url?: string };
  file: { kind: "global" | "repository"; repositoryId: string; repositoryName: string; path: string; commitSha: string; url: string }
    | { kind: "database"; ruleId: string; version: number; scope: "global" | "repositories" };
  name?: string;
  category?: RuleCategory;
  severity?: RuleSeverity;
  goodExample?: string;
  badExample?: string;
  matchedPaths: string[];
}
export interface ReviewPageResult { reviews: ReviewSummary[]; total: number; page: number; pageSize: number }
export interface ReviewFilters { repositoryId?: string; status?: ReviewStatus; page: number; pageSize: number }

const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positive = (value: unknown): value is number => nonnegative(value) && value > 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === "string";

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
}

function isCodeRange(value: unknown): value is CodeRange {
  return isRecord(value) && typeof value.path === "string" && positive(value.startLine)
    && positive(value.endLine) && value.endLine >= value.startLine;
}
function isReadRange(value: unknown): value is ReadRange {
  return isCodeRange(value) && isRecord(value) && ["read", "grep"].includes(value.tool as string)
    && ["generator", "grader"].includes(value.phase as string);
}
function isReportSubmission(value: unknown): value is ReportSubmission {
  return isRecord(value) && ["generator", "grader"].includes(value.phase as string)
    && ["report_file_groups", "report_overview", "report_finding", "finish_report", "grade_finding"].includes(value.tool as string)
    && ["accepted", "rejected"].includes(value.outcome as string)
    && isNullableString(value.code) && isNullableString(value.reason);
}
function isModel(value: unknown): value is ModelIdentity {
  return isRecord(value) && ["vendor", "provider", "model"].every((key) => typeof value[key] === "string");
}
function isReviewSummary(value: unknown): value is ReviewSummary {
  return isRecord(value)
    && ["id", "repositoryId", "repositoryName", "title", "author", "headSha", "createdAt"].every((key) => typeof value[key] === "string")
    && positive(value.iid) && positive(value.round)
    && ["queued", "running", "completed", "failed"].includes(value.status as string)
    && ["automatic", "manual"].includes(value.trigger as string)
    && isNullableString(value.statusMessage) && isNullableString(value.failureReason)
    && isNullableString(value.completedAt) && isNullableString(value.viewedAt)
    && isRecord(value.findingCounts) && nonnegative(value.findingCounts.high) && nonnegative(value.findingCounts.medium);
}
type StoredFinding = Omit<ReviewFinding, "anchor"> & { anchor?: FindingAnchor | null };
type StoredReview = Omit<ReviewDetail, "findings" | "scope" | "reportSubmissions" | "comparison"> & {
  findings: StoredFinding[]; scope?: ReviewDetail["scope"]; reportSubmissions?: ReportSubmission[]; comparison?: ReviewDetail["comparison"];
};

function isFindingStatus(value: unknown): value is FindingStatus {
  return typeof value === "string" && ["Pending", "Resolved", "Dismissed", "Ignored", "Outdated"].includes(value);
}
function isDisposition(value: unknown): value is FindingDisposition {
  return isRecord(value) && nonnegative(value.version)
    && (value.actor === null || (isRecord(value.actor) && typeof value.actor.id === "string" && typeof value.actor.name === "string"))
    && isNullableString(value.updatedAt) && isNullableString(value.explanation)
    && (value.reasonCategory === null || (typeof value.reasonCategory === "string" && Object.hasOwn(dispositionReasonLabels, value.reasonCategory)));
}
function isFindingComparison(value: unknown): value is FindingComparison {
  if (!isRecord(value) || !["new", "recurring"].includes(value.kind as string)) return false;
  const previous = value.previousFinding;
  if (value.kind === "new") return previous === null;
  return isRecord(previous) && typeof previous.reviewId === "string" && positive(previous.round)
    && typeof previous.findingId === "string" && isFindingStatus(previous.status)
    && (previous.disposition === null || isDisposition(previous.disposition));
}
function isReviewComparison(value: unknown): value is ReviewDetail["comparison"] {
  return isRecord(value) && (value.previousReview === null || (isRecord(value.previousReview)
    && typeof value.previousReview.id === "string" && positive(value.previousReview.round)))
    && Array.isArray(value.absentFindings) && value.absentFindings.every(isFinding);
}

function isFinding(value: unknown): value is StoredFinding {
  if (!isRecord(value)) return false;
  const anchor = value.anchor ?? null;
  const validAnchor = anchor === null || (isCodeRange(anchor) && isRecord(anchor)
    && anchor.side === "new" && typeof anchor.fingerprint === "string");
  return ["id", "title", "description", "code", "fixPrompt", "generatedAt"].every((key) => typeof value[key] === "string")
    && ["high", "medium"].includes(value.severity as string)
    && isCodeRange(value.location) && validAnchor
    && isNullableString(value.ruleId)
    && (value.ruleCategory === undefined || (typeof value.ruleCategory === "string" && Object.hasOwn(ruleCategoryLabels, value.ruleCategory)))
    && (value.ruleSeverity === undefined || (typeof value.ruleSeverity === "string" && Object.hasOwn(ruleSeverityLabels, value.ruleSeverity)))
    && typeof value.score === "number" && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100
    && isModel(value.generatorModel) && isModel(value.graderModel)
    && Array.isArray(value.readFiles) && value.readFiles.every(isReadRange)
    && Array.isArray(value.evidence) && value.evidence.every((item: unknown) =>
      isCodeRange(item) && isRecord(item) && typeof item.description === "string" && isHttpUrl(item.url)
      && (item.code === undefined || typeof item.code === "string"))
    && isFindingStatus(value.status)
    && (value.disposition === undefined || isDisposition(value.disposition))
    && (value.fingerprint === undefined || typeof value.fingerprint === "string")
    && (value.comparison === undefined || isFindingComparison(value.comparison));
}
function isPullRequest(value: unknown): value is NonNullable<ReviewDetail["pullRequest"]> {
  return isRecord(value) && positive(value.iid) && isHttpUrl(value.webUrl)
    && ["title", "description", "author", "sourceBranch", "targetBranch", "headSha", "baseSha", "startSha"].every((key) => typeof value[key] === "string");
}
function isRule(value: unknown): value is ReviewRule {
  if (!isRecord(value) || !isRecord(value.file)) return false;
  const file = value.file;
  const originValid = file.kind === "database"
    ? typeof file.ruleId === "string" && positive(file.version) && ["global", "repositories"].includes(file.scope as string)
      && ["name", "goodExample", "badExample"].every((key) => typeof value[key] === "string")
      && typeof value.category === "string" && Object.hasOwn(ruleCategoryLabels, value.category)
      && typeof value.severity === "string" && Object.hasOwn(ruleSeverityLabels, value.severity)
    : ["global", "repository"].includes(file.kind as string)
      && ["repositoryId", "repositoryName", "path", "commitSha"].every((key) => typeof file[key] === "string") && isHttpUrl(file.url);
  return typeof value.id === "string" && typeof value.body === "string"
    && (value.layer === undefined || isRuleLayer(value.layer))
    && (value.judgement === undefined || typeof value.judgement === "boolean")
    && isRecord(value.source) && ["manual", "mined", "generated"].includes(value.source.kind as string)
    && (value.source.url === undefined || isHttpUrl(value.source.url))
    && originValid && strings(value.matchedPaths);
}
function isFilePatch(value: unknown): value is FilePatch {
  return isRecord(value) && ["oldPath", "newPath", "patch"].every((key) => typeof value[key] === "string")
    && ["newFile", "deletedFile", "renamedFile"].every((key) => typeof value[key] === "boolean");
}
function isFileGroup(value: unknown): value is FileGroup {
  return isRecord(value) && typeof value.name === "string" && Array.isArray(value.files)
    && value.files.every((file: unknown) => isRecord(file) && typeof file.path === "string" && typeof file.theme === "string");
}

export function listReviews(filters: ReviewFilters, signal: AbortSignal): Promise<ReviewPageResult> {
  const params = new URLSearchParams({ page: String(filters.page), pageSize: String(filters.pageSize) });
  if (filters.repositoryId) params.set("repositoryId", filters.repositoryId);
  if (filters.status) params.set("status", filters.status);
  return request<ReviewPageResult>(`/api/reviews?${params}`, (body): body is ReviewPageResult => isRecord(body)
    && Array.isArray(body.reviews) && body.reviews.every(isReviewSummary)
    && nonnegative(body.total) && positive(body.page) && positive(body.pageSize), { signal });
}

export async function getReview(reviewId: string, signal: AbortSignal): Promise<ReviewDetail> {
  const result = await request<{ review: StoredReview }>(`/api/reviews/${encodeURIComponent(reviewId)}`,
    (body): body is { review: StoredReview } => {
      if (!isRecord(body) || !isReviewSummary(body.review) || !isRecord(body.review)) return false;
      const review = body.review;
      return isRecord(review.conclusion)
        && ["queued", "running", "failed", "requires_changes", "manual_judgment", "no_major_findings"].includes(review.conclusion.status as string)
        && isRecord(review.conclusion.findingCounts)
        && nonnegative(review.conclusion.findingCounts.high) && nonnegative(review.conclusion.findingCounts.medium)
        && nonnegative(review.conclusion.disposedCount)
        && (review.pullRequest === null || isPullRequest(review.pullRequest))
        && Array.isArray(review.findings) && review.findings.every(isFinding)
        && Array.isArray(review.readFiles) && review.readFiles.every(isReadRange)
        && (review.reportSubmissions === undefined || (Array.isArray(review.reportSubmissions) && review.reportSubmissions.every(isReportSubmission)))
        && Array.isArray(review.rules) && review.rules.every(isRule)
        && Array.isArray(review.files) && review.files.every(isFilePatch)
        && (review.comparison === undefined || isReviewComparison(review.comparison))
        && (review.scope === undefined || (isRecord(review.scope) && strings(review.scope.excludedDirectories) && nonnegative(review.scope.excludedFileCount)))
        && Array.isArray(review.fileGroups) && review.fileGroups.every(isFileGroup) && nonnegative(review.foldedCount);
    }, { signal });
  return { ...result.review, scope: result.review.scope ?? { excludedDirectories: [], excludedFileCount: 0 },
    reportSubmissions: result.review.reportSubmissions ?? [],
    comparison: result.review.comparison ?? { previousReview: null, absentFindings: [] },
    findings: result.review.findings.map((finding) => ({ ...finding, anchor: finding.anchor ?? null })) };
}

export async function setFindingDisposition(reviewId: string, findingId: string, input: DispositionInput): Promise<ReviewFinding> {
  const result = await request<{ finding: StoredFinding }>(
    `/api/reviews/${encodeURIComponent(reviewId)}/findings/${encodeURIComponent(findingId)}/disposition`,
    (body): body is { finding: StoredFinding } => isRecord(body) && isFinding(body.finding),
    { method: "PATCH", body: JSON.stringify(input) });
  return { ...result.finding, anchor: result.finding.anchor ?? null };
}

export async function listReviewRounds(repositoryId: string, iid: number, signal: AbortSignal): Promise<ReviewSummary[]> {
  const result = await request<{ reviews: ReviewSummary[] }>(
    `/api/repositories/${encodeURIComponent(repositoryId)}/pull-requests/${iid}/reviews`,
    (body): body is { reviews: ReviewSummary[] } => isRecord(body) && Array.isArray(body.reviews) && body.reviews.every(isReviewSummary), { signal });
  return result.reviews;
}

export function rerunReview(reviewId: string, requestId: string): Promise<{ reviewId: string; created: boolean }> {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/rerun`,
    (body): body is { reviewId: string; created: boolean } => isRecord(body) && typeof body.reviewId === "string" && typeof body.created === "boolean",
    { method: "POST", body: JSON.stringify({ requestId }) });
}

export function startReview(url: string, requestId: string): Promise<{ id: string; created: boolean }> {
  return request("/api/reviews",
    (body): body is { id: string; created: boolean } => isRecord(body) && typeof body.id === "string" && typeof body.created === "boolean",
    { method: "POST", body: JSON.stringify({ url, requestId }) });
}

export function markReviewViewed(reviewId: string): Promise<{ viewedAt: string }> {
  return request(`/api/reviews/${encodeURIComponent(reviewId)}/viewed`,
    (body): body is { viewedAt: string } => isRecord(body) && typeof body.viewedAt === "string",
    { method: "POST" });
}
