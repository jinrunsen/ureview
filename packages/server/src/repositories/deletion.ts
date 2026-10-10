import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type pg from "pg";
import { AuthError, requireAdmin } from "../auth/context.js";
import { logEvent } from "../logging.js";
import { lockRuleHierarchy } from "../rules/managed/relations.js";
import { ReviewError } from "../reviews/types.js";

export interface RepositoryDeletionCounts {
  reviews: number;
  findings: number;
  discussionComments: number;
  agentSessions: number;
  webhookEvents: number;
  repositoryRules: number;
  historicalCandidates: number;
  managedRules: number;
}

export interface RepositoryDeletionPreview {
  repositoryId: string;
  pathWithNamespace: string;
  counts: RepositoryDeletionCounts;
  runningReviews: number;
}

const reviewIds = "SELECT id FROM reviews WHERE repository_id=$1";
const commentIds = `SELECT id FROM discussion_comments WHERE review_id IN (${reviewIds})`;
const sessionIds = `SELECT id FROM agent_sessions WHERE review_id IN (${reviewIds})`;
const proposalIds = `SELECT id FROM rule_proposals WHERE repository_id=$1
  OR candidate_id IN (SELECT id FROM rule_candidates WHERE repository_id=$1)`;

async function preview(query: Pick<pg.PoolClient, "query">, repositoryId: string): Promise<RepositoryDeletionPreview> {
  const { rows } = await query.query<{ path_with_namespace: string; counts: RepositoryDeletionCounts; running_reviews: number }>(`
    SELECT path_with_namespace,
      (SELECT count(*)::int FROM reviews WHERE repository_id=$1 AND status='running') AS running_reviews,
      jsonb_build_object(
        'reviews', (SELECT count(*)::int FROM reviews WHERE repository_id=$1),
        'findings', (SELECT count(*)::int FROM review_findings WHERE review_id IN (${reviewIds})),
        'discussionComments', (SELECT count(*)::int FROM discussion_comments WHERE review_id IN (${reviewIds})),
        'agentSessions', (SELECT count(*)::int FROM agent_sessions WHERE review_id IN (${reviewIds})),
        'webhookEvents', (SELECT count(*)::int FROM repository_webhook_events WHERE repository_id=$1),
        'repositoryRules', (SELECT count(*)::int FROM rule_catalog WHERE repository_id=$1),
        'historicalCandidates', (SELECT count(*)::int FROM rule_candidates WHERE repository_id=$1),
        'managedRules', (SELECT count(*)::int FROM managed_rule_repositories WHERE repository_id=$1)
      ) AS counts FROM repositories WHERE id=$1`, [repositoryId]);
  const row = rows[0];
  if (!row) throw new ReviewError("not_found", "仓库不存在");
  return { repositoryId, pathWithNamespace: row.path_with_namespace, counts: row.counts, runningReviews: row.running_reviews };
}

/** 工作副本按评审 UUID 存放；只移除事务内读取的直属目录，rm 不跟随目录符号链接。 */
export async function cleanupRepositoryWorkspaces(worktreeDir: string, repositoryId: string, ids: string[]): Promise<void> {
  const root = resolve(worktreeDir);
  for (const id of ids) {
    try {
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error("评审标识不正确");
      await rm(join(root, id), { recursive: true, force: true });
    } catch {
      logEvent("repository.workspace_cleanup_failed", { repositoryId, reviewId: id });
    }
  }
}

export class RepositoryDeletionService {
  constructor(private readonly pool: pg.Pool, private readonly worktreeDir?: string) {}

  async preview(repositoryId: string): Promise<RepositoryDeletionPreview> {
    requireAdmin();
    return preview(this.pool, repositoryId);
  }

