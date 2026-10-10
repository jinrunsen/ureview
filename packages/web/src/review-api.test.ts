import { afterEach, describe, expect, it, vi } from "vitest";
import { getReview, listReviewRounds, listReviews, markReviewViewed, rerunReview, setFindingDisposition, startReview, mergeFindingDisposition } from "./review-api";

const summary = {
  id: "review-one", repositoryId: "repository-one", repositoryName: "commerce/payment-gateway", iid: 7,
  title: "修复库存释放", author: "李娜", headSha: "a".repeat(40), status: "completed", statusMessage: null,
  failureReason: null, createdAt: "2026-10-03T00:00:00Z", completedAt: "2026-10-03T00:01:00Z",
  round: 2, trigger: "manual", viewedAt: null, findingCounts: { high: 1, medium: 0 },
};
const range = { path: "internal/inventory/release.go", startLine: 3, endLine: 4 };
const model = { provider: "fixture", vendor: "fixture-vendor", model: "fixture-model" };
const finding = {
  id: "finding-one", title: "库存释放缺少锁", description: "并发释放可能覆盖库存", severity: "high", location: range,
  anchor: { ...range, side: "new", fingerprint: "b".repeat(64) }, code: "restoreStock(orderID)", evidence: [],
  fixPrompt: "释放前获取锁", ruleId: null, score: 88, generatorModel: model, graderModel: { ...model, vendor: "another-vendor" },
  readFiles: [], generatedAt: "2026-10-03T00:00:30Z", status: "Pending",
};
const detail = { ...summary, conclusion: { status: "requires_changes", findingCounts: { high: 1, medium: 0 }, disposedCount: 0 }, pullRequest: null, findings: [finding], readFiles: [], rules: [], files: [], fileGroups: [], foldedCount: 0 };
const fileGroups = [{ name: "库存释放", files: [{ path: range.path, theme: "释放前加锁" }] }];
function respond(body: unknown) { return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status: 200 })); }
const signal = () => new AbortController().signal;
const disposition = { version: 2, actor: { id: "reviewer-one", name: "李娜" }, updatedAt: "2026-10-06T08:00:00Z", reasonCategory: "other", explanation: "调用方已保证串行" };
afterEach(() => vi.restoreAllMocks());

