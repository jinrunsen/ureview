import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withIdentity } from "../auth/context.js";
import { withTeam } from "../db/tenant.js";
import { publicAddress, validateWebhookUrl } from "./webhook.js";
import { createCollaborationFixture } from "./test-support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(options: Parameters<typeof createCollaborationFixture>[0] = {}) {
  const value = await createCollaborationFixture(options); cleanups.push(() => value.close()); return value;
}

describe("Finding 讨论与通知", () => {
  it("HTTP 创建和回复持久保存，重复提交不重复通知，已读仅影响本人", async () => {
    const f = await fixture();
    const input = { requestId: randomUUID(), body: "请核对边界", mentions: [f.bob.userId, f.alice.userId] };
    const first = await f.app.inject({ method: "POST", url: f.route, payload: input });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().comment.id;
    const repeated = await f.app.inject({ method: "POST", url: f.route, payload: input });
    expect(repeated.statusCode).toBe(200); expect(repeated.json().comment.id).toBe(firstId);
    expect((await f.app.inject("/api/collaboration/unread")).json().count).toBe(0);
    expect((await f.app.inject({ url: "/api/collaboration/unread", headers: { "x-fixture-user": "bob" } })).json().count).toBe(1);
    const reply = await f.app.inject({ method: "POST", url: f.route, headers: { "x-fixture-user": "bob" }, payload: { requestId: randomUUID(), body: "确认需要修复", parentId: firstId } });
    expect(reply.statusCode).toBe(201);
    const listed = (await f.app.inject(f.route)).json(); expect(listed.comments).toHaveLength(2);
    expect(listed.comments[1].parentId).toBe(firstId);
    const foreignRead = await f.app.inject({ method: "POST", url: `${f.route}/read`, headers: { "x-fixture-user": "bob" }, payload: { ids: listed.unreadIds } });
    expect(foreignRead.statusCode).toBe(200);
    expect((await f.app.inject("/api/collaboration/unread")).json().count).toBe(1);
    await f.app.inject({ method: "POST", url: `${f.route}/read`, payload: { ids: listed.unreadIds } });
    expect((await f.app.inject("/api/collaboration/unread")).json().count).toBe(0);
  });

  it("拒绝跨 Finding 回复、跨团队提醒与修改幂等提交内容", async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const original = (await f.app.inject({ method: "POST", url: f.route, payload: { requestId, body: "原文" } })).json().comment;
    expect((await f.app.inject({ method: "POST", url: f.route, payload: { requestId, body: "改文" } })).statusCode).toBe(409);
    expect((await f.app.inject({ method: "POST", url: f.route, payload: { requestId: randomUUID(), body: "提醒", mentions: [f.outsider.userId] } })).statusCode).toBe(400);
    const secondRoute = `/api/reviews/${f.secondReviewId}/findings/${f.secondFindingId}/comments`;
    expect((await f.app.inject({ method: "POST", url: secondRoute, payload: { requestId: randomUUID(), body: "越界回复", parentId: original.id } })).statusCode).toBe(400);
    expect((await f.app.inject({ url: f.route, headers: { "x-fixture-user": "outsider" } })).statusCode).toBe(404);
    await withTeam(f.outsider.teamId, async () => {
      expect((await f.pool.query("SELECT * FROM discussion_comments")).rows).toHaveLength(0);
      await expect(f.pool.query("INSERT INTO discussion_comments(id,review_id,finding_id,author_id,request_id,body) VALUES($1,$2,$3,$4,$5,'越界')", [randomUUID(), f.reviewId, f.findingId, f.outsider.userId, randomUUID()])).rejects.toThrow();
    });
    expect((await f.app.inject({ url: "/api/collaboration/members", headers: { "x-fixture-user": "outsider" } })).json().members.map((member: { id: string }) => member.id)).toEqual([f.outsider.userId]);
  });

  it("每人查看和看完状态独立，取消看完保留查看记录", async () => {
    const f = await fixture();
    await withIdentity(f.alice, () => f.service.markViewed(f.reviewId));
    const url = `/api/reviews/${f.reviewId}/participation`;
    await f.app.inject({ method: "PUT", url, payload: { completed: true } });
    const bob = (await f.app.inject({ method: "GET", url, headers: { "x-fixture-user": "bob" } })).json();
    expect(bob.currentUserId).toBe(f.bob.userId); expect(bob.participants[0].completedAt).toBeTypeOf("string");
    expect(bob.participants.some((person: { userId: string }) => person.userId === f.bob.userId)).toBe(false);
    const cleared = (await f.app.inject({ method: "PUT", url, payload: { completed: false } })).json();
    expect(cleared.participants[0]).toMatchObject({ userId: f.alice.userId, completedAt: null });
    expect(cleared.participants[0].viewedAt).toBeTypeOf("string");
  });

  it("尚未完成或失败的评审不能提前标记已读或看完", async () => {
    const f = await fixture();
    for (const status of ["queued", "running", "failed"]) {
      await withTeam(f.alice.teamId, () => f.pool.query("UPDATE reviews SET status=$2 WHERE id=$1", [f.reviewId, status]));
      const response = await f.app.inject({ method: "PUT", url: `/api/reviews/${f.reviewId}/participation`, payload: { completed: true } });
      expect(response.statusCode).toBe(409);
      await expect(withIdentity(f.alice, () => f.service.markViewed(f.reviewId))).rejects.toThrow("评审完成后");
      expect((await f.app.inject(`/api/reviews/${f.reviewId}/participation`)).json().participants).toHaveLength(0);
      await withTeam(f.alice.teamId, async () => { expect((await f.pool.query("SELECT viewed_at FROM reviews WHERE id=$1", [f.reviewId])).rows[0].viewed_at).toBeNull(); });
    }
  });

  it("平台历史只读显示，读取失败不影响站内讨论", async () => {
    const history = { getDiscussions: vi.fn().mockResolvedValue([{ id: "upstream-thread", resolved: false, notes: [{ id: "1", author: "平台用户", body: "历史意见", createdAt: "2026-10-04T00:00:00Z", url: "https://gitlab.example.test/a/-/merge_requests/1#note_1" }] }]) };
    const f = await fixture({ history });
    await f.app.inject({ method: "POST", url: f.route, payload: { requestId: randomUUID(), body: "本地讨论" } });
    expect((await f.app.inject(`/api/reviews/${f.reviewId}/platform-discussions`)).json().discussions).toHaveLength(1);
    history.getDiscussions.mockRejectedValue(new Error("上游故障"));
    expect((await f.app.inject(`/api/reviews/${f.reviewId}/platform-discussions`)).json().error).toContain("无法读取");
    expect((await f.app.inject(f.route)).json().comments).toHaveLength(1);
  });

  it("管理员配置通知出口，队列失败重试有上限且评论已成功", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("故障不回传敏感地址"));
    const f = await fixture({ transport });
    expect((await f.app.inject({ method: "PUT", url: "/api/notification-settings", headers: { "x-fixture-user": "bob" }, payload: { endpoint: "https://notify.example.test/hook" } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "PUT", url: "/api/notification-settings", payload: { endpoint: "https://127.0.0.1/hook" } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "PUT", url: "/api/notification-settings", payload: { endpoint: "https://notify.example.test/hook" } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url: f.route, payload: { requestId: randomUUID(), body: "请查看", mentions: [f.bob.userId] } })).statusCode).toBe(201);
    await withTeam(f.alice.teamId, async () => { for (let i = 0; i < 5; i++) await f.service.deliverNext(); });
    expect(transport).toHaveBeenCalledTimes(4);
    expect((await f.app.inject("/api/notification-settings")).json().deliveries.failed).toBe(1);
    expect((await f.app.inject(f.route)).json().comments).toHaveLength(1);
  });

  it("并发投递只领取一次，关闭出口取消排队通知，默认不建立出口", async () => {
    const transport = vi.fn().mockResolvedValue(undefined);
    const f = await fixture({ transport });
    const post = () => f.app.inject({ method: "POST", url: f.route, payload: { requestId: randomUUID(), body: "请查看", mentions: [f.bob.userId] } });
    await post();
    expect((await f.app.inject("/api/notification-settings")).json()).toEqual({ endpoint: null, deliveries: {} });
    await f.app.inject({ method: "PUT", url: "/api/notification-settings", payload: { endpoint: "https://notify.example.test/hook" } });
    await post();
    await withTeam(f.alice.teamId, () => Promise.all([f.service.deliverNext(), f.service.deliverNext()]));
    expect(transport).toHaveBeenCalledTimes(1);
    await post();
    await f.app.inject({ method: "PUT", url: "/api/notification-settings", payload: { endpoint: null } });
    await withTeam(f.alice.teamId, () => f.service.deliverNext());
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await f.app.inject("/api/notification-settings")).json().deliveries.cancelled).toBe(1);
  });
});

describe("通知地址边界", () => {
  it("拒绝本地和特殊用途地址，仅接受公网 HTTPS", () => {
    for (const address of ["127.0.0.1", "10.2.3.4", "192.168.1.2", "169.254.169.254", "100.64.0.1", "198.18.0.1", "::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1"]) expect(publicAddress(address)).toBe(false);
    expect(publicAddress("8.8.8.8")).toBe(true); expect(publicAddress("2606:4700:4700::1111")).toBe(true);
    for (const endpoint of ["http://example.com", "https://localhost", "https://user:pass@example.com", "https://example.com:8443", "https://[::1]"]) expect(() => validateWebhookUrl(endpoint)).toThrow();
    expect(validateWebhookUrl("https://notifications.example.com/hook").hostname).toBe("notifications.example.com");
  });
});
