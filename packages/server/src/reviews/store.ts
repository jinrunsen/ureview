import { enqueueReviewNotifications } from "../collaboration/notifications.js";
import { randomUUID } from "node:crypto";
import type pg from "pg";
import { ReviewError, type FilePatch, type FindingCandidate, type PullRequest, type PullRequestOpened, type ReadRange, type ReviewDetail, type ReviewFinding, type ReviewOutput, type ReviewStatus, type ReviewSummary, type ReviewRule } from "./types.js";
import type { FileGroup } from "./file-groups.js";
import { deriveReviewConclusion, selectVisibleFindings } from "./presentation.js";
import type { ReportSubmission } from "./types.js";
import type { RequirementSource } from "./requirement-sources.js";
import { htmlText } from "./reading-text.js";
import { createCodeAnchor, createCodeFingerprint } from "./anchors.js";
import { compareReviewRounds } from "./comparison.js";
import { loadFindingDispositions } from "./dispositions.js";

interface ReviewRow {
  requirement_sources: RequirementSource[];
  id: string;
  repository_id: string;
  repository_name: string;
  iid: string;
  head_sha: string;
  title: string;
  author: string;
  status: ReviewStatus;
  status_message: string | null;
  failure_reason: string | null;
  pull_request: PullRequest | null;
  read_files: ReadRange[];
  rules: ReviewRule[];
  files: FilePatch[];
  excluded_directories: string[];
  excluded_file_count: number;
  /** 早期轮次保存完整综述，Story 24 起只保存 { fileGroups }；两者都从 fileGroups 读取。 */
  overview: { fileGroups?: FileGroup[] } | null;
  report_submissions: ReportSubmission[];
  round: number;
  trigger: "automatic" | "manual";
  viewed_at: Date | null;
  high_count: number;
  medium_count: number;
  attempts: number;
  created_at: Date;
  completed_at: Date | null;
}

function summarize(row: ReviewRow): ReviewSummary {
  return {
    id: row.id, repositoryId: row.repository_id, repositoryName: row.repository_name,
    iid: Number(row.iid), headSha: row.head_sha, title: row.title, author: row.author,
    status: row.status, statusMessage: row.status_message, failureReason: row.failure_reason,
    round: row.round, trigger: row.trigger, viewedAt: row.viewed_at?.toISOString() ?? null,
    findingCounts: { high: row.high_count ?? 0, medium: row.medium_count ?? 0 },
    createdAt: row.created_at.toISOString(), completedAt: row.completed_at?.toISOString() ?? null,
  };
}

const summaryColumns = `reviews.*, repositories.path_with_namespace AS repository_name,
  counts.high_count, counts.medium_count`;
const summaryJoins = `JOIN repositories ON repositories.id=repository_id
  LEFT JOIN LATERAL (
    SELECT count(*) FILTER (WHERE payload->>'severity'='high')::int AS high_count,
      count(*) FILTER (WHERE payload->>'severity'='medium')::int AS medium_count
    FROM review_findings WHERE review_id=reviews.id AND reviews.status='completed'
  ) counts ON true`;

export interface ReviewJob { id: string; repositoryId: string; iid: number; headSha: string; attempts: number }
export interface ReviewListOptions { repositoryId?: string; status?: ReviewStatus; page: number; pageSize: number }

export class ReviewStore {
  constructor(private readonly pool: pg.Pool) {}