describe("评审页面 API 契约", () => {
  it("读取服务端结论并拒绝缺失、负数或未知结论", async () => {
    const fetch = respond({ review: detail });
    expect((await getReview(detail.id, signal())).conclusion).toEqual(detail.conclusion);
    for (const conclusion of [undefined, { ...detail.conclusion, status: "mergeable" }, { ...detail.conclusion, disposedCount: -1 }, { ...detail.conclusion, findingCounts: { high: -1, medium: 0 } }]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, conclusion } })));
      await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
    }
  });
  it("迟到的详情响应保留已保存的较新处置，并继续展示跨轮标记", async () => {
    respond({ review: { ...detail, findings: [{ ...finding, comparison: { kind: "new", previousFinding: null } }] } });
    const initial = (await getReview(detail.id, signal())).findings[0]!;
    const saved = { ...initial, status: "Resolved" as const, disposition: { ...disposition, reasonCategory: null, explanation: null } };
    expect(mergeFindingDisposition(saved, initial)).toMatchObject({ status: "Resolved", disposition: { version: 2 }, comparison: initial.comparison });
    const { comparison: _comparison, ...olderResponse } = initial;
    expect(mergeFindingDisposition(saved, olderResponse)).toMatchObject({ status: "Resolved", comparison: initial.comparison });
  });
  it.each(["Pending", "Resolved", "Dismissed", "Ignored", "Outdated"])("读取 finding 的 %s 状态与当前处置", async (status) => {
    respond({ review: { ...detail, findings: [{ ...finding, status, disposition }] } });
    expect((await getReview(detail.id, signal())).findings[0]).toMatchObject({ status, disposition });
  });
  it.each([{ version: -1 }, { reasonCategory: "unknown" }, { actor: { name: "李娜" } }, { updatedAt: 7 }, { explanation: {} }])("拒绝无法展示的处置记录：%j", async (invalid) => {
    respond({ review: { ...detail, findings: [{ ...finding, disposition: { ...disposition, ...invalid } }] } });
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
  });
  it("提交处置版本与理由并读取服务器记录的操作人", async () => {
    const fetch = respond({ finding: { ...finding, status: "Dismissed", disposition } });
    const input = { version: 1, status: "Dismissed" as const, reasonCategory: "other" as const, explanation: "调用方已保证串行" };
    expect(await setFindingDisposition("review/one", "finding/one", input)).toMatchObject({ status: "Dismissed", disposition });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/reviews/review%2Fone/findings/finding%2Fone/disposition");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual(input);
  });
  it("保留旧版本冲突的 HTTP 状态供页面要求刷新", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: "disposition_conflict", message: "处置已被修改" } }), { status: 409 }));
    await expect(setFindingDisposition(detail.id, finding.id, { version: 1, status: "Resolved" }))
      .rejects.toMatchObject({ status: 409, code: "disposition_conflict" });
  });
  it("读取跨轮标记、上一轮处置与本轮未再出现的 finding", async () => {
    const previousFinding = { reviewId: "review-previous", round: 1, findingId: "finding-previous", status: "Dismissed", disposition };
    const comparison = { previousReview: { id: previousFinding.reviewId, round: 1 }, absentFindings: [{ ...finding, id: "finding-absent", status: "Resolved", disposition: { ...disposition, reasonCategory: null, explanation: null } }] };
    respond({ review: { ...detail, comparison, findings: [
      { ...finding, fingerprint: "b".repeat(64), comparison: { kind: "recurring", previousFinding } },
      { ...finding, id: "finding-new", comparison: { kind: "new", previousFinding: null } },
    ] } });
    const result = await getReview(detail.id, signal());
    expect(result.comparison).toEqual(comparison);
    expect(result.findings[0]?.comparison?.previousFinding).toEqual(previousFinding);
    expect(result.findings[1]?.comparison).toEqual({ kind: "new", previousFinding: null });
    expect(result.findings.every((item) => item.status === "Pending")).toBe(true);
  });
  it.each([
    { kind: "new", previousFinding: {} }, { kind: "recurring", previousFinding: null },
    { kind: "recurring", previousFinding: { reviewId: "previous", round: 1, findingId: "old", status: "unknown", disposition: null } },
  ])("拒绝无法对应上一轮的对比标记：%j", async (comparison) => {
    respond({ review: { ...detail, findings: [{ ...finding, comparison }] } });
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
  });
  it("读取成功与失败轮次的报告提交记录，旧记录兼容空列表", async () => {
    const reportSubmissions = [
      { phase: "generator", tool: "report_finding", outcome: "rejected", code: "unread_evidence", reason: "评审结论引用了模型尚未读取的代码" },
      { phase: "generator", tool: "report_finding", outcome: "accepted", code: null, reason: null },
      { phase: "grader", tool: "grade_finding", outcome: "rejected", code: "invalid_score", reason: "评分必须在 0 到 100 之间" },
    ];
    const fetch = respond({ review: { ...detail, reportSubmissions } });
    expect((await getReview(detail.id, signal())).reportSubmissions).toEqual(reportSubmissions);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, status: "failed", reportSubmissions } })));
    expect((await getReview(detail.id, signal())).reportSubmissions).toEqual(reportSubmissions);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: detail })));
    expect((await getReview(detail.id, signal())).reportSubmissions).toEqual([]);
  });
  it.each([
    { phase: "unknown" }, { tool: "read" }, { outcome: "failed" }, { code: 3 }, { reason: {} },
  ])("拒绝不完整的报告提交记录：%j", async (invalid) => {
    const submission = { phase: "generator", tool: "report_finding", outcome: "rejected", code: "unread_evidence", reason: "证据未读取" };
    respond({ review: { ...detail, reportSubmissions: [{ ...submission, ...invalid }] } });
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
  });
  it("读取本轮目录排除快照，旧记录兼容空范围", async () => {
    const scope = { excludedDirectories: ["features/steps"], excludedFileCount: 4 };
    const fetch = respond({ review: { ...detail, scope } });
    expect((await getReview(detail.id, signal())).scope).toEqual(scope);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: detail })));
    expect((await getReview(detail.id, signal())).scope).toEqual({ excludedDirectories: [], excludedFileCount: 0 });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, scope: { ...scope, excludedFileCount: -1 } } })));
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
  });
  it("通过 MR 链接发起首轮评审，网络重试保留请求标识", async () => {
    const fetch = respond({ id: "first-review", created: false });
    const url = "https://gitlab.com/commerce/payment-gateway/-/merge_requests/7";
    const requestId = "a9145d27-4b1b-4112-8e0f-781ec2d3446c";
    fetch.mockRejectedValueOnce(new TypeError("network"));
    await expect(startReview(url, requestId)).rejects.toThrow(/无法连接/);
    expect(await startReview(url, requestId)).toEqual({ id: "first-review", created: false });
    expect(fetch.mock.calls.every((call) => call[0] === "/api/reviews" && call[1]?.method === "POST")).toBe(true);
    expect(fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([{ url, requestId }, { url, requestId }]);
  });
  it("读取文件分组与未完成轮次的空分组，不产生查看写入", async () => {
    const fetch = respond({ review: { ...detail, fileGroups } });
    expect((await getReview(detail.id, signal())).fileGroups).toEqual(fileGroups);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: detail })));
    expect((await getReview(detail.id, signal())).fileGroups).toEqual([]);
  });
  it("旧轮次的综述提交记录仍可读取", async () => {
    const submission = { phase: "generator", tool: "report_overview", outcome: "accepted", code: null, reason: null };
    respond({ review: { ...detail, reportSubmissions: [submission] } });
    expect((await getReview(detail.id, signal())).reportSubmissions).toEqual([submission]);
  });
  it("旧轮缺少代码锚时保留结论和原位置，只归一为空锚", async () => {
    const { anchor: _anchor, ...legacyFinding } = finding;
    respond({ review: { ...detail, findings: [legacyFinding] } });
    const result = await getReview(detail.id, signal());
    expect(result.findings[0]).toEqual({ ...legacyFinding, anchor: null });
    expect(result.findings[0]?.location).toEqual(range);
    expect(result.findings[0]?.code).toBe(finding.code);
    expect(result.fileGroups).toEqual([]);
  });
  it.each([
    { ...detail, fileGroups: null },
    { ...detail, fileGroups: [{ name: "库存释放", files: [{ path: range.path }] }] },
    { ...detail, foldedCount: -1 },
    { ...detail, findings: [{ ...finding, evidence: [{ ...range, description: "释放入口", url: "https://gitlab.example.test/a#L1", code: 42 }] }] },
    { ...detail, findings: [{ ...finding, severity: "low", anchor: null }] },
    { ...detail, findings: [{ ...finding, anchor: { ...finding.anchor, side: "old" } }] },
  ])("拒绝不完整的文件分组、错误计数或不符合显示边界的 finding", async (review) => {
    respond({ review });
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
  });
  it("中危带代码锚，证据保留评审时读取的代码", async () => {
    const evidence = { ...range, description: "释放入口", url: "https://gitlab.example.test/a#L1", code: "restoreStock(orderID)" };
    respond({ review: { ...detail, findings: [{ ...finding, severity: "medium", evidence: [evidence] }] } });
    const result = await getReview(detail.id, signal());
    expect(result.findings[0]?.anchor).toEqual(finding.anchor);
    expect(result.findings[0]?.evidence).toEqual([evidence]);
  });
  it("读取数据库规范版本快照及规则分类，拒绝缺少严重级别的快照", async () => {
    const rule = { id: "managed:inventory-lock", name: "库存释放锁", body: "释放前必须加锁", source: { kind: "generated" },
      file: { kind: "database", ruleId: "inventory-lock", version: 2, scope: "repositories" },
      layer: "language", category: "reliability", severity: "error", goodExample: "withLock(release)", badExample: "release()", matchedPaths: [range.path] };
    const fetch = respond({ review: { ...detail, rules: [rule], findings: [{ ...finding, ruleId: rule.id, ruleCategory: "reliability", ruleSeverity: "error" }] } });
    const result = await getReview(detail.id, signal());
    expect(result.rules).toEqual([rule]);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, rules: [{ ...rule, layer: "unknown" }] } })));
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
    const { layer: _layer, ...legacy } = rule;
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, rules: [legacy] } })));
    expect((await getReview(detail.id, signal())).rules).toEqual([legacy]);
    expect(result.findings[0]?.ruleCategory).toBe("reliability");
    const { severity: _severity, ...incomplete } = rule;
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, rules: [incomplete] } })));
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
  });
  it("保留本轮判断题属性，兼容缺少该属性的历史快照并拒绝非布尔值", async () => {
    const rule = { id: "repository:.agents/rules/naming.md", body: "检查可能的 Mysterious Name", source: { kind: "manual" }, matchedPaths: [range.path],
      file: { kind: "repository", repositoryId: "repository-one", repositoryName: "commerce/inventory", path: ".agents/rules/naming.md", commitSha: "abc", url: "https://example.com/naming.md" } };
    const fetch = respond({ review: { ...detail, rules: [{ ...rule, judgement: true }] } });
    expect((await getReview(detail.id, signal())).rules[0]?.judgement).toBe(true);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, rules: [rule] } })));
    expect((await getReview(detail.id, signal())).rules[0]?.judgement).toBeUndefined();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, rules: [{ ...rule, judgement: false }] } })));
    expect((await getReview(detail.id, signal())).rules[0]?.judgement).toBe(false);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ review: { ...detail, rules: [{ ...rule, judgement: "true" }] } })));
    await expect(getReview(detail.id, signal())).rejects.toThrow(/数据不完整/);
  });
  it("列表传入仓库状态分页条件，并解析总数与轮次", async () => {
    const fetch = respond({ reviews: [summary], total: 41, page: 2, pageSize: 20 });
    expect(await listReviews({ repositoryId: "repository-one", status: "completed", page: 2, pageSize: 20 }, signal()))
      .toMatchObject({ total: 41, page: 2, reviews: [{ round: 2, viewedAt: null, findingCounts: { high: 1, medium: 0 } }] });
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://localhost");
    expect(Object.fromEntries(url.searchParams)).toEqual({ repositoryId: "repository-one", status: "completed", page: "2", pageSize: "20" });
  });
  it("读取历史与显式查看标记使用不同接口，查看写入不带身份", async () => {
    const fetch = respond({ reviews: [summary] });
    await listReviewRounds(summary.repositoryId, summary.iid, signal());
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/repositories/repository-one/pull-requests/7/reviews");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ viewedAt: "2026-10-03T00:02:00Z" })));
    await markReviewViewed(summary.id);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/reviews/review-one/viewed");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).has("content-type")).toBe(false);
  });
  it("重试传递调用方保留的同一重跑标识", async () => {
    const fetch = respond({ reviewId: "review-two", created: false });
    const requestId = "825de72f-7b87-4f83-bdc9-14d1f074d274";
    fetch.mockRejectedValueOnce(new TypeError("network"));
    await expect(rerunReview(summary.id, requestId)).rejects.toThrow(/无法连接/);
    expect(await rerunReview(summary.id, requestId)).toEqual({ reviewId: "review-two", created: false });
    expect(fetch.mock.calls.map((call) => call[1]?.body)).toEqual([JSON.stringify({ requestId }), JSON.stringify({ requestId })]);
  });
});
