import type pg from "pg";
import { requireAdmin } from "../auth/context.js";
import { GitLabPlatform, type WebhookReader } from "../platform/gitlab.js";
import { ReviewError, type RepositoryCredentials } from "../reviews/types.js";
import type { ReviewService } from "../reviews/service.js";
import type { RepositoryService } from "./service.js";

export type WebhookResult = "queued" | "duplicate" | "ignored" | "failed";
export interface RepositoryWebhookEvent {
  id: string;
  receivedAt: string;
  eventType: string;
  action: string | null;
  iid: number | null;
  result: WebhookResult;
  reason: string | null;
  reviewId: string | null;
  reviewRound: number | null;
}
export interface WebhookOutcome { result: WebhookResult; reason: string | null; reviewId: string | null }
export interface WebhookCheck {
  status: "configured" | "missing" | "merge_request_events_disabled" | "unreadable" | "unavailable";
  message: string;
  checkedAt: string;
}
interface EventRow {
  id: string; received_at: Date; event_type: string; action: string | null; iid: string | null;
  result: WebhookResult; reason: string | null; review_id: string | null; review_round: number | null;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function label(value: unknown, fallback: string | null): string | null {
  return typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9 _.-]{0,119}$/.test(value) ? value : fallback;
}

/** webhook 接收记录与只读配置检测；平台载荷只在本次请求内使用。 */
export class RepositoryWebhookService {
  constructor(private readonly pool: pg.Pool, private readonly repositories: RepositoryService,
    private readonly publicOrigin: string, private readonly tokenConfigured: boolean,
    private readonly platforms: (repository: RepositoryCredentials) => WebhookReader = (repository) => new GitLabPlatform(repository)) {}

  url(repositoryId: string): string {
    return `${this.publicOrigin.replace(/\/+$/, "")}/api/repositories/${repositoryId}/events/gitlab`;
  }

  async list(repositoryId: string): Promise<{ webhook: { url: string; tokenConfigured: boolean; lastAuthenticationFailureAt: string | null };
    events: RepositoryWebhookEvent[] }> {
    const repository = await this.repositories.get(repositoryId);
    const { rows } = await this.pool.query<EventRow>(`SELECT e.*,r.round AS review_round FROM repository_webhook_events e
      LEFT JOIN reviews r ON r.id=e.review_id WHERE e.repository_id=$1 ORDER BY e.received_at DESC,e.id DESC LIMIT 100`, [repositoryId]);
    return { webhook: { url: this.url(repositoryId), tokenConfigured: this.tokenConfigured,
      lastAuthenticationFailureAt: repository.lastAuthenticationFailureAt }, events: rows.map((row) => ({
      id: row.id, receivedAt: row.received_at.toISOString(), eventType: row.event_type, action: row.action,
      iid: row.iid === null ? null : Number(row.iid), result: row.result, reason: row.reason,
      reviewId: row.review_id, reviewRound: row.review_round,
    })) };
  }

  async receive(repositoryId: string, eventType: unknown, deliveryId: unknown, payload: unknown, reviews: ReviewService):
    Promise<WebhookOutcome & { created?: boolean }> {
    if (!(await this.repositories.get(repositoryId)).automaticReviewEnabled) {
      return { result: "ignored", reason: "自动评审已关闭", reviewId: null };
    }
    if (eventType !== "Merge Request Hook") return { result: "ignored", reason: "此事件类型不触发评审", reviewId: null };
    if (typeof deliveryId !== "string" || !deliveryId.trim() || deliveryId.length > 256) {
      throw new ReviewError("invalid_event", "Webhook 缺少有效的投递标识");
    }
    const accepted = await reviews.acceptEvent(repositoryId, deliveryId, payload);
    if (!accepted) return { result: "ignored", reason: (await this.repositories.get(repositoryId)).automaticReviewEnabled
      ? "此事件无需评审" : "自动评审已关闭", reviewId: null };
    return { result: accepted.created ? "queued" : "duplicate", reason: null, reviewId: accepted.id, created: accepted.created };
  }

  async record(repositoryId: string, receivedAt: Date, eventType: unknown, payload: unknown, outcome: WebhookOutcome): Promise<void> {
    const attributes = record(record(payload).object_attributes);
    const iid = typeof attributes.iid === "number" && Number.isSafeInteger(attributes.iid) && attributes.iid > 0 ? attributes.iid : null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 同一仓库的插入与裁剪共用锁，避免并发请求各自保留超过一百条。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`ureview:webhook-events:${repositoryId}`]);
      await client.query(`INSERT INTO repository_webhook_events(team_id,repository_id,received_at,event_type,action,iid,result,reason,review_id)
        SELECT team_id,id,$2,$3,$4,$5,$6,$7,$8 FROM repositories WHERE id=$1`,
      [repositoryId, receivedAt, label(eventType, "Unknown Hook"), label(attributes.action, null), iid,
        outcome.result, outcome.reason, outcome.reviewId]);
      await client.query(`DELETE FROM repository_webhook_events WHERE repository_id=$1 AND id IN
        (SELECT id FROM repository_webhook_events WHERE repository_id=$1 ORDER BY received_at DESC,id DESC OFFSET 100)`, [repositoryId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async check(repositoryId: string): Promise<WebhookCheck> {
    requireAdmin();
    const repository = await this.repositories.getCredentials(repositoryId);
    const checkedAt = new Date().toISOString();
    try {
      const hooks = await this.platforms(repository).getWebhooks();
      const matching = hooks.filter((hook) => hook.url === this.url(repositoryId));
      if (!matching.length) return { status: "missing", message: "未找到指向本仓库地址的 webhook，请在 GitLab 中添加配置", checkedAt };
      if (!matching.some((hook) => hook.mergeRequestEvents)) {
        return { status: "merge_request_events_disabled", message: "已找到 webhook，请在 GitLab 中勾选 Merge request events", checkedAt };
      }
      return { status: "configured", message: "已找到 webhook，且已勾选 Merge request events；可在 GitLab 中测试投递并观察最近事件", checkedAt };
    } catch (error) {
      if (error instanceof ReviewError && error.diagnostic.causeCategory === "access_denied") {
        return { status: "unreadable", message: "无法读取 webhook 配置，请在 GitLab 中使用 webhook 的测试功能，再观察最近收到的事件", checkedAt };
      }
      return { status: "unavailable", message: "暂时无法连接 GitLab，请检查服务连接后重试，或在 GitLab 中测试 webhook 并观察最近收到的事件", checkedAt };
    }
  }
}
