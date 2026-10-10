import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { ReviewScenario } from "./review-scenario.js";
import type { NotificationKind } from "../../packages/server/src/collaboration/messages.js";

export interface ReceivedNotification { kind: string; body: Record<string, unknown>; query: Record<string, string>; receivedAt: number }
export class ImPushScenario {
  readonly review = new ReviewScenario();
  readonly platform = Fastify();
  readonly received: ReceivedNotification[] = [];
  reject = false;
  async start() {
    this.platform.post<{ Params: { kind: string }; Body: Record<string, unknown>; Querystring: Record<string, string> }>("/:kind", async (request) => {
      this.received.push({ kind: request.params.kind, body: request.body, query: request.query, receivedAt: Date.now() });
      return request.params.kind === "feishu" ? { code: this.reject ? 19024 : 0 } : { errcode: this.reject ? 45009 : 0 };
    });
    const address = await this.platform.listen({ host: "127.0.0.1", port: 0 });
    await this.review.start({ disposition: true, notifications: { transport: async (endpoint, payload, id) => {
      const target = new URL(endpoint);
      assert.equal(target.hostname, "notifications.example.test");
      const response = await fetch(`${address}${target.pathname}${target.search}`, { method: "POST", headers: { "content-type": "application/json", "x-ureview-delivery": id }, body: JSON.stringify(payload) });
      assert.equal(response.status, 200);
      return response.json();
    } } });
    await this.review.connect("payment-gateway");
  }
  async configure(kinds: NotificationKind[]) {
    for (const kind of kinds) {
      const response = await this.review.request("/api/notification-endpoints", { name: `库存研发群 ${kind}`, kind, endpoint: `https://notifications.example.test/${kind}?token=private-hook-token`, ...(kind === "feishu" || kind === "dingtalk" ? { secret: `${kind}-signing-key` } : {}) });
      assert.equal(response.status, 201);
      assert.ok(!JSON.stringify(response.body).includes("private-hook-token"));
      assert.ok(!JSON.stringify(response.body).includes("signing-key"));
    }
  }
  async linkIdentity() {
    this.review.gitlab.state.reviewers = ["zhangwei"];
    const response = await this.review.request("/api/account/identities", {
      gitlab: [{ instanceUrl: this.review.gitlab.input.instanceUrl, username: "zhangwei" }], mobile: "13800138000", feishuOpenId: "ou_zhangwei", feishuUserId: null,
    }, {}, "PUT");
    assert.equal(response.status, 200);
  }
  async finishReview() {
    await this.review.openPullRequest("李娜", "修复库存预留的重复释放");
    await this.review.waitForReview((review) => review.status === "completed");
  }
  async waitFor(predicate: () => boolean, timeout = 25_000) {
    const end = Date.now() + timeout;
    while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(predicate(), "未在限定时间内收到机器人投递");
  }
  verifySignatures() {
    const feishu = this.received.find((message) => message.kind === "feishu"); assert.ok(feishu);
    const seconds = String(feishu.body.timestamp); assert.equal(seconds.length, 10);
    assert.equal(feishu.body.sign, createHmac("sha256", `${seconds}\nfeishu-signing-key`).update("").digest("base64"));
    const dingtalk = this.received.find((message) => message.kind === "dingtalk"); assert.ok(dingtalk);
    const millis = dingtalk.query.timestamp!; assert.equal(millis.length, 13);
    assert.equal(dingtalk.query.sign, createHmac("sha256", "dingtalk-signing-key").update(`${millis}\ndingtalk-signing-key`).digest("base64"));
  }
  async close() { try { await this.review.stop(); } finally { await this.platform.close(); } }
}
