import { randomUUID } from "node:crypto";
import type pg from "pg";
import { requireIdentity } from "../auth/context.js";
import { withTeam } from "../db/tenant.js";
import { CollaborationError, type DiscussionComment, type PlatformDiscussionReader } from "./types.js";
import { NotificationDeliveryService, type DeliveryOptions, type EndpointInput } from "./delivery.js";
import { enqueueNotification, notificationRecipients } from "./notifications.js";

interface CommentRow {
  id: string; author_id: string; author_name: string; parent_id: string | null;
  body: string; mentions: string[]; created_at: Date;
}
interface CommentInput { requestId: string; body: string; parentId?: string; mentions?: string[] }
const columns = "c.id,c.author_id,u.name AS author_name,c.parent_id,c.body,c.mentions,c.created_at";
const comment = (row: CommentRow): DiscussionComment => ({
  id: row.id, authorId: row.author_id, authorName: row.author_name, parentId: row.parent_id,
  body: row.body, mentions: row.mentions, createdAt: row.created_at.toISOString(),
});

export class CollaborationService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private readonly notifications: NotificationDeliveryService;
  constructor(private readonly pool: pg.Pool, private readonly options: DeliveryOptions & { history?: PlatformDiscussionReader }) {
    this.notifications = new NotificationDeliveryService(pool, options);
  }

  private async review(reviewId: string) {
    const result = await this.pool.query<{ repository_id: string; iid: string; status: string }>("SELECT repository_id,iid,status FROM reviews WHERE id=$1", [reviewId]);
    if (!result.rows[0]) throw new CollaborationError(404, "not_found", "评审不存在");
    return result.rows[0];
  }
  private async finding(reviewId: string, findingId: string) {
    const result = await this.pool.query("SELECT 1 FROM review_findings WHERE id=$1 AND review_id=$2", [findingId, reviewId]);
    if (!result.rowCount) throw new CollaborationError(404, "not_found", "Finding 不存在");
  }

  async members() {
    const identity = requireIdentity();
    const result = await this.pool.query<{ id: string; name: string }>(
      "SELECT u.id,u.name FROM auth_users u JOIN team_members m ON m.user_id=u.id WHERE m.team_id=$1 ORDER BY u.name,u.id", [identity.teamId]);
    return result.rows;
  }

  async listComments(reviewId: string, findingId: string) {
    const identity = requireIdentity();
    await this.finding(reviewId, findingId);
    const comments = await this.pool.query<CommentRow>(`SELECT ${columns} FROM discussion_comments c JOIN auth_users u ON u.id=c.author_id WHERE c.review_id=$1 AND c.finding_id=$2 ORDER BY c.created_at,c.id`, [reviewId, findingId]);
    const notifications = await this.pool.query<{ id: string }>(`SELECT id FROM discussion_notifications WHERE comment_id=ANY($1::uuid[]) AND recipient_id=$2 AND read_at IS NULL`, [comments.rows.map((row) => row.id), identity.userId]);
    return { comments: comments.rows.map(comment), unreadIds: notifications.rows.map((row) => row.id) };
  }

  async addComment(reviewId: string, findingId: string, input: CommentInput) {
    const identity = requireIdentity();
    const body = input.body.trim();
    const mentions = [...new Set(input.mentions ?? [])].sort();
    if (!body || body.length > 4000 || mentions.length > 20) throw new CollaborationError(400, "invalid_input", "讨论内容为 1 至 4000 字，最多提醒 20 位成员");
    await this.finding(reviewId, findingId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 评论及通知写入与仓库删除均先锁评审，再访问 finding。
      const review = await client.query("SELECT id FROM reviews WHERE id=$1 FOR KEY SHARE", [reviewId]);
      if (!review.rowCount) throw new CollaborationError(404, "not_found", "评审不存在");
      // 同一个提交标识串行检查，重复提交只能取得原始评论。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${identity.teamId}:${identity.userId}:${input.requestId}`]);
      const existing = await client.query<CommentRow & { review_id: string; finding_id: string }>(`SELECT ${columns},c.review_id,c.finding_id FROM discussion_comments c JOIN auth_users u ON u.id=c.author_id WHERE c.author_id=$1 AND c.request_id=$2`, [identity.userId, input.requestId]);
      if (existing.rows[0]) {
        const row = existing.rows[0];
        if (row.review_id !== reviewId || row.finding_id !== findingId || row.body !== body
          || row.parent_id !== (input.parentId ?? null) || JSON.stringify(row.mentions) !== JSON.stringify(mentions)) {
          throw new CollaborationError(409, "conflict", "提交标识已经用于另一条讨论");
        }
        await client.query("COMMIT");
        return { comment: comment(row), created: false };
      }
      const recipients = new Map<string, "mention" | "reply">();
      if (input.parentId) {
        const parent = await client.query<{ author_id: string }>("SELECT author_id FROM discussion_comments WHERE id=$1 AND review_id=$2 AND finding_id=$3", [input.parentId, reviewId, findingId]);
        if (!parent.rows[0]) throw new CollaborationError(400, "invalid_parent", "只能回复当前 Finding 的讨论");
        recipients.set(parent.rows[0].author_id, "reply");
      }
      if (mentions.length) {
        const members = await client.query<{ user_id: string }>("SELECT user_id FROM team_members WHERE team_id=$1 AND user_id=ANY($2::uuid[])", [identity.teamId, mentions]);
        if (members.rows.length !== mentions.length) throw new CollaborationError(400, "invalid_mention", "只能提醒当前团队的成员");
        for (const id of mentions) recipients.set(id, "mention");
      }
      recipients.delete(identity.userId);
      const id = randomUUID();
      const inserted = await client.query<{ created_at: Date }>(`INSERT INTO discussion_comments(id,review_id,finding_id,author_id,request_id,parent_id,body,mentions) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`, [id, reviewId, findingId, identity.userId, input.requestId, input.parentId ?? null, body, mentions]);
      for (const [recipient, kind] of recipients) await client.query("INSERT INTO discussion_notifications(id,comment_id,recipient_id,kind) VALUES($1,$2,$3,$4)", [randomUUID(), id, recipient, kind]);
      if (recipients.size) {
        const result = await client.query<{ title: string; repository: string; finding_title: string }>(`SELECT r.title,p.path_with_namespace AS repository,f.payload->>'title' AS finding_title
          FROM reviews r JOIN repositories p ON p.id=r.repository_id JOIN review_findings f ON f.review_id=r.id WHERE r.id=$1 AND f.id=$2`, [reviewId, findingId]);
        const review = result.rows[0]!;
        await enqueueNotification(client, { type: "discussion", reviewId, findingId, commentId: id, title: review.title,
          author: { id: identity.userId, name: identity.name }, repository: review.repository, findingTitle: review.finding_title ?? "Finding", body,
          recipients: (await notificationRecipients(client, [...recipients.keys()])).map((recipient) => ({ ...recipient, reason: recipients.get(recipient.userId)! })) });
      }
      await client.query("COMMIT");
      return { comment: { id, authorId: identity.userId, authorName: identity.name, parentId: input.parentId ?? null, body, mentions, createdAt: inserted.rows[0]!.created_at.toISOString() }, created: true };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async unread() {
    const identity = requireIdentity();
    const result = await this.pool.query<{ review_id: string; finding_id: string; count: string }>(`SELECT c.review_id,c.finding_id,count(*) FROM discussion_notifications n JOIN discussion_comments c ON c.id=n.comment_id WHERE n.recipient_id=$1 AND n.read_at IS NULL GROUP BY c.review_id,c.finding_id`, [identity.userId]);
    const threads = result.rows.map((row) => ({ reviewId: row.review_id, findingId: row.finding_id, count: Number(row.count) }));
    return { count: threads.reduce((total, row) => total + row.count, 0), threads };
  }

  async markRead(reviewId: string, findingId: string, ids: string[]) {
    const identity = requireIdentity();
    await this.finding(reviewId, findingId);
    await this.pool.query(`UPDATE discussion_notifications n SET read_at=coalesce(read_at,now()) FROM discussion_comments c WHERE c.id=n.comment_id AND c.review_id=$1 AND c.finding_id=$2 AND n.recipient_id=$3 AND n.id=ANY($4::uuid[])`, [reviewId, findingId, identity.userId, ids]);
    return { read: true };
  }

  async markViewed(reviewId: string): Promise<{ viewedAt: string }> {
    const identity = requireIdentity();
    const review = await this.review(reviewId);
    if (review.status !== "completed") throw new CollaborationError(409, "review_not_completed", "评审完成后才能标记已查看或看完");
    const result = await this.pool.query<{ viewed_at: Date }>(`INSERT INTO review_participants(review_id,user_id) VALUES($1,$2) ON CONFLICT(team_id,review_id,user_id) DO UPDATE SET viewed_at=review_participants.viewed_at RETURNING viewed_at`, [reviewId, identity.userId]);
    await this.pool.query("UPDATE reviews SET viewed_at=coalesce(viewed_at,now()) WHERE id=$1", [reviewId]);
    return { viewedAt: result.rows[0]!.viewed_at.toISOString() };
  }
  async finishReview(reviewId: string, completed: boolean) {
    const identity = requireIdentity();
    await this.markViewed(reviewId);
    await this.pool.query("UPDATE review_participants SET completed_at=CASE WHEN $3 THEN coalesce(completed_at,now()) ELSE NULL END WHERE review_id=$1 AND user_id=$2", [reviewId, identity.userId, completed]);
    return this.participation(reviewId);
  }
  async participation(reviewId: string) {
    const identity = requireIdentity();
    await this.review(reviewId);
    const result = await this.pool.query<{ user_id: string; name: string; viewed_at: Date; completed_at: Date | null }>(`SELECT p.user_id,u.name,p.viewed_at,p.completed_at FROM review_participants p JOIN auth_users u ON u.id=p.user_id WHERE p.review_id=$1 ORDER BY p.viewed_at,p.user_id`, [reviewId]);
    return { currentUserId: identity.userId, participants: result.rows.map((row) => ({ userId: row.user_id, name: row.name, viewedAt: row.viewed_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null })) };
  }
  async platformDiscussions(reviewId: string) {
    await this.review(reviewId);
    if (!this.options.history) return { discussions: [], error: "平台讨论读取尚未配置" };
    const review = await this.review(reviewId);
    try { return { discussions: await this.options.history.getDiscussions(review.repository_id, Number(review.iid)), error: null }; }
    catch { return { discussions: [], error: "无法读取 GitLab 历史讨论，请稍后重试；站内讨论仍可使用" }; }
  }

  async settings() { this.admin(); return this.notifications.legacySettings(); }
  async configure(endpoint: string | null) { this.admin(); return this.notifications.configureLegacy(endpoint); }
  async endpoints() { this.admin(); return this.notifications.list(); }
  async createEndpoint(input: EndpointInput) { this.admin(); return this.notifications.create(input); }
  async updateEndpoint(id: string, input: Partial<Pick<EndpointInput, "name" | "endpoint" | "secret">>) { this.admin(); return this.notifications.update(id, input); }
  async removeEndpoint(id: string) { this.admin(); return this.notifications.remove(id); }
  async migrateLegacySettings() { return this.notifications.migrateLegacySettings(); }
  private admin() {
    if (requireIdentity().role !== "admin") throw new CollaborationError(403, "forbidden", "只有管理员可以配置通知出口");
  }
  async deliverNext(): Promise<boolean> { return this.notifications.deliverNext(); }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = () => {
      this.running = (async () => {
        const teams = await this.pool.query<{ id: string }>("SELECT id FROM teams");
        for (const team of teams.rows) if (!this.stopped) await withTeam(team.id, () => this.deliverNext());
      })().catch(() => { /* 下一轮恢复数据库连接，评论提交不依赖出口健康。 */ }).finally(() => {
        if (!this.stopped) this.timer = setTimeout(tick, 1000);
      });
    };
    tick();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.running; }
}
