import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { After, Before, Given, Then, When } from "@cucumber/cucumber";
import { ImPushScenario } from "../support/im-push-scenario.js";
import type { ApiWorld } from "../support/world.js";

const scenarios = new WeakMap<ApiWorld, ImPushScenario>();
const scenario = (world: ApiWorld) => { const value = scenarios.get(world); assert.ok(value); return value; };
Before({ tags: "@story:im-push", timeout: 60_000 }, async function (this: ApiWorld) { const value = new ImPushScenario(); scenarios.set(this, value); await value.start(); });
After({ tags: "@story:im-push", timeout: 60_000 }, async function (this: ApiWorld) {
  const value = scenarios.get(this);
  try { if (value?.review.gitlab) assert.deepEqual(value.review.gitlab.state.writes, []); }
  finally { await value?.close(); }
});
Given("库存团队已配置企业微信飞书和钉钉群机器人并关联张伟的即时通讯身份", async function (this: ApiWorld) { const value = scenario(this); await value.configure(["wecom", "feishu", "dingtalk"]); await value.linkIdentity(); });
Given("库存团队的企业微信机器人持续返回业务错误", async function (this: ApiWorld) { const value = scenario(this); value.reject = true; await value.configure(["wecom"]); });
Given("库存团队已配置企业微信机器人", async function (this: ApiWorld) { await scenario(this).configure(["wecom"]); });
When("库存预留评审完成", { timeout: 60_000 }, async function (this: ApiWorld) { await scenario(this).finishReview(); });
Then("三个群都收到包含结论解读概述和评审链接的消息并提醒张伟", async function (this: ApiWorld) {
  const value = scenario(this); await value.waitFor(() => value.received.length === 3);
  const review = await value.review.readReview();
  assert.equal(review.status, "completed"); assert.ok(review.readingSummary);
  const firstSentence = review.readingSummary.trim().match(/^[\s\S]*?(?:[。！？]|[.!?](?:\s|$)|\n|$)/)?.[0]?.trim(); assert.ok(firstSentence);
  for (const notification of value.received) {
    const serialized = JSON.stringify(notification.body);
    assert.ok(serialized.includes("修复库存预留的重复释放"));
    assert.ok(serialized.includes("需要修改")); assert.ok(serialized.includes("高危 1"));
    assert.ok(serialized.includes(firstSentence));
    assert.ok(serialized.includes(`https://review.example.test/?review=${review.id}`));
  }
  const wecom = value.received.find((message) => message.kind === "wecom")!.body;
  assert.equal(wecom.msgtype, "text"); assert.deepEqual((wecom.text as { mentioned_mobile_list: string[] }).mentioned_mobile_list, ["13800138000"]);
  const dingtalk = value.received.find((message) => message.kind === "dingtalk")!.body;
  assert.deepEqual((dingtalk.at as { atMobiles: string[] }).atMobiles, ["13800138000"]); assert.ok((dingtalk.text as { content: string }).content.includes("@13800138000"));
  const feishu = value.received.find((message) => message.kind === "feishu")!.body;
  assert.equal(feishu.msg_type, "post"); assert.ok(JSON.stringify(feishu).includes('"tag":"at","user_id":"ou_zhangwei"'));
});
Then("飞书和钉钉消息的签名可以验证", function (this: ApiWorld) { scenario(this).verifySignatures(); });
Then("机器人尝试四次后团队设置显示投递失败", { timeout: 30_000 }, async function (this: ApiWorld) {
  const value = scenario(this); await value.waitFor(() => value.received.length === 4);
  const deadline = Date.now() + 2000;
  let failed = 0;
  do {
    const response = await value.review.request<{ endpoints: Array<{ deliveries: Record<string, number> }> }>("/api/notification-endpoints");
    assert.equal(response.status, 200); failed = response.body.endpoints[0]?.deliveries.failed ?? 0;
    if (failed) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(failed, 1); assert.equal(value.received.length, 4);
});
Then("评审产出仍可阅读", async function (this: ApiWorld) { const review = await scenario(this).review.readReview(); assert.equal(review.status, "completed"); assert.equal(review.findings.length, 1); });
When("两轮库存预留评审先后完成", { timeout: 60_000 }, async function (this: ApiWorld) {
  const value = scenario(this); await value.finishReview();
  const response = await value.review.request<{ reviewId: string }>(`/api/reviews/${value.review.reviewId}/rerun`, { requestId: randomUUID() });
  assert.equal(response.status, 202); value.review.reviewId = response.body.reviewId;
  await value.review.waitForReview((review) => review.status === "completed");
});
Then("群内两次评审提醒至少间隔三秒", async function (this: ApiWorld) {
  const value = scenario(this); await value.waitFor(() => value.received.length === 2);
  assert.ok(value.received[1]!.receivedAt - value.received[0]!.receivedAt >= 3000);
});
