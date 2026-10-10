import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertNotificationAccepted, createNotificationMessage, truncateBytes } from "./messages.js";
import { firstSentence, type NotificationPayload } from "./notifications.js";

const payload: NotificationPayload = {
  type: "review_completed", reviewId: "inventory-review", title: "修复库存预留", repository: "commerce/inventory",
  recipients: [{ userId: "zhang", name: "张伟", mobile: "13800138000", feishuOpenId: "ou_zhang", feishuUserId: null }, { userId: "li", name: "李娜", mobile: null, feishuOpenId: null, feishuUserId: "li_na" }],
  conclusion: { status: "requires_changes", findingCounts: { high: 1, medium: 2 }, disposedCount: 0 }, readingSummary: "库存预留增加了幂等检查。",
};
const now = 1_791_238_400_123;
describe("即时通讯消息协议", () => {
  it("企业微信使用文本与手机号提醒，文本按字节截断且保留链接", () => {
    const result = createNotificationMessage("wecom", "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=secret", null, { ...payload, readingSummary: "库存".repeat(4000) }, "https://review.example.test", now);
    expect(result.body).toMatchObject({ msgtype: "text", text: { mentioned_mobile_list: ["13800138000"] } });
    const body = result.body as { text: { content: string } };
    expect(Buffer.byteLength(body.text.content)).toBeLessThanOrEqual(2048);
    expect(body.text.content).toContain("https://review.example.test/?review=inventory-review");
    expect(body.text.content).toContain("结论：需要修改");
  });
  it("飞书富文本支持两种身份并使用秒时间戳和空消息签名", () => {
    const result = createNotificationMessage("feishu", "https://open.feishu.cn/open-apis/bot/v2/hook/token", "feishu-secret", payload, "https://review.example.test", now);
    const timestamp = String(Math.floor(now / 1000));
    expect(result.body).toMatchObject({ timestamp, sign: createHmac("sha256", `${timestamp}\nfeishu-secret`).update("").digest("base64"), msg_type: "post",
      content: { post: { zh_cn: { content: [expect.any(Array), expect.any(Array), [{ tag: "at", user_id: "ou_zhang" }, { tag: "at", user_id: "li_na" }]] } } } });
  });
  it("钉钉在正文与提醒列表都带手机号，签名在查询参数且时间戳为毫秒", () => {
    const result = createNotificationMessage("dingtalk", "https://oapi.dingtalk.com/robot/send?access_token=token", "ding-secret", payload, "https://review.example.test", now);
    const url = new URL(result.endpoint);
    expect(url.searchParams.get("timestamp")).toBe(String(now));
    expect(url.searchParams.get("sign")).toBe(createHmac("sha256", "ding-secret").update(`${now}\nding-secret`).digest("base64"));
    expect(url.searchParams.get("access_token")).toBe("token");
    expect(result.body).toMatchObject({ msgtype: "text", text: { content: expect.stringContaining("@13800138000") }, at: { atMobiles: ["13800138000"], isAtAll: false } });
  });
  it("未填写即时通讯身份仍发送消息，讨论链接定位到对应讨论区", () => {
    const result = createNotificationMessage("feishu", "https://open.feishu.cn/hook", null, { ...payload, type: "discussion", findingId: "finding-stock", findingTitle: "库存可能为负", body: "请确认边界", recipients: [] }, "https://review.example.test", now);
    const serialized = JSON.stringify(result.body);
    expect(serialized).toContain("库存可能为负"); expect(serialized).toContain("请确认边界"); expect(serialized).toContain("discussion=finding-stock#discussion-finding-stock"); expect(serialized).not.toContain('"tag":"at"');
  });
  it("三种机器人的业务错误与缺少结果均为失败，通用出口只要求HTTP成功", () => {
    for (const kind of ["wecom", "feishu", "dingtalk"] as const) {
      expect(() => assertNotificationAccepted(kind, { errcode: 1, code: 1 })).toThrow();
      expect(() => assertNotificationAccepted(kind, null)).toThrow();
      expect(() => assertNotificationAccepted(kind, { errcode: 0, code: 0 })).not.toThrow();
    }
    expect(() => assertNotificationAccepted("feishu", { StatusCode: 0 })).not.toThrow();
    expect(() => assertNotificationAccepted("webhook", null)).not.toThrow();
  });
  it("长转义正文与大量提醒仍受完整JSON上限约束，并过滤全员提醒", () => {
    const recipients = Array.from({ length: 50 }, (_, index) => ({ userId: String(index), name: "张伟", mobile: `1380013${String(index).padStart(4, "0")}`, feishuOpenId: `ou_${"a".repeat(115)}${index}`, feishuUserId: null }));
    recipients.push({ userId: "everyone", name: "张伟", mobile: "13800138000", feishuOpenId: "all", feishuUserId: null });
    for (const kind of ["feishu", "dingtalk"] as const) {
      const result = createNotificationMessage(kind, "https://notify.example.test/hook", "signing-key", { ...payload, readingSummary: "\\".repeat(12000), recipients }, "https://review.example.test", now);
      expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThanOrEqual(20_000);
      expect(JSON.stringify(result.body)).toContain("https://review.example.test/?review=inventory-review");
      expect(JSON.stringify(result.body)).not.toContain('"user_id":"all"');
    }
  });
  it("概述取第一句且截断不破坏Unicode字符", () => {
    expect(firstSentence("第一句。第二句。" )).toBe("第一句。");
    expect(firstSentence("An overview. Next sentence.")).toBe("An overview.");
    expect(truncateBytes("😀库存检查", 10)).toBe("😀库…");
  });
});
