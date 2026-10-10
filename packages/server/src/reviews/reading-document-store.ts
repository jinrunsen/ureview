import { randomUUID } from "node:crypto";
import type pg from "pg";
import { enqueueReviewNotifications } from "../collaboration/notifications.js";
import type { ReadingDocumentOutput, ReadingDocumentRecord, ReadingDocumentSubmission } from "./reading-document.js";
import { ReviewError } from "./types.js";

interface DocumentRow {
  id: string;
  review_id: string;
  status: ReadingDocumentRecord["status"];
  failure_reason: string | null;
  content: ReadingDocumentRecord["content"];
  metrics: ReadingDocumentRecord["metrics"];
  submissions: ReadingDocumentSubmission[];
  model: ReadingDocumentRecord["model"];
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function record(row: DocumentRow): ReadingDocumentRecord {
  return { id: row.id, reviewId: row.review_id, status: row.status, failureReason: row.failure_reason,
    content: row.content, metrics: row.metrics, submissions: row.submissions, model: row.model,
    createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null, completedAt: row.completed_at?.toISOString() ?? null };
}

export interface ReadingDocumentJob { id: string; reviewId: string }

/** 每次生成的解读。评审任务内生成的直接以生成中开始；评审完成后的重新生成走队列。 */
export class ReadingDocumentStore {
  constructor(private readonly pool: pg.Pool) {}

  /** 评审完成后请求重新生成；同一轮最多一份生成中的解读。 */
  async requestRegeneration(reviewId: string): Promise<ReadingDocumentRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const review = await client.query<{ status: string }>("SELECT status FROM reviews WHERE id=$1 FOR UPDATE", [reviewId]);
      if (!review.rows[0]) throw new ReviewError("not_found", "评审不存在");
      if (review.rows[0].status !== "completed" && review.rows[0].status !== "failed") throw new ReviewError("conflict", "评审结束后才能重新生成解读");
      const active = await client.query("SELECT 1 FROM reading_documents WHERE review_id=$1 AND status IN ('queued','running')", [reviewId]);
      if (active.rows.length) throw new ReviewError("conflict", "这一轮已有解读正在生成，请等它完成");
      const { rows } = await client.query<DocumentRow>(`INSERT INTO reading_documents (team_id,id,review_id)
        SELECT team_id,$1,id FROM reviews WHERE id=$2 RETURNING *`, [randomUUID(), reviewId]);
      await client.query("COMMIT");
      return record(rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  /** 评审任务内并行生成的解读直接以生成中开始，不经过队列。 */
  async startRunning(reviewId: string): Promise<string> {
    const { rows } = await this.pool.query<{ id: string }>(`INSERT INTO reading_documents (team_id,id,review_id,status,started_at)
      SELECT team_id,$1,id,'running',clock_timestamp() FROM reviews WHERE id=$2 RETURNING id`, [randomUUID(), reviewId]);
    if (!rows[0]) throw new ReviewError("not_found", "评审不存在");
    return rows[0].id;
  }

  /** 进程重启前未完成的生成不会再有人推进，领取前先标记为失败。 */
  async claim(processStartedAt: Date): Promise<ReadingDocumentJob | null> {
    await this.pool.query(`UPDATE reading_documents SET status='failed', failure_reason='服务重启，生成中断', completed_at=clock_timestamp()
      WHERE status='running' AND started_at < $1`, [processStartedAt]);
    const { rows } = await this.pool.query<DocumentRow>(`WITH next AS (
        SELECT team_id,id FROM reading_documents WHERE status='queued' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE reading_documents document SET status='running', started_at=clock_timestamp()
      FROM next WHERE document.team_id=next.team_id AND document.id=next.id RETURNING document.*`);
    const row = rows[0];
    return row ? { id: row.id, reviewId: row.review_id } : null;
  }

  async recordSubmission(id: string, submission: ReadingDocumentSubmission): Promise<void> {
    await this.pool.query("UPDATE reading_documents SET submissions=submissions || $2::jsonb WHERE id=$1", [id, JSON.stringify([submission])]);
  }

  async complete(id: string, output: ReadingDocumentOutput): Promise<void> {
    await this.settle(`UPDATE reading_documents SET status='completed', failure_reason=NULL, content=$2, metrics=$3, read_files=$4, model=$5,
      completed_at=clock_timestamp() WHERE id=$1 RETURNING review_id`, [id, JSON.stringify(output.content), JSON.stringify(output.metrics),
      JSON.stringify(output.readFiles), JSON.stringify(output.model)]);
  }

  async fail(id: string, reason: string): Promise<void> {
    await this.settle("UPDATE reading_documents SET status='failed', failure_reason=$2, completed_at=clock_timestamp() WHERE id=$1 AND status<>'completed' RETURNING review_id", [id, reason]);
  }

  async list(reviewId: string): Promise<ReadingDocumentRecord[]> {
    const { rows } = await this.pool.query<DocumentRow>("SELECT * FROM reading_documents WHERE review_id=$1 ORDER BY created_at DESC", [reviewId]);
    return rows.map(record);
  }

  /** 评审先于解读完成时通知被推迟，解读结束时在同一事务里补发；投递按评审去重。 */
  private async settle(statement: string, values: unknown[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ review_id: string }>(statement, values);
      const reviewId = rows[0]?.review_id;
      if (reviewId) {
        const review = await client.query<{ status: string }>("SELECT status FROM reviews WHERE id=$1", [reviewId]);
        if (review.rows[0]?.status === "completed") await enqueueReviewNotifications(client, reviewId);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}
