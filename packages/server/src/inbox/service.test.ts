import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { IdentityScenario, fixtureRepository } from "../auth/test-support.js";
import { DEFAULT_TEAM_ID, withTeam } from "../db/tenant.js";
import type { Inbox, InboxNotification } from "./service.js";
import { readingFirstSentence } from "./service.js";

let app: IdentityScenario;
let repositoryId: string;
beforeEach(async () => {
  app = new IdentityScenario(); await app.start(); await app.setup();
  repositoryId = (await app.request<{ repository: { id: string } }>("/api/repositories", fixtureRepository)).body.repository.id;
});
afterEach(async () => { await app.stop(); });

describe("个人待办", () => {
  it("未关联时返回可用的提醒分区，已关联仅保留本人当前最新开放轮次", async () => {
    expect((await app.request<Inbox>("/api/inbox")).body).toEqual({ linked: false, toReview: [], submitted: [], notifications: [] });
    expect((await app.request("/api/account/identities", { gitlab: [{ instanceUrl: fixtureRepository.instanceUrl, username: "zhangwei" }], mobile: null, feishuOpenId: null, feishuUserId: null }, { method: "PUT" })).status).toBe(200);
    const ids = Array.from({ length: 5 }, () => randomUUID());
    await withTeam(DEFAULT_TEAM_ID, async () => {
      for (const [index, data] of [
        { iid: 7, round: 1, reviewers: ["zhangwei"], author: "lina", state: "opened" },
        { iid: 7, round: 2, reviewers: ["zhangwei"], author: "lina", state: "opened" },
        { iid: 8, round: 1, reviewers: [], assignees: ["zhangwei"], author: "zhangwei", state: "opened" },
        { iid: 9, round: 1, reviewers: ["zhangwei"], author: "zhangwei", state: "merged" },
        { iid: 10, round: 1, reviewers: ["zhangwei"], author: "zhangwei", state: "closed" },
      ].entries()) await app.pool.query("INSERT INTO reviews(id,repository_id,event_id,iid,round,head_sha,title,author,pull_request) VALUES($1,$2,$3,$4,$5,'abc','库存预留',$6,$7)",
        [ids[index], repositoryId, `event-${index}`, data.iid, data.round, data.author, index === 1 ? null : JSON.stringify(data)]);
    });
    const inbox = (await app.request<Inbox>("/api/inbox")).body;
    expect(inbox.linked).toBe(true);
    expect(inbox.toReview.map((item) => item.id).sort()).toEqual([ids[1], ids[2]].sort());
    expect(inbox.submitted.map((item) => item.id)).toEqual([ids[2]]);
    expect(inbox.toReview[0]).toMatchObject({ status: "queued", conclusion: { status: "queued" }, readingSummary: null, pendingCount: 0 });
  });

  it("首页提醒按 PR 最新有效快照过滤关闭和合并，完整提醒列表保留原轮次", async () => {
    const session = await app.request<{ user: { userId: string } }>("/api/auth/session");
    const recipient = session.body.user.userId;
    const reviews = Array.from({ length: 4 }, () => randomUUID());
    const notifications = [randomUUID(), randomUUID()];
    await withTeam(DEFAULT_TEAM_ID, async () => {
      for (const [index, id] of reviews.entries()) {
        const snapshot = index === 2 ? null : JSON.stringify({ state: index === 1 ? "closed" : "opened" });
        await app.pool.query("INSERT INTO reviews(id,repository_id,event_id,iid,round,head_sha,title,author,pull_request) VALUES($1,$2,$3,$4,$5,'abc','库存预留','lina',$6)",
          [id, repositoryId, `notification-${index}`, index === 3 ? 8 : 7, index === 3 ? 1 : index + 1, snapshot]);
      }
      for (const [index, reviewId] of [reviews[0], reviews[3]].entries()) {
        const findingId = randomUUID(), commentId = randomUUID();
        await app.pool.query("INSERT INTO review_findings(id,review_id,payload) VALUES($1,$2,$3)", [findingId, reviewId, JSON.stringify({ title: "并发库存释放" })]);
        await app.pool.query("INSERT INTO discussion_comments(id,review_id,finding_id,author_id,request_id,body) VALUES($1,$2,$3,$4,$5,'请核对库存恢复')", [commentId, reviewId, findingId, recipient, randomUUID()]);
        await app.pool.query("INSERT INTO discussion_notifications(id,comment_id,recipient_id,kind) VALUES($1,$2,$3,'mention')", [notifications[index], commentId, recipient]);
      }
    });
    for (const state of ["closed", "merged"]) {
      await withTeam(DEFAULT_TEAM_ID, () => app.pool.query("UPDATE reviews SET pull_request=$2 WHERE id=$1", [reviews[1], JSON.stringify({ state })]));
      const inbox = (await app.request<Inbox>("/api/inbox")).body;
      expect(inbox.notifications.map((item) => item.id)).toEqual([notifications[1]]);
      const full = (await app.request<{ notifications: InboxNotification[] }>("/api/notifications")).body;
      expect(full.notifications).toHaveLength(2);
      expect(full.notifications.find((item) => item.id === notifications[0])?.reviewId).toBe(reviews[0]);
    }
  });

  it("解读概述提取中文与英文第一句并保留单句文本", () => {
    expect(readingFirstSentence("  恢复超时订单的库存。另有两个边界。 ")).toBe("恢复超时订单的库存。");
    expect(readingFirstSentence("Release inventory. Keep the lock.")).toBe("Release inventory.");
    expect(readingFirstSentence("仅修改库存校验")).toBe("仅修改库存校验");
    expect(readingFirstSentence(" ")).toBeNull();
  });
});
