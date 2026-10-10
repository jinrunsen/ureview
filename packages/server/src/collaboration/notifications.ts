import { randomUUID } from "node:crypto";
import type pg from "pg";
import { deriveReviewConclusion, selectVisibleFindings } from "../reviews/presentation.js";
import type { ReviewFinding, ReviewConclusion } from "../reviews/types.js";
import { htmlText } from "../reviews/reading-text.js";

export interface NotificationRecipient {
  userId: string; name: string; reason?: "mention" | "reply"; mobile: string | null; feishuOpenId: string | null; feishuUserId: string | null;
}
export interface NotificationPayload {
  type: "review_completed" | "discussion";
  author?: { id: string; name: string };
  reviewId: string; title: string; repository: string; recipients: NotificationRecipient[];
  findingId?: string; findingTitle?: string; body?: string; commentId?: string;
  conclusion?: ReviewConclusion; readingSummary?: string;
}

export function firstSentence(value: string): string {
  return value.trim().match(/^[\s\S]*?(?:[。！？]|[.!?](?:\s|$)|\n|$)/)?.[0]?.trim() ?? "";
}

export async function notificationRecipients(client: pg.PoolClient, userIds: string[]): Promise<NotificationRecipient[]> {
  const result = await client.query<{ id: string; name: string; im_mobile: string | null; feishu_open_id: string | null; feishu_user_id: string | null }>(
    `SELECT u.id,u.name,u.im_mobile,u.feishu_open_id,u.feishu_user_id FROM auth_users u
     JOIN team_members m ON m.user_id=u.id AND m.team_id=nullif(current_setting('app.team_id',true),'')::uuid
     WHERE u.id=ANY($1::uuid[]) ORDER BY u.id`, [userIds]);
  return result.rows.map((row) => ({ userId: row.id, name: row.name, mobile: row.im_mobile, feishuOpenId: row.feishu_open_id, feishuUserId: row.feishu_user_id }));
}

export async function enqueueNotification(client: pg.PoolClient, payload: NotificationPayload): Promise<void> {
  const endpoints = await client.query<{ id: string; kind: string }>("SELECT id,kind FROM notification_endpoints FOR KEY SHARE");
  for (const endpoint of endpoints.rows) {
    const batchSize = endpoint.kind === "webhook" ? Math.max(1, payload.recipients.length) : 50;
    for (let offset = 0; offset < Math.max(1, payload.recipients.length); offset += batchSize) {
      const batch = { ...payload, recipients: payload.recipients.slice(offset, offset + batchSize) };
      await client.query(`INSERT INTO notification_deliveries(id,endpoint_id,review_id,comment_id,batch_index,payload)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [randomUUID(), endpoint.id, payload.reviewId, payload.commentId ?? null, offset / batchSize, JSON.stringify(batch)]);
    }
  }
}

/**
 * 和评审完成或解读结束共用事务，出口故障不会影响评审产出。解读还在生成时先不入队，
 * 由解读结束时补发，消息里才有解读概要；投递按评审去重，两处调用不会重复发送。
 */
export async function enqueueReviewNotifications(client: pg.PoolClient, reviewId: string): Promise<void> {
  const enabled = await client.query("SELECT 1 FROM notification_endpoints LIMIT 1");
  if (!enabled.rowCount) return;
  const reading = await client.query("SELECT 1 FROM reading_documents WHERE review_id=$1 AND status='running'", [reviewId]);
  if (reading.rowCount) return;
  const result = await client.query<{
    title: string; author: string; pull_request: { reviewers?: string[] } | null; summary: string | null;
    repository: string; instance_url: string;
  }>(`SELECT r.title,r.author,r.pull_request,p.path_with_namespace AS repository,p.instance_url,
      (SELECT d.content->'sections'->>'summary' FROM reading_documents d WHERE d.review_id=r.id AND d.status='completed'
        ORDER BY d.completed_at DESC LIMIT 1) AS summary
      FROM reviews r JOIN repositories p ON p.id=r.repository_id WHERE r.id=$1`, [reviewId]);
  const row = result.rows[0];
  if (!row) return;
  const usernames = [...new Set([row.author, ...(row.pull_request?.reviewers ?? [])].map((name) => name.toLowerCase()))];
  const identities = await client.query<{ user_id: string }>("SELECT user_id FROM auth_gitlab_identities WHERE instance_url=$1 AND lower(username)=ANY($2::text[])", [row.instance_url, usernames]);
  const recipients = await notificationRecipients(client, identities.rows.map((identity) => identity.user_id));
  const findings = await client.query<{ payload: ReviewFinding }>("SELECT payload FROM review_findings WHERE review_id=$1", [reviewId]);
  const conclusion = deriveReviewConclusion("completed", selectVisibleFindings(findings.rows.map((finding) => finding.payload)).findings);
  await enqueueNotification(client, { type: "review_completed", reviewId, title: row.title, repository: row.repository,
    recipients, conclusion, readingSummary: firstSentence(htmlText(row.summary ?? "")) });
}
