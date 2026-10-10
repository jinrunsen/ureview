export interface RepositoryCredentials {
  id: string;
  instanceUrl: string;
  projectId: number;
  pathWithNamespace: string;
  webUrl: string;
  httpUrlToRepo: string;
  token: string;
}

export interface PullRequestOpened {
  projectId: number;
  iid: number;
  headSha: string;
  title: string;
  author: string;
  previousHeadSha?: string;
}

export interface PullRequest {
  reviewers?: string[];
  assignees?: string[];
  state?: "opened" | "merged" | "closed";
  iid: number;
  title: string;
  description: string;
  author: string;
  webUrl: string;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  baseSha: string | null;
  startSha: string | null;
}

export interface FilePatch {
  oldPath: string;
  newPath: string;
  patch: string;
  newFile: boolean;
  deletedFile: boolean;
  renamedFile: boolean;
}

export interface PlatformPort {
  onEvent(payload: unknown): PullRequestOpened | null;
  getPullRequest(iid: number): Promise<PullRequest>;
  getDiff(pullRequest: PullRequest): Promise<FilePatch[]>;
  getFileContent(ref: string, path: string): Promise<RepositoryFile>;
  getGroupingSignals(iid: number): Promise<{ labels: string[] }>;
  cloneOrUpdate(pullRequest: PullRequest, directory: string): Promise<string>;
  getCommits(iid: number): Promise<PullRequestCommit[]>;
  getClosingIssues(iid: number): Promise<PullRequestIssue[]>;
}

export interface PullRequestCommit {
  sha: string;
  title: string;
  message: string;
  webUrl: string;
}

export interface PullRequestIssue {
  iid: number;
  title: string;
  description: string;
  webUrl: string;
}

export interface RepositoryFile { content: string; commitSha: string; path: string }

export interface GitRuleFile {
  kind: "global" | "repository";
  repositoryId: string;
  repositoryName: string;
  path: string;
  commitSha: string;
  url: string;
}

export interface DatabaseRuleFile {
  kind: "database";
  ruleId: string;
  version: number;
  scope: "global" | "repositories";
}

export interface ReviewRule {
  id: string;
  body: string;
  judgement?: boolean;
  layer?: import("../rules/metadata.js").RuleLayer;
  languages?: string[];
  overrides?: string[];
  status?: "active" | "overridden" | "waived";
  effectivePaths?: string[];
  overriddenBy?: Array<{ ruleId: string; paths: string[] }>;
  waiver?: { reason: string; createdBy: string; createdAt: string };
  name?: string;
  category?: RuleCategory;
  severity?: RuleSeverity;
  goodExample?: string;
  badExample?: string;
  source: { kind: "manual" | "mined" | "generated"; url?: string };
  file: GitRuleFile | DatabaseRuleFile;
  matchedPaths: string[];
}

export type GitReviewRule = ReviewRule & { file: GitRuleFile };

export interface RepositoryRuleSession<T extends ReviewRule = ReviewRule> {
  resolve(paths: string[], turn: number): Promise<{ context: string; rules: T[] }>;
}

export type PlatformFactory = (repository: RepositoryCredentials) => PlatformPort;

export interface ReviewDiagnostic {
  operation?: "managed_rules_read";
  causeCategory?: "access_denied" | "unavailable" | "invalid_response" | "response_too_large" | "timeout" | "network_error";
  httpStatus?: number;
}

export class ReviewError extends Error {
  constructor(readonly code: string, message: string, readonly diagnostic: ReviewDiagnostic = {}) {
    super(message);
    this.name = "ReviewError";
  }
}

/** 当前提交未被接受，模型可以根据反馈修正；已接受的报告保持不变。 */
export class ReportRejection extends ReviewError {}

export class DiffNotReadyError extends ReviewError {
  constructor() { super("diff_not_ready", "代码平台尚未准备好本次提交的 diff，正在等待"); }
}

export interface ModelIdentity {
  provider: string;
  model: string;
  vendor: string;
}

export interface CodeRange {
  path: string;
  startLine: number;
  endLine: number;
}

export interface CodeAnchor extends CodeRange {
  side: "new";
  fingerprint: string;
}

export interface ReadRange extends CodeRange {
  tool: "read" | "grep";
  phase: "reading" | "generator" | "grader";
}

