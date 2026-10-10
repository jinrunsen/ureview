import type pg from "pg";
import { AuthError, requireIdentity } from "../auth/context.js";
import type { ReviewStore } from "../reviews/store.js";
import type { ReviewConclusion, ReviewDetail, ReviewStatus } from "../reviews/types.js";

export interface InboxReview {
  id: string;
  title: string;
  repositoryName: string;
  iid: number;
  status: ReviewStatus;
  createdAt: string;
  conclusion: ReviewConclusion;
  readingSummary: string | null;
  pendingCount: number;
}
export interface InboxNotification {
  id: string;
  reviewId: string;
  findingId: string;
  reviewTitle: string;
  repositoryName: string;
  findingTitle: string;
  body: string;
  kind: "mention" | "reply";
  createdAt: string;
  readAt: string | null;
  authorName: string;
  review: InboxReview;
}
export interface Inbox { linked: boolean; toReview: InboxReview[]; submitted: InboxReview[]; notifications: InboxNotification[] }

export function readingFirstSentence(text: string | undefined): string | null {
  const trimmed = text?.trim();
  return trimmed ? trimmed.match(/^[\s\S]*?[。！？!?](?:[”’"']|$|\s)?|^[\s\S]*?\.(?=\s|$)/)?.[0]?.trim() ?? trimmed : null;
}
function summarize(review: ReviewDetail): InboxReview {
  return { id: review.id, title: review.title, repositoryName: review.repositoryName, iid: review.iid,
    status: review.status, createdAt: review.createdAt, conclusion: review.conclusion,
    readingSummary: readingFirstSentence(review.readingSummary ?? undefined),
    pendingCount: review.findings.filter((finding) => finding.status === "Pending").length };
}

export class InboxService {
  constructor(private readonly pool: pg.Pool, private readonly reviews: ReviewStore) {}

  async get(): Promise<Inbox> {
    const { userId } = requireIdentity();
    const identities = (await this.pool.query<{ instance_url: string; username: string }>(
      `SELECT i.instance_url,i.username FROM auth_gitlab_identities i WHERE i.user_id=$1
       AND EXISTS(SELECT 1 FROM repositories r WHERE r.instance_url=i.instance_url)`, [userId])).rows;
    const { rows } = await this.pool.query<{ id: string; assigned: boolean; authored: boolean }>(
      `WITH latest AS (SELECT DISTINCT ON(repository_id,iid) * FROM reviews ORDER BY repository_id,iid,round DESC),
       snapshots AS (SELECT latest.*, coalesce(latest.pull_request,(SELECT previous.pull_request FROM reviews previous
         WHERE previous.repository_id=latest.repository_id AND previous.iid=latest.iid AND previous.pull_request IS NOT NULL
         ORDER BY previous.round DESC LIMIT 1)) AS inbox_pr FROM latest)
       SELECT r.id, lower(i.username)=ANY(ARRAY(SELECT lower(value) FROM jsonb_array_elements_text(coalesce(r.inbox_pr->'reviewers','[]'::jsonb))
         UNION SELECT lower(value) FROM jsonb_array_elements_text(coalesce(r.inbox_pr->'assignees','[]'::jsonb)))) AS assigned,
         lower(r.author)=lower(i.username) AS authored
       FROM snapshots r JOIN repositories p ON p.id=r.repository_id
       JOIN auth_gitlab_identities i ON i.instance_url=p.instance_url AND i.user_id=$1
       WHERE coalesce(r.inbox_pr->>'state','opened') NOT IN ('merged','closed')
       ORDER BY r.created_at DESC,r.id`, [userId]);
    const toReview: InboxReview[] = [];
    const submitted: InboxReview[] = [];
    for (const row of rows) {
      if (!row.assigned && !row.authored) continue;
      const review = await this.reviews.get(row.id);
      if (!review) continue;
      const item = summarize(review);
      if (row.assigned) toReview.push(item);
      if (row.authored) submitted.push(item);
    }
    return { linked: identities.length > 0, toReview, submitted, notifications: await this.notifications(true) };
  }

  async notifications(openOnly = false): Promise<InboxNotification[]> {
    const { userId } = requireIdentity();
    const { rows } = await this.pool.query<{ id: string; review_id: string; finding_id: string; body: string;
      kind: "mention" | "reply"; created_at: Date; read_at: Date | null; author_name: string; finding_title: string }>(
      `SELECT n.id,c.review_id,c.finding_id,c.body,n.kind,n.created_at,n.read_at,u.name AS author_name,f.payload->>'title' AS finding_title
       FROM discussion_notifications n JOIN discussion_comments c ON c.id=n.comment_id
       JOIN auth_users u ON u.id=c.author_id JOIN review_findings f ON f.review_id=c.review_id AND f.id=c.finding_id
       JOIN reviews r ON r.id=c.review_id
       WHERE n.recipient_id=$1 AND (NOT $2::boolean OR coalesce((SELECT latest.pull_request->>'state' FROM reviews latest
         WHERE latest.repository_id=r.repository_id AND latest.iid=r.iid AND latest.pull_request IS NOT NULL
         ORDER BY latest.round DESC LIMIT 1),'opened') NOT IN ('merged','closed')) ORDER BY (n.read_at IS NULL) DESC,n.created_at DESC,n.id`, [userId, openOnly]);
    const notifications: InboxNotification[] = [];
    for (const row of rows) {
      const detail = await this.reviews.get(row.review_id);
      if (!detail) continue;
      const review = summarize(detail);
      notifications.push({ id: row.id, reviewId: row.review_id, findingId: row.finding_id, reviewTitle: review.title,
        repositoryName: review.repositoryName, findingTitle: row.finding_title, body: row.body, kind: row.kind,
        createdAt: row.created_at.toISOString(), readAt: row.read_at?.toISOString() ?? null, authorName: row.author_name, review });
    }
    return notifications;
  }

  async markRead(notificationId: string): Promise<void> {
    const { userId } = requireIdentity();
    const result = await this.pool.query("UPDATE discussion_notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND recipient_id=$2", [notificationId, userId]);
    if (!result.rowCount) throw new AuthError(404, "notification_not_found", "提醒不存在");
  }
}
