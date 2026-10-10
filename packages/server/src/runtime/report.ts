import { parseFileGroups, type FileGroup } from "../reviews/file-groups.js";
import { ReportRejection, ReviewError, type FilePatch, type FindingCandidate, type ReviewInput, type ReportSubmission } from "../reviews/types.js";

/** 只保存已接受的报告；提交拒绝与无法继续执行的故障使用不同通道。 */
export class ReviewReport {
  private fileGroups: FileGroup[] | undefined;
  private readonly candidates: FindingCandidate[] = [];
  private readonly scores = new Map<string, number>();
  private finished = false;
  private failure: ReviewError | undefined;
  private pending = Promise.resolve();
  private pendingSubmissions = Promise.resolve();

  constructor(private readonly files: FilePatch[], private readonly saveFinding: ReviewInput["onFinding"],
    private readonly saveSubmission?: ReviewInput["onReportSubmission"]) {}

  recordSubmission(submission: ReportSubmission): void {
    // 已发生的工具回执必须落库，即使另一项并行报告操作随后失败。
    this.pendingSubmissions = this.pendingSubmissions.then(async () => {
      try { await this.saveSubmission?.(submission); }
      catch { this.fail(new ReviewError("report_submission_write_failed", "评审提交记录保存失败")); }
    });
  }

  async settled(): Promise<void> {
    await this.pending;
    await this.pendingSubmissions;
    this.assertHealthy();
  }

  fail(error: ReviewError): void { this.failure ??= error; }

  submitFileGroups(input: unknown): Promise<string> {
    return this.accept(() => {
      this.assertOpen();
      if (this.fileGroups) throw new ReportRejection("file_groups_accepted", "文件分组已经接受，请继续提交结论或调用 finish_report。");
      this.fileGroups = parseFileGroups(input, this.files);
      return "文件分组已记录";
    });
  }

  submitFinding(validate: () => Promise<FindingCandidate>): Promise<string> {
    return this.accept(async () => {
      this.assertOpen();
      const finding = await validate();
      try { await this.saveFinding(finding); }
      catch { throw new ReviewError("finding_write_failed", "评审结论保存失败"); }
      this.candidates.push(finding);
      return finding.id;
    });
  }

  finish(): Promise<number> {
    return this.accept(() => {
      if (!this.fileGroups) throw new ReportRejection("file_groups_missing", "缺少有效的文件分组，请先调用 report_file_groups，成功后再调用 finish_report。");
      this.finished = true;
      return this.candidates.length;
    });
  }

  grade(findingId: string, score: number): Promise<string> {
    return this.accept(() => {
      if (!this.finished) throw new ReportRejection("report_open", "报告尚未结束，不能评分。");
      if (!this.candidates.some((finding) => finding.id === findingId)) {
        throw new ReportRejection("invalid_grade", "findingId 必须使用已接受结论的 ID。");
      }
      if (this.scores.has(findingId)) throw new ReportRejection("grade_accepted", "该结论的评分已经接受，请继续评分其他结论。");
      if (!Number.isSafeInteger(score) || score < 0 || score > 100) {
        throw new ReportRejection("invalid_grade", "score 必须是 0 到 100 的整数，请修正后重新提交。");
      }
      this.scores.set(findingId, score);
      return "评分已记录";
    });
  }

  completeGeneration(): { fileGroups: FileGroup[]; candidates: readonly FindingCandidate[] } {
    this.assertHealthy();
    if (!this.fileGroups) throw new ReviewError("file_groups_missing", "模型结束时未提交有效的文件分组");
    if (!this.finished) throw new ReviewError("report_missing", "模型结束时未完成评审报告，请成功调用 finish_report");
    return { fileGroups: this.fileGroups, candidates: [...this.candidates] };
  }

  completeGrading(): ReadonlyMap<string, number> {
    this.assertHealthy();
    if (this.scores.size !== this.candidates.length) throw new ReviewError("grade_missing", "模型未完成所有评审结论的评分");
    return new Map(this.scores);
  }

  assertHealthy(): void {
    if (this.failure) throw this.failure;
  }

  private assertOpen(): void {
    if (this.finished) throw new ReportRejection("report_closed", "评审报告已结束，不能继续提交文件分组或结论。");
  }

  private accept<T>(execute: () => T | Promise<T>): Promise<T> {
    // 报告工具可能并行调用；完成操作必须等待先前的校验和保存。
    const work = this.pending.then(async () => {
      this.assertHealthy();
      try { return await execute(); }
      catch (error) {
        if (error instanceof ReportRejection) throw error;
        this.failure ??= error instanceof ReviewError ? error
          : new ReviewError("report_execution_failed", "评审报告处理失败，无法继续提交");
        throw this.failure;
      }
    });
    this.pending = work.then(() => {}, () => {});
    return work;
  }
}