export interface FindingCandidate {
  id: string;
  title: string;
  description: string;
  severity: "high" | "medium" | "low";
  location: CodeRange;
  evidence: Array<CodeRange & { description: string }>;
  fixPrompt: string;
  ruleId: string | null;
  ruleCategory?: RuleCategory;
  ruleSeverity?: RuleSeverity;
  generatedAt: string;
}

export interface ReviewFinding extends FindingCandidate {
  anchor?: CodeAnchor | null;
  fingerprint?: string;
  code: string;
  /** code 是评审时读取的证据代码；早于该字段保存的证据没有。 */
  evidence: Array<CodeRange & { description: string; url: string; code?: string }>;
  score: number;
  generatorModel: ModelIdentity;
  graderModel: ModelIdentity;
  readFiles: ReadRange[];
  status: FindingStatus;
  disposition?: FindingDisposition;
  comparison?: FindingComparison;
}

export type FindingStatus = "Pending" | "Resolved" | "Dismissed" | "Ignored" | "Outdated";
export type DismissalReasonCategory = "false_positive" | "rule_not_applicable" | "rule_incorrect" | "not_worth_fixing" | "other";

export interface FindingDisposition {
  status: FindingStatus;
  version: number;
  actor: { id: string; name: string } | null;
  updatedAt: string | null;
  reasonCategory: DismissalReasonCategory | null;
  explanation: string | null;
}

export interface FindingComparison {
  kind: "new" | "recurring";
  previousFinding: {
    reviewId: string;
    round: number;
    findingId: string;
    status: FindingStatus;
    disposition: FindingDisposition | null;
  } | null;
}

export interface RoundComparison {
  previousReview: { id: string; round: number } | null;
  absentFindings: ReviewFinding[];
}

export interface ReviewInput {
  reviewId: string;
  cwd: string;
  pullRequest: PullRequest;
  files: FilePatch[];
  excludedDirectories?: string[];
  rules?: ReviewRule[];
  repositoryRules?: () => RepositoryRuleSession;
  onRules?: (rules: ReviewRule[]) => Promise<void>;
  onFinding: (finding: FindingCandidate) => Promise<void>;
  onReportSubmission?: (submission: ReportSubmission) => Promise<void>;
}

export interface ReportSubmission {
  phase: "generator" | "grader";
  /** report_overview 只出现在 Story 24 之前保存的轮次里。 */
  tool: "report_file_groups" | "report_overview" | "report_finding" | "finish_report" | "grade_finding";
  outcome: "accepted" | "rejected";
  code: string | null;
  reason: string | null;
}

export interface ReviewOutput {
  fileGroups: FileGroup[];
  findings: ReviewFinding[];
  readFiles: ReadRange[];
}

export interface ReviewRuntime {
  writeDocument?(input: ReadingDocumentInput): Promise<ReadingDocumentOutput>;
  review(input: ReviewInput): Promise<ReviewOutput>;
}

export type ReviewStatus = "queued" | "running" | "completed" | "failed";

export interface ReviewConclusion {
  status: Exclude<ReviewStatus, "completed"> | "requires_changes" | "manual_judgment" | "no_major_findings";
  findingCounts: { high: number; medium: number };
  disposedCount: number;
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

export interface ReviewDetail extends ReviewSummary {
  conclusion: ReviewConclusion;
  requirementSources: RequirementSource[];
  /** 最新一份已完成解读的概要正文，转成纯文本；没有时为 null。 */
  readingSummary: string | null;
  reportSubmissions: ReportSubmission[];
  /** 本轮完成后 Generator 提交的文件分组；未完成时为空。 */
  fileGroups: FileGroup[];
  files: FilePatch[];
  foldedCount: number;
  pullRequest: PullRequest | null;
  findings: ReviewFinding[];
  readFiles: ReadRange[];
  rules: ReviewRule[];
  scope: { excludedDirectories: string[]; excludedFileCount: number };
  comparison: RoundComparison;
}

export interface ReviewPage {
  reviews: ReviewSummary[];
  page: number;
  pageSize: number;
  total: number;
}
import type { FileGroup } from "./file-groups.js";
import type { ReadingDocumentInput, ReadingDocumentOutput } from "./reading-document.js";
import type { RequirementSource } from "./requirement-sources.js";
import type { RuleCategory, RuleSeverity } from "../rules/managed-types.js";
export type { FileGroup } from "./file-groups.js";
