import { afterEach, describe, expect, it, vi } from "vitest";
import { batchReviewTargets, reviewRuleProposalBatch, type ProposalBatchResult, type RuleProposal } from "./rule-proposals-api";

function proposal(id: string, changes: Partial<RuleProposal> = {}): RuleProposal {
  return { id, name: `规范 ${id}`, body: "金额以整数分存储和计算。", source: "generation", status: "pending",
    managedRuleId: `rule-${id}`, ruleId: `managed:rule-${id}`, repositoryId: null, reasonCategory: null,
    feedbackCount: 0, feedback: [], candidate: null, createdAt: "2026-10-06T08:00:00Z", reviewedAt: null,
    reviewedBy: null, rejectionReason: null, ...changes };
}
function accepted(value: RuleProposal) { return new Response(JSON.stringify({ proposal: { ...value, status: "accepted" } })); }
function pendingResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => vi.restoreAllMocks());

describe("提案批量审核", () => {
  it("逐条发送请求，失败后继续，并保留每一项的结果", async () => {
    const values = [proposal("one"), proposal("two"), proposal("three")];
    const first = pendingResponse();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "提案状态已更新" } }), { status: 409 }))
      .mockResolvedValueOnce(accepted(values[2]));
    const results: ProposalBatchResult[] = [];
    const running = reviewRuleProposalBatch(values, { status: "accepted" }, (result) => results.push(result), new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results).toEqual([]);
    first.resolve(accepted(values[0]));
    await running;
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(values.map((value) => `/api/rule-proposals/${value.id}/review`));
    expect(results).toMatchObject([
      { id: "one", proposal: { status: "accepted" } }, { id: "two", error: "提案状态已更新" }, { id: "three", proposal: { status: "accepted" } },
    ]);
    expect(fetch.mock.calls.every(([, init]) => init?.body === JSON.stringify({ status: "accepted" }))).toBe(true);
  });

  it("批量采纳保留需编辑的工作台反馈，且不再次审核已经完成的提案", async () => {
    const values = [proposal("draft"), proposal("feedback", { source: "feedback" }), proposal("git-feedback", { source: "feedback", managedRuleId: null }), proposal("done", { status: "accepted" }), proposal("withdrawn", { status: "withdrawn" })];
    expect(batchReviewTargets(values, "accepted").map((value) => value.id)).toEqual(["draft", "git-feedback"]);
    expect(batchReviewTargets(values, "rejected").map((value) => value.id)).toEqual(["draft", "feedback", "git-feedback"]);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(accepted(values[0])).mockResolvedValueOnce(accepted(values[2]));
    await reviewRuleProposalBatch(values, { status: "accepted" }, () => {}, new AbortController().signal);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/api/rule-proposals/draft/review", "/api/rule-proposals/git-feedback/review"]);
    expect(fetch.mock.calls.every(([, init]) => !Object.hasOwn(JSON.parse(String(init?.body)), "rule"))).toBe(true);
  });

  it("批量拒绝包含工作台反馈，每一项使用去除首尾空白的共同理由", async () => {
    const values = [proposal("draft"), proposal("feedback", { source: "feedback" })];
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ proposal: { ...values[0], status: "rejected" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ proposal: { ...values[1], status: "rejected" } })));
    await reviewRuleProposalBatch(values, { status: "rejected", reason: "  已有规范覆盖。\n" }, () => {}, new AbortController().signal);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { status: "rejected", reason: "已有规范覆盖。" }, { status: "rejected", reason: "已有规范覆盖。" },
    ]);
  });

  it.each([undefined, "   ", "字".repeat(2001)])("共同理由缺失、空白或过长时不发送审核请求", async (reason) => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(reviewRuleProposalBatch([proposal("one")], { status: "rejected", reason }, () => {}, new AbortController().signal)).rejects.toThrow("拒绝理由需为");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("离开页面或切换筛选后停止后续请求", async () => {
    const controller = new AbortController(); const values = [proposal("one"), proposal("two")];
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(accepted(values[0]));
    const results: ProposalBatchResult[] = [];
    await reviewRuleProposalBatch(values, { status: "accepted" }, (result) => { results.push(result); controller.abort(); }, controller.signal);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results).toMatchObject([{ id: "one", proposal: { status: "accepted" } }]);
  });

  it("在请求期间离开页面，不把迟到结果写回界面或继续审核", async () => {
    const controller = new AbortController(); const first = pendingResponse(); const onResult = vi.fn();
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValueOnce(first.promise);
    const running = reviewRuleProposalBatch([proposal("one"), proposal("two")], { status: "accepted" }, onResult, controller.signal);
    controller.abort(); first.resolve(accepted(proposal("one"))); await running;
    expect(fetch).toHaveBeenCalledTimes(1); expect(onResult).not.toHaveBeenCalled();
  });
});
