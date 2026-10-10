import { createHmac } from "node:crypto";
import type { NotificationPayload } from "./notifications.js";

export type NotificationKind = "wecom" | "feishu" | "dingtalk" | "webhook";
const conclusionLabels = { requires_changes: "需要修改", manual_judgment: "需要人工判断", no_major_findings: "无主要问题", queued: "待评审", running: "进行中", failed: "失败" };

/** 平台上限按 UTF-8 字节裁剪，并保留完整字符。 */
export function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  let result = "", size = 0;
  for (const character of value) {
    const next = Buffer.byteLength(character);
    if (size + next > maxBytes - 3) break;
    result += character; size += next;
  }
  return `${result}…`;
}
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

function fitText<T>(value: string, build: (text: string) => T, limit: number): T {
  if (jsonBytes(build(value)) <= limit) return build(value);
  const characters = Array.from(value);
  let low = 0, high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(build(`${characters.slice(0, middle).join("")}…`)) <= limit) low = middle;
    else high = middle - 1;
  }
  return build(`${characters.slice(0, low).join("")}…`);
}

export function createNotificationMessage(kind: NotificationKind, endpoint: string, secret: string | null, payload: NotificationPayload, publicOrigin: string, now = Date.now()): { endpoint: string; body: unknown } {
  const link = `${publicOrigin}/?review=${encodeURIComponent(payload.reviewId)}${payload.findingId ? `&discussion=${encodeURIComponent(payload.findingId)}#discussion-${encodeURIComponent(payload.findingId)}` : ""}`;
  const headline = `${payload.type === "review_completed" ? "评审完成" : "讨论提醒"}：${payload.title}`;
  const details = payload.type === "review_completed"
    ? `${payload.repository}\n结论：${payload.conclusion ? conclusionLabels[payload.conclusion.status] : "已完成"}\n高危 ${payload.conclusion?.findingCounts.high ?? 0} · 中危 ${payload.conclusion?.findingCounts.medium ?? 0}\n${payload.readingSummary ?? ""}`
    : `${payload.repository}\n${payload.findingTitle ?? ""}\n${payload.body ?? ""}`;
  if (kind === "webhook") return { endpoint, body: { ...payload, link } };
  const mobiles = [...new Set(payload.recipients.flatMap((recipient) => recipient.mobile && /^\+?[0-9]{6,20}$/.test(recipient.mobile) ? [recipient.mobile] : []))];
  if (kind === "wecom") {
    const text = truncateBytes(`${headline}\n${details}`, Math.max(16, 2048 - Buffer.byteLength(`\n${link}`)));
    return { endpoint, body: { msgtype: "text", text: { content: `${text}\n${link}`, mentioned_mobile_list: mobiles } } };
  }
  if (kind === "dingtalk") {
    const url = new URL(endpoint);
    if (secret) {
      const timestamp = String(now);
      url.searchParams.set("timestamp", timestamp);
      url.searchParams.set("sign", createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64"));
    }
    const mentions: string[] = [];
    const build = (text: string) => ({ msgtype: "text", text: { content: `${text}\n${link}${mentions.map((mobile) => ` @${mobile}`).join("")}` }, at: { atMobiles: mentions, isAtAll: false } });
    for (const mobile of mobiles) {
      mentions.push(mobile);
    }
    return { endpoint: url.href, body: fitText(`${headline}\n${details}`, build, 20_000) };
  }
  const identities = [...new Set(payload.recipients.flatMap((recipient) => {
    const id = recipient.feishuOpenId ?? recipient.feishuUserId;
    return id && id !== "all" ? [id] : [];
  }))];
  const mentions: Array<{ tag: string; user_id: string }> = [];
  const build = (text: string) => ({
    msg_type: "post", content: { post: { zh_cn: {
      title: truncateBytes(headline, 200), content: [
        [{ tag: "text", text }], [{ tag: "a", text: "打开评审", href: link }], ...(mentions.length ? [mentions] : []),
      ],
    } } },
    ...(secret ? { timestamp: String(Math.floor(now / 1000)), sign: createHmac("sha256", `${Math.floor(now / 1000)}\n${secret}`).update("").digest("base64") } : {}),
  });
  for (const id of identities) {
    mentions.push({ tag: "at", user_id: id });
  }
  return { endpoint, body: fitText(details, build, 20_000) };
}

export function assertNotificationAccepted(kind: NotificationKind, response: unknown): void {
  if (kind === "webhook") return;
  if (!response || typeof response !== "object") throw new Error("机器人未返回投递结果");
  const result = response as Record<string, unknown>;
  const code = kind === "feishu" ? result.code ?? result.StatusCode : result.errcode;
  if (code !== 0) throw new Error("机器人返回业务错误");
}
