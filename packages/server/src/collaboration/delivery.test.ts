import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTeam } from "../db/tenant.js";
import { ReviewStore } from "../reviews/store.js";
import { enqueueNotification, type NotificationPayload } from "./notifications.js";
import { createCollaborationFixture } from "./test-support.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(options: Parameters<typeof createCollaborationFixture>[0] = {}) { const f = await createCollaborationFixture(options); cleanups.push(f.close); return f; }

describe("多出口通知投递", () => {
  it("地址与密钥加密保存并只返回掩码，更新可保留或移除密钥，配置受团队权限限制", async () => {
    const f = await fixture();
    const input = { name: "库存研发飞书", kind: "feishu", endpoint: "https://open.feishu.cn/open-apis/bot/v2/hook/private-token", secret: "private-signing-key" };
    const created = await f.app.inject({ method: "POST", url: "/api/notification-endpoints", payload: input });
    expect(created.statusCode).toBe(201); const id = created.json().id;
    expect(created.body).not.toContain("private-token"); expect(created.body).not.toContain("private-signing-key");
    await withTeam(f.alice.teamId, async () => {
      const stored = (await f.pool.query("SELECT * FROM notification_endpoints WHERE id=$1", [id])).rows[0];
      expect(stored.endpoint_ciphertext.includes(Buffer.from("private-token"))).toBe(false);
      expect(stored.secret_ciphertext.includes(Buffer.from("private-signing-key"))).toBe(false);
    });
    expect((await f.app.inject({ method: "PATCH", url: `/api/notification-endpoints/${id}`, payload: { name: "库存告警" } })).json().secret).toBe("••••••••");
    expect((await f.app.inject({ method: "PATCH", url: `/api/notification-endpoints/${id}`, payload: { secret: null } })).json().secret).toBeNull();
    expect((await f.app.inject({ url: "/api/notification-endpoints", headers: { "x-fixture-user": "bob" } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: "/api/notification-endpoints", headers: { "x-fixture-user": "outsider" } })).json().endpoints).toEqual([]);
    expect((await f.app.inject({ method: "DELETE", url: `/api/notification-endpoints/${id}`, headers: { "x-fixture-user": "outsider" } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "POST", url: "/api/notification-endpoints", payload: { ...input, endpoint: "https://127.0.0.1/hook" } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "DELETE", url: `/api/notification-endpoints/${id}` })).statusCode).toBe(200);
  });

  it("评审完成为每个出口创建一次投递，作者和评审人按实例关联并排除其他团队", async () => {
    const transport = vi.fn().mockResolvedValue({ errcode: 0, code: 0 });
    const f = await fixture({ transport });
    for (const kind of ["wecom", "feishu", "dingtalk"]) expect((await f.app.inject({ method: "POST", url: "/api/notification-endpoints", payload: { name: kind, kind, endpoint: `https://notify.example.test/${kind}` } })).statusCode).toBe(201);
    await withTeam(f.alice.teamId, async () => {
      await f.pool.query("INSERT INTO auth_gitlab_identities(user_id,instance_url,username) VALUES($1,'https://gitlab.example.test','author'),($2,'https://gitlab.example.test','reviewer'),($3,'https://gitlab.example.test','outsider')", [f.alice.userId, f.bob.userId, f.outsider.userId]);
      await f.pool.query("UPDATE auth_users SET im_mobile='13800138000' WHERE id=$1", [f.alice.userId]);
      await f.pool.query(`UPDATE reviews SET pull_request=$2 WHERE id=$1`, [f.reviewId, { reviewers: ["reviewer", "OUTSIDER"], assignees: ["unlinked"] }]);
      await f.pool.query(`INSERT INTO reading_documents(id,review_id,status,content,completed_at) VALUES($1,$2,'completed',$3,clock_timestamp())`, [randomUUID(), f.reviewId,
        { outline: [], sections: { summary: "<p>本轮为<strong>库存恢复</strong>增加幂等保护。第二句不推送。</p>" }, excerpts: {} }]);
      const store = new ReviewStore(f.pool);
      await store.skip(f.reviewId, "全部变更已排除"); await store.skip(f.reviewId, "全部变更已排除");
      const queued = (await f.pool.query("SELECT payload FROM notification_deliveries")).rows;
      expect(queued).toHaveLength(3);
      expect(queued[0].payload.recipients.map((recipient: { userId: string }) => recipient.userId).sort()).toEqual([f.alice.userId, f.bob.userId].sort());
      expect(queued[0].payload.readingSummary).toBe("本轮为库存恢复增加幂等保护。");
      expect(queued[0].payload.conclusion.status).toBe("no_major_findings");
      for (let i = 0; i < 3; i++) await f.service.deliverNext();
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect((await f.app.inject("/api/notification-settings")).json().deliveries.delivered).toBe(3);
  });

  it("提及和回复各自入队，HTTP成功中的业务错误在第四次后失败", async () => {
    const transport = vi.fn().mockResolvedValue({ errcode: 45009 });
    const f = await fixture({ transport });
    await f.app.inject({ method: "POST", url: "/api/notification-endpoints", payload: { name: "企业微信库存群", kind: "wecom", endpoint: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=private" } });
    const first = await f.app.inject({ method: "POST", url: f.route, payload: { requestId: randomUUID(), body: "请确认库存边界", mentions: [f.bob.userId] } });
    await f.app.inject({ method: "POST", url: f.route, headers: { "x-fixture-user": "bob" }, payload: { requestId: randomUUID(), body: "确认需要修改", parentId: first.json().comment.id } });
    await withTeam(f.alice.teamId, async () => { for (let i = 0; i < 9; i++) await f.service.deliverNext(); });
    expect(transport).toHaveBeenCalledTimes(8);
    expect((await f.app.inject("/api/notification-settings")).json().deliveries.failed).toBe(2);
    expect((await f.app.inject(f.route)).json().comments).toHaveLength(2);
  });

  it("并发工作者按出口串行领取，三秒窗口内第二条消息仍在排队", async () => {
    const transport = vi.fn().mockResolvedValue({ errcode: 0 });
    const f = await fixture({ transport, deliveryIntervalMs: 3000 });
    await f.app.inject({ method: "POST", url: "/api/notification-endpoints", payload: { name: "库存研发群", kind: "wecom", endpoint: "https://notify.example.test/hook" } });
    for (let i = 0; i < 2; i++) await f.app.inject({ method: "POST", url: f.route, payload: { requestId: randomUUID(), body: `请确认库存边界 ${i + 1}`, mentions: [f.bob.userId] } });
    await withTeam(f.alice.teamId, async () => {
      await Promise.all([f.service.deliverNext(), f.service.deliverNext()]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(await f.service.deliverNext()).toBe(false);
      const interval = (await f.pool.query("SELECT next_send_at >= d.delivered_at + interval '3 seconds' AS spaced FROM notification_endpoints e JOIN notification_deliveries d ON d.endpoint_id=e.id WHERE d.status='delivered'")).rows;
      expect(interval).toEqual([{ spaced: true }]);
      await f.pool.query("UPDATE notification_endpoints SET next_send_at=now()-interval '1 second'");
      expect(await f.service.deliverNext()).toBe(true);
    });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("旧出口与排队消息迁入加密配置，原明文被清空且迁移可重复", async () => {
    const transport = vi.fn().mockResolvedValue(null);
    const f = await fixture({ transport });
    const posted = await f.app.inject({ method: "POST", url: f.route, payload: { requestId: randomUUID(), body: "确认库存边界", mentions: [f.bob.userId] } });
    const oldPayload = { type: "discussion", reviewId: f.reviewId, findingId: f.findingId, commentId: posted.json().comment.id, author: { id: f.alice.userId, name: f.alice.name }, body: "确认库存边界", recipients: [{ userId: f.bob.userId, reason: "mention" }] };
    await withTeam(f.alice.teamId, async () => {
      await f.pool.query("INSERT INTO notification_settings(endpoint) VALUES('https://notify.example.test/hook?token=legacy-token')");
      await f.pool.query("INSERT INTO notification_deliveries(id,comment_id,payload) VALUES($1,$2,$3)", [randomUUID(), oldPayload.commentId, oldPayload]);
    });
    await f.service.migrateLegacySettings(); await f.service.migrateLegacySettings();
    const settings = (await f.app.inject("/api/notification-settings")).json();
    expect(settings.endpoint).toBe("••••••••");
    await withTeam(f.alice.teamId, async () => {
      expect((await f.pool.query("SELECT endpoint FROM notification_settings")).rows[0].endpoint).toBeNull();
      expect((await f.pool.query("SELECT * FROM notification_endpoints")).rows).toHaveLength(1);
    });
    await withTeam(f.alice.teamId, () => f.service.deliverNext());
    expect(transport.mock.calls[0]?.[0]).toBe("https://notify.example.test/hook?token=legacy-token");
    expect(transport.mock.calls[0]?.[1]).toMatchObject(oldPayload);
    expect((await f.app.inject("/api/notification-settings")).json().deliveries.delivered).toBe(1);
  });
  it("超过百人的机器人提醒分批且收件人无遗漏，通用出口保留一条完整事件", async () => {
    const transport = vi.fn().mockResolvedValue({ code: 0 });
    const f = await fixture({ transport });
    for (const kind of ["feishu", "webhook"]) await f.app.inject({ method: "POST", url: "/api/notification-endpoints", payload: { name: `库存通知 ${kind}`, kind, endpoint: `https://notify.example.test/${kind}` } });
    const recipients = Array.from({ length: 121 }, (_, index) => ({ userId: randomUUID(), name: "张伟", mobile: null, feishuOpenId: `ou_${"a".repeat(115)}${index}`, feishuUserId: null }));
    const payload: NotificationPayload = { type: "review_completed", reviewId: f.reviewId, title: "库存预留", repository: "commerce/inventory", recipients, readingSummary: "\\".repeat(20000) };
    await withTeam(f.alice.teamId, async () => {
      const client = await f.pool.connect();
      try { await client.query("BEGIN"); await enqueueNotification(client, payload); await enqueueNotification(client, payload); await client.query("COMMIT"); } finally { client.release(); }
      const batches = (await f.pool.query("SELECT e.kind,d.batch_index,d.payload FROM notification_deliveries d JOIN notification_endpoints e ON e.id=d.endpoint_id ORDER BY e.kind,d.batch_index")).rows;
      expect(batches).toHaveLength(4);
      expect(batches.filter((row) => row.kind === "feishu").map((row) => row.payload.recipients.length)).toEqual([50, 50, 21]);
      expect(batches.filter((row) => row.kind === "feishu").flatMap((row) => row.payload.recipients.map((recipient: { userId: string }) => recipient.userId))).toEqual(recipients.map((recipient) => recipient.userId));
      expect(batches.find((row) => row.kind === "webhook")?.payload.recipients).toHaveLength(121);
      for (let i = 0; i < 4; i++) await f.service.deliverNext();
    });
    const bots = transport.mock.calls.filter((call) => String(call[0]).endsWith("/feishu"));
    expect(bots).toHaveLength(3);
    const seen: string[] = [];
    for (const call of bots) {
      expect(Buffer.byteLength(JSON.stringify(call[1]))).toBeLessThanOrEqual(20_000);
      const body = call[1] as { content: { post: { zh_cn: { content: Array<Array<{ tag: string; user_id?: string }>> } } } };
      seen.push(...body.content.post.zh_cn.content.flat().flatMap((item) => item.tag === "at" && item.user_id ? [item.user_id] : []));
    }
    expect(seen.sort()).toEqual(recipients.map((recipient) => recipient.feishuOpenId).sort());
  });

});
