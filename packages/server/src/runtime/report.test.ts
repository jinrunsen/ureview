import { describe, expect, it } from "vitest";
import type { FindingCandidate, ReportSubmission } from "../reviews/types.js";
import { ReviewReport } from "./report.js";
import { makeMockFileGroups } from "./test-support.js";

const candidate: FindingCandidate = {
  id: "accepted-finding", title: "金额检查", description: "扣款金额需要校验", severity: "high",
  location: { path: "src/payment.ts", startLine: 1, endLine: 3 },
  evidence: [{ path: "src/payment.ts", startLine: 1, endLine: 3, description: "扣款入口" }],
  fixPrompt: "拒绝非正金额", ruleId: null, generatedAt: "2026-10-05T00:00:00Z",
};
const files = [{ oldPath: "src/payment.ts", newPath: "src/payment.ts", patch: "",
  newFile: false, deletedFile: false, renamedFile: false }];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

describe("并行报告提交的完成边界", () => {
  it("完成回执等待先前结论保存，并包含该结论", async () => {
    const saving = deferred();
    const release = deferred();
    const report = new ReviewReport(files, async () => { saving.resolve(); await release.promise; });
    await report.submitFileGroups({ fileGroups: makeMockFileGroups() });
    const submission = report.submitFinding(async () => candidate);
    await saving.promise;
    const finish = report.finish();
    expect(() => report.completeGeneration()).toThrow("未完成评审报告");
    release.resolve();
    await expect(submission).resolves.toBe(candidate.id);
    await expect(finish).resolves.toBe(1);
    expect(report.completeGeneration().candidates).toEqual([candidate]);
    expect(() => report.completeGrading()).toThrow("未完成所有评审结论的评分");
  });

  it("保存失败阻止排队的提交和完成，且不暴露原始异常", async () => {
    const saving = deferred();
    const release = deferred();
    let writes = 0;
    const report = new ReviewReport(files, async () => {
      writes++;
      saving.resolve();
      await release.promise;
      throw new Error("PRIVATE_STORAGE_SENTINEL");
    });
    await report.submitFileGroups({ fileGroups: makeMockFileGroups() });
    const first = report.submitFinding(async () => candidate);
    await saving.promise;
    const pending = Promise.allSettled([first, report.submitFinding(async () => candidate), report.finish()]);
    release.resolve();
    for (const result of await pending) {
      expect(result).toMatchObject({ status: "rejected", reason: { code: "finding_write_failed", message: "评审结论保存失败" } });
    }
    expect(writes).toBe(1);
    expect(() => report.completeGeneration()).toThrow("评审结论保存失败");
  });

  it("内部校验器异常保留为致命故障，不能被完整文件分组或零结论覆盖", async () => {
    let writes = 0;
    const report = new ReviewReport(files, async () => { writes++; });
    await report.submitFileGroups({ fileGroups: makeMockFileGroups() });
    await expect(report.submitFinding(async () => { throw new Error("PRIVATE_INTERNAL_SENTINEL"); }))
      .rejects.toMatchObject({ code: "report_execution_failed", message: "评审报告处理失败，无法继续提交" });
    await expect(report.finish()).rejects.toMatchObject({ code: "report_execution_failed" });
    expect(writes).toBe(0);
  });

  it("并行结论保存失败后，已经发生的接受与拒绝回执仍完整落库", async () => {
    const saving = deferred();
    const release = deferred();
    const submissions: ReportSubmission[] = [];
    const report = new ReviewReport(files, async () => {
      saving.resolve();
      await release.promise;
      throw new Error("PRIVATE_STORAGE_SENTINEL");
    }, async (submission) => { submissions.push(submission); });
    await report.submitFileGroups({ fileGroups: makeMockFileGroups() });
    const pendingFinding = report.submitFinding(async () => candidate);
    await saving.promise;
    const accepted: ReportSubmission = { phase: "generator", tool: "report_file_groups", outcome: "accepted", code: null, reason: null };
    const rejected: ReportSubmission = { phase: "generator", tool: "report_finding", outcome: "rejected", code: "invalid_finding", reason: "缺少证据" };
    report.recordSubmission(accepted);
    report.recordSubmission(rejected);
    release.resolve();
    await expect(pendingFinding).rejects.toMatchObject({ code: "finding_write_failed" });
    await expect(report.settled()).rejects.toMatchObject({ code: "finding_write_failed" });
    expect(submissions).toEqual([accepted, rejected]);
  });

  it("一条提交记录写入失败后继续保存后续回执，并在排空时报告故障", async () => {
    const submissions: ReportSubmission[] = [];
    let writes = 0;
    const report = new ReviewReport(files, async () => {}, async (submission) => {
      if (++writes === 1) throw new Error("PRIVATE_STORAGE_SENTINEL");
      submissions.push(submission);
    });
    const rejected: ReportSubmission = { phase: "generator", tool: "report_finding", outcome: "rejected", code: "invalid_finding", reason: "缺少证据" };
    const accepted: ReportSubmission = { phase: "generator", tool: "report_file_groups", outcome: "accepted", code: null, reason: null };
    report.recordSubmission(rejected);
    report.recordSubmission(accepted);
    await expect(report.settled()).rejects.toMatchObject({ code: "report_submission_write_failed" });
    expect(submissions).toEqual([accepted]);
    expect(writes).toBe(2);
  });
});