  async delete(repositoryId: string, pathWithNamespace: string): Promise<RepositoryDeletionPreview> {
    const actor = requireAdmin();
    const client = await this.pool.connect();
    let result: RepositoryDeletionPreview;
    let workspaces: string[];
    const deleted: Record<string, number> = {};
    try {
      await client.query("BEGIN");
      await lockRuleHierarchy(client, actor.teamId);
      // 领取任务与创建新轮次先锁仓库，删除持有排他锁后不会再启动该仓库的评审。
      const repository = await client.query<{ path_with_namespace: string }>(
        "SELECT path_with_namespace FROM repositories WHERE id=$1 FOR UPDATE", [repositoryId]);
      if (!repository.rows[0]) throw new ReviewError("not_found", "仓库不存在");
      if (repository.rows[0].path_with_namespace !== pathWithNamespace) {
        throw new AuthError(400, "repository_path_mismatch", "输入的仓库路径不一致，请完整输入仓库路径");
      }
      const reviews = await client.query<{ id: string; status: string }>("SELECT id,status FROM reviews WHERE repository_id=$1 FOR UPDATE", [repositoryId]);
      if (reviews.rows.some((row) => row.status === "running")) {
        throw new AuthError(409, "repository_review_running", "仓库有进行中的评审，请等待评审结束后再删除");
      }
      workspaces = reviews.rows.map((row) => row.id);
      // 锁住评论和反馈的父记录，数量统计完成后不再接受新的关联数据。
      await client.query(`SELECT id FROM review_findings WHERE review_id IN (${reviewIds}) FOR UPDATE`, [repositoryId]);
      await client.query(`SELECT id FROM discussion_comments WHERE review_id IN (${reviewIds}) FOR UPDATE`, [repositoryId]);
      await client.query(`SELECT id FROM rule_proposals WHERE id IN (${proposalIds})
        OR id IN (SELECT proposal_id FROM rule_proposal_feedback WHERE review_id IN (${reviewIds}))
        ORDER BY id FOR UPDATE`, [repositoryId]);
      await client.query(`${sessionIds} FOR UPDATE`, [repositoryId]);
      result = await preview(client, repositoryId);
      const remove = async (table: string, condition: string) => {
        deleted[table] = (await client.query(`DELETE FROM ${table} WHERE ${condition}`, [repositoryId])).rowCount ?? 0;
      };
      const affectedFeedback = await client.query<{ proposal_id: string }>(`SELECT DISTINCT proposal_id FROM rule_proposal_feedback
        WHERE review_id IN (${reviewIds})`, [repositoryId]);
      await remove("rule_proposal_feedback", `review_id IN (${reviewIds}) OR proposal_id IN (${proposalIds})`);
      await remove("rule_proposals", `id IN (${proposalIds})`);
      if (affectedFeedback.rows.length) {
        await client.query(`UPDATE rule_proposals proposal SET status='withdrawn'
          WHERE id=ANY($1::uuid[]) AND source='feedback' AND status='pending'
          AND NOT EXISTS(SELECT 1 FROM rule_proposal_feedback feedback WHERE feedback.proposal_id=proposal.id)`,
        [affectedFeedback.rows.map((row) => row.proposal_id)]);
      }
      await remove("notification_deliveries", `review_id IN (${reviewIds}) OR comment_id IN (${commentIds})`);
      await remove("discussion_notifications", `comment_id IN (${commentIds})`);
      await remove("discussion_comments", `review_id IN (${reviewIds})`);
      await remove("finding_disposition_events", `review_id IN (${reviewIds})`);
      await remove("review_participants", `review_id IN (${reviewIds})`);
      await remove("agent_session_events", `session_id IN (${sessionIds})`);
      await remove("agent_sessions", `review_id IN (${reviewIds})`);
      await remove("repository_webhook_events", "repository_id=$1");
      await remove("review_deliveries", `repository_id=$1 OR review_id IN (${reviewIds})`);
      await remove("review_findings", `review_id IN (${reviewIds})`);
      await remove("reviews", "repository_id=$1");
      await remove("repository_review_settings", "repository_id=$1");
      await remove("rule_catalog", "repository_id=$1");
      await remove("rule_sync_state", "repository_id=$1");
      await remove("rule_candidates", "repository_id=$1");
      await remove("managed_rule_waivers", "repository_id=$1");
      await client.query(`UPDATE managed_rules SET version=version+1, updated_by=$2, updated_at=now()
        WHERE id IN (SELECT rule_id FROM managed_rule_repositories WHERE repository_id=$1)`, [repositoryId, actor.userId]);
      await remove("managed_rule_repositories", "repository_id=$1");
      await remove("repositories", "id=$1");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    logEvent("repository.deleted", { actorId: actor.userId, teamId: actor.teamId, repositoryId,
      pathWithNamespace: result.pathWithNamespace, ...result.counts, ...deleted });
    if (this.worktreeDir) await cleanupRepositoryWorkspaces(this.worktreeDir, repositoryId, workspaces);
    return result;
  }
}
