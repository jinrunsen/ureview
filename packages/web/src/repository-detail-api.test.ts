import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRepositoryWebhook, deleteRepository, getRepositoryDeletionPreview, getRepositoryEvents, saveAutomaticReview } from "./repository-detail-api";

const repository = { id: "payment-gateway", instanceUrl: "https://gitlab.example.com", projectId: 42, name: "支付网关", pathWithNamespace: "commerce/payment-gateway", webUrl: "https://gitlab.example.com/commerce/payment-gateway", connectionStatus: "connected", connectedAt: "2026-10-06T00:00:00Z", automaticReviewEnabled: false, automaticReviewVersion: 2, lastAuthenticationFailureAt: null };
const webhook = { url: "https://review.example.com/api/repositories/payment-gateway/events/gitlab", tokenConfigured: true, lastAuthenticationFailureAt: null };
const preview = { repositoryId: repository.id, pathWithNamespace: repository.pathWithNamespace, counts: { reviews: 3, findings: 7, discussionComments: 2, agentSessions: 6, webhookEvents: 4, repositoryRules: 2, historicalCandidates: 1, managedRules: 1 }, runningReviews: 0 };
function respond(value: unknown, status = 200) { return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(value), { status })); }
afterEach(() => vi.restoreAllMocks());

describe("仓库详情 API 契约", () => {
  it("自动评审保存携带已读取的版本并保留冲突原因", async () => {
    const fetch = respond({ repository });
    expect(await saveAutomaticReview(repository.id, false, 1)).toEqual(repository);
    expect(fetch).toHaveBeenCalledWith(`/api/repositories/${repository.id}/automatic-review`, expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: false, version: 1 }) }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "automatic_review_conflict", message: "配置已被其他管理员更新" } }), { status: 409 }));
    await expect(saveAutomaticReview(repository.id, true, 1)).rejects.toMatchObject({ name: "Error", message: "配置已被其他管理员更新", status: 409, code: "automatic_review_conflict" });
  });
  it("事件可关联评审轮次并拒绝不完整字段", async () => {
    const event = { id: "delivery-payment", receivedAt: "2026-10-06T00:00:00Z", eventType: "merge_request", action: "open", iid: 7, result: "queued", reason: null, reviewId: "payment-review", reviewRound: 2 };
    const fetch = respond({ webhook, events: [event] });
    expect((await getRepositoryEvents(repository.id)).events[0]?.reviewRound).toBe(2);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ webhook, events: [{ ...event, reviewRound: "2" }] })));
    await expect(getRepositoryEvents(repository.id)).rejects.toThrow("服务返回的数据不完整");
  });
  it("权限不足的检测保留不可读状态与说明", async () => {
    const check = { status: "unreadable", message: "无法读取 webhook 配置，请在 GitLab 中使用测试功能。", checkedAt: "2026-10-06T00:00:00Z" };
    const fetch = respond({ check });
    expect(await checkRepositoryWebhook(repository.id)).toEqual(check);
    expect(fetch).toHaveBeenCalledWith(`/api/repositories/${repository.id}/webhook-check`, expect.objectContaining({ method: "POST" }));
  });
  it("删除预览读取完整的数量并拒绝缺失或非法计数", async () => {
    const fetch = respond({ preview });
    expect(await getRepositoryDeletionPreview(repository.id)).toEqual(preview);
    expect(fetch).toHaveBeenCalledWith(`/api/repositories/${repository.id}/deletion-preview`, expect.any(Object));
    for (const counts of [{ ...preview.counts, managedRules: undefined }, { ...preview.counts, reviews: -1 }, { ...preview.counts, findings: 1.5 }]) {
      fetch.mockResolvedValueOnce(new Response(JSON.stringify({ preview: { ...preview, counts } })));
      await expect(getRepositoryDeletionPreview(repository.id)).rejects.toThrow("服务返回的数据不完整");
    }
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ preview: { ...preview, runningReviews: "1" } })));
    await expect(getRepositoryDeletionPreview(repository.id)).rejects.toThrow("服务返回的数据不完整");
  });
  it("删除保留用户输入的完整路径并验证服务端删除结果", async () => {
    const fetch = respond({ deleted: true, preview });
    const pathWithNamespace = ` ${repository.pathWithNamespace} `;
    expect(await deleteRepository(repository.id, pathWithNamespace)).toEqual({ deleted: true, preview });
    expect(fetch).toHaveBeenCalledWith(`/api/repositories/${repository.id}`, expect.objectContaining({ method: "DELETE", body: JSON.stringify({ pathWithNamespace }) }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ deleted: false, preview })));
    await expect(deleteRepository(repository.id, repository.pathWithNamespace)).rejects.toThrow("服务返回的数据不完整");
  });
  it("删除时保留进行中评审的冲突提示", async () => {
    respond({ error: { code: "repository_review_running", message: "仓库有进行中的评审，请等待结束后再删除。" } }, 409);
    await expect(deleteRepository(repository.id, repository.pathWithNamespace)).rejects.toMatchObject({ status: 409, code: "repository_review_running", message: "仓库有进行中的评审，请等待结束后再删除。" });
  });
});