  async enqueue(repositoryId: string, eventId: string, event: PullRequestOpened,
    trigger: "automatic" | "manual" = "automatic",
    resolveEvent?: (hasHistory: boolean) => Promise<PullRequestOpened | null>,
  ): Promise<{ id: string; created: boolean } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 同一 PR 的平台快照读取、投递去重与轮次分配保持顺序，复用同一个连接。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`ureview:review:${repositoryId}:${event.iid}`]);
      const repository = await client.query<{ automatic_review_enabled: boolean }>(
        "SELECT automatic_review_enabled FROM repositories WHERE id=$1 FOR SHARE", [repositoryId]);
      if (!repository.rows[0]) throw new ReviewError("not_found", "仓库不存在");
      if (trigger === "automatic" && !repository.rows[0].automatic_review_enabled) { await client.query("COMMIT"); return null; }
      const delivered = await client.query<{ review_id: string | null; iid: string }>(
        "SELECT review_id, iid FROM review_deliveries WHERE repository_id=$1 AND trigger=$2 AND event_id=$3",
        [repositoryId, trigger, eventId],
      );
      if (delivered.rows[0]) {
        if (Number(delivered.rows[0].iid) !== event.iid) throw new ReviewError("conflict", "投递标识已用于其他 PR");
        await client.query("COMMIT");
        return delivered.rows[0].review_id ? { id: delivered.rows[0].review_id, created: false } : null;
      }
      const history = await client.query("SELECT id FROM reviews WHERE repository_id=$1 AND iid=$2 LIMIT 1", [repositoryId, event.iid]);
      const current = resolveEvent ? await resolveEvent(Boolean(history.rowCount)) : event;
      let result: { id: string; created: boolean } | null = null;
      if (current) {
        const existing = trigger === "automatic" ? await client.query<{ id: string }>(
          `SELECT id FROM reviews WHERE repository_id=$1 AND iid=$2 AND trigger='automatic' AND head_sha=$3
           AND round > COALESCE((SELECT max(round) FROM reviews WHERE repository_id=$1 AND iid=$2 AND head_sha<>$3),0)
           ORDER BY round DESC LIMIT 1`,
          [repositoryId, current.iid, current.headSha],
        ) : { rows: [] };
        if (existing.rows[0]) result = { id: existing.rows[0].id, created: false };
        else {
          const id = randomUUID();
          await client.query(
            `INSERT INTO reviews (id, repository_id, event_id, iid, head_sha, title, author, trigger, round)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,COALESCE(max(round),0)+1 FROM reviews WHERE repository_id=$2 AND iid=$4`,
            [id, repositoryId, eventId, current.iid, current.headSha, current.title, current.author, trigger],
          );
          result = { id, created: true };
        }
      }
      await client.query(
        "INSERT INTO review_deliveries (repository_id, trigger, event_id, iid, review_id) VALUES ($1,$2,$3,$4,$5)",
        [repositoryId, trigger, eventId, event.iid, result?.id ?? null],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof Error && "code" in error && error.code === "23505" && "constraint" in error &&
        ["reviews_delivery", "review_deliveries_pkey"].includes(String(error.constraint))) {
        throw new ReviewError("conflict", "投递标识已用于其他 PR");
      }
      throw error;
    } finally { client.release(); }
  }

  async claim(): Promise<ReviewJob | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // 与仓库删除保持相同锁顺序：仓库在前，评审在后；跳过正在删除的仓库。
      const candidates = await client.query<{ id: string }>(`SELECT repository.id FROM repositories repository
        WHERE EXISTS(SELECT 1 FROM reviews WHERE repository_id=repository.id AND status='queued' AND available_at<=now())
        ORDER BY (SELECT min(created_at) FROM reviews WHERE repository_id=repository.id AND status='queued'),repository.id
        FOR SHARE OF repository SKIP LOCKED`);
      let row: ReviewRow | undefined;
      for (const repository of candidates.rows) {
        const claimed = await client.query<ReviewRow>(`WITH next AS (
          SELECT id FROM reviews WHERE repository_id=$1 AND status='queued' AND available_at<=now()
          ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
        ) UPDATE reviews SET status='running',status_message=NULL,attempts=attempts+1
          FROM next WHERE reviews.id=next.id RETURNING reviews.*`, [repository.id]);
        row = claimed.rows[0];
        if (row) break;
      }
      await client.query("COMMIT");
      return row ? { id: row.id, repositoryId: row.repository_id, iid: Number(row.iid), headSha: row.head_sha, attempts: row.attempts } : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async setPullRequest(id: string, pr: PullRequest): Promise<void> {
    await this.pool.query("UPDATE reviews SET title=$2, author=$3, pull_request=$4 WHERE id=$1", [id, pr.title, pr.author, JSON.stringify(pr)]);
  }

  async setFiles(id: string, files: FilePatch[], statusMessage: string | null = null): Promise<void> {
    await this.pool.query("UPDATE reviews SET files=$2, status_message=$3 WHERE id=$1", [id, JSON.stringify(files), statusMessage]);
  }

  async setScope(id: string, scope: ReviewDetail["scope"]): Promise<void> {
    await this.pool.query("UPDATE reviews SET excluded_directories=$2, excluded_file_count=$3 WHERE id=$1",
      [id, JSON.stringify(scope.excludedDirectories), scope.excludedFileCount]);
  }

  async reportFinding(reviewId: string, finding: FindingCandidate): Promise<void> {
    if (finding.severity === "low") return;
    await this.pool.query("INSERT INTO review_findings (id,review_id,payload) VALUES ($1,$2,$3)", [finding.id, reviewId, JSON.stringify(finding)]);
  }

  async setRules(id: string, rules: ReviewRule[]): Promise<void> {
    await this.pool.query("UPDATE reviews SET rules=$2 WHERE id=$1", [id, JSON.stringify(rules)]);
  }

  async recordSubmission(id: string, submission: ReportSubmission): Promise<void> {
    await this.pool.query("UPDATE reviews SET report_submissions=report_submissions || $2::jsonb WHERE id=$1",
      [id, JSON.stringify([submission])]);
  }

  async setRequirementSources(id: string, sources: RequirementSource[]): Promise<void> {
    await this.pool.query("UPDATE reviews SET requirement_sources=$2 WHERE id=$1", [id, JSON.stringify(sources)]);
  }

  async complete(id: string, output: ReviewOutput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM review_findings WHERE review_id=$1", [id]);
      for (const finding of output.findings.filter((item) => item.severity !== "low")) {
        await client.query("INSERT INTO review_findings (id,review_id,payload) VALUES ($1,$2,$3)",
          [finding.id, id, JSON.stringify({ ...finding, fingerprint: createCodeFingerprint(finding.code) })]);
      }
      await client.query(
        "UPDATE reviews SET status='completed', failure_reason=NULL, read_files=$2, overview=$3, completed_at=now() WHERE id=$1",
        [id, JSON.stringify(output.readFiles), JSON.stringify({ fileGroups: output.fileGroups })],
      );
      await enqueueReviewNotifications(client, id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async skip(id: string, message: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM review_findings WHERE review_id=$1", [id]);
      await client.query(
        `UPDATE reviews SET status='completed', status_message=$2, failure_reason=NULL,
         read_files='[]', rules='[]', overview=NULL, completed_at=now() WHERE id=$1`, [id, message],
      );
      await enqueueReviewNotifications(client, id);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async retry(id: string, delayMs: number): Promise<void> {
    await this.pool.query(
      "UPDATE reviews SET status='queued', status_message='代码平台尚未准备好本次提交的 diff，正在等待', available_at=now()+$2*interval '1 millisecond' WHERE id=$1",
      [id, delayMs],
    );
  }

  async fail(id: string, reason: string, code = "operation_failed"): Promise<void> {
    const safeCode = /^[a-z][a-z0-9_]{0,80}$/.test(code) ? code : "operation_failed";
    await this.pool.query("UPDATE reviews SET status='failed', status_message=NULL, failure_reason=$2, failure_code=$3, completed_at=now() WHERE id=$1", [id, reason, safeCode]);
  }

  async markViewed(id: string): Promise<string> {
    const { rows } = await this.pool.query<{ viewed_at: Date }>(
      "UPDATE reviews SET viewed_at=COALESCE(viewed_at, now()) WHERE id=$1 AND status='completed' RETURNING viewed_at", [id],
    );
    if (rows[0]) return rows[0].viewed_at.toISOString();
    const exists = await this.pool.query("SELECT id FROM reviews WHERE id=$1", [id]);
    if (!exists.rowCount) throw new ReviewError("not_found", "评审不存在");
    throw new ReviewError("conflict", "评审完成后才能标记已查看");
  }

  async list(repositoryId: string): Promise<ReviewSummary[]> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT ${summaryColumns} FROM reviews ${summaryJoins} WHERE repository_id=$1 ORDER BY reviews.created_at DESC, reviews.id`,
      [repositoryId],
    );
    return rows.map(summarize);
  }

  async history(repositoryId: string, iid: number): Promise<ReviewSummary[]> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT ${summaryColumns} FROM reviews ${summaryJoins} WHERE repository_id=$1 AND iid=$2 ORDER BY round DESC`,
      [repositoryId, iid],
    );
    return rows.map(summarize);
  }

  async listLatest(options: ReviewListOptions): Promise<{ reviews: ReviewSummary[]; total: number; page: number; pageSize: number }> {
    const latest = `WITH latest AS (
      SELECT DISTINCT ON (repository_id, iid) * FROM reviews ORDER BY repository_id, iid, round DESC
    ), filtered AS (
      SELECT * FROM latest WHERE ($1::uuid IS NULL OR repository_id=$1) AND ($2::text IS NULL OR status=$2)
    )`;
    const params = [options.repositoryId ?? null, options.status ?? null];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const count = await client.query<{ total: number }>(`${latest} SELECT count(*)::int AS total FROM filtered`, params);
      const { rows } = await client.query<ReviewRow>(
        `${latest} SELECT ${summaryColumns} FROM filtered AS reviews ${summaryJoins}
         ORDER BY reviews.created_at DESC, reviews.id DESC LIMIT $3 OFFSET $4`,
        [...params, options.pageSize, (options.page - 1) * options.pageSize],
      );
      await client.query("COMMIT");
      return { reviews: rows.map(summarize), total: count.rows[0]!.total, page: options.page, pageSize: options.pageSize };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async get(id: string): Promise<ReviewDetail | null> {
    const { rows } = await this.pool.query<ReviewRow>(
      `SELECT ${summaryColumns} FROM reviews ${summaryJoins} WHERE reviews.id=$1`, [id],
    );
    const row = rows[0];
    if (!row) return null;
    const findings = row.status === "completed" ? await this.loadFindings(id) : [];
    const previous = row.status === "completed" ? (await this.pool.query<{ id: string; round: number }>(
      `SELECT id, round FROM reviews WHERE repository_id=$1 AND iid=$2 AND round<$3 AND status='completed'
       ORDER BY round DESC LIMIT 1`, [row.repository_id, row.iid, row.round],
    )).rows[0] : undefined;
    const compared = compareReviewRounds(findings, previous ? { ...previous, findings: await this.loadFindings(previous.id) } : null);
    const presentation = selectVisibleFindings(compared.findings);
    const summary = await this.pool.query<{ summary: string | null }>(`SELECT content->'sections'->>'summary' AS summary FROM reading_documents
      WHERE review_id=$1 AND status='completed' ORDER BY completed_at DESC LIMIT 1`, [id]);
    return {
      ...summarize(row), ...presentation, conclusion: deriveReviewConclusion(row.status, presentation.findings),
      comparison: compared.comparison, pullRequest: row.pull_request,
      requirementSources: row.requirement_sources, readingSummary: summary.rows[0]?.summary ? htmlText(summary.rows[0].summary) || null : null,
      reportSubmissions: row.report_submissions,
      readFiles: row.read_files, rules: row.rules, files: row.files, fileGroups: row.status === "completed" ? row.overview?.fileGroups ?? [] : [],
      scope: { excludedDirectories: row.excluded_directories, excludedFileCount: row.excluded_file_count },
    };
  }

  private async loadFindings(id: string): Promise<ReviewFinding[]> {
    const { rows } = await this.pool.query<{ payload: ReviewFinding }>(
      "SELECT payload FROM review_findings WHERE review_id=$1 ORDER BY id", [id],
    );
    const dispositions = await loadFindingDispositions(this.pool, id);
    return rows.map(({ payload }) => {
      const disposition = dispositions.get(payload.id);
      // 中危挂锚之前保存的 finding 没有锚，读取时按生成时的同一规则补上。
      return { ...payload,
        ...(typeof payload.code === "string" ? { fingerprint: payload.fingerprint ?? createCodeFingerprint(payload.code),
          anchor: payload.anchor ?? createCodeAnchor(payload, payload.code) } : {}),
        ...(disposition ? { status: disposition.status, disposition } : {}),
      };
    });
  }
}
