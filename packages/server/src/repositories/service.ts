import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RepositoryAccessInput, RepositoryConnector } from "./connector.js";
import type { CredentialCipher } from "./credentials.js";
import { ReviewError, type RepositoryCredentials } from "../reviews/types.js";
import { requireAdmin } from "../auth/context.js";

export const PERMISSION_NOTICE = "只读接入，不会向 GitLab 写入任何内容";

export interface RepositorySummary {
  id: string;
  instanceUrl: string;
  projectId: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  connectionStatus: "connected";
  connectedAt: string;
  automaticReviewEnabled: boolean;
  automaticReviewVersion: number;
  lastAuthenticationFailureAt: string | null;
}

interface RepositoryRow {
  id: string;
  instance_url: string;
  project_id: string;
  name: string;
  path_with_namespace: string;
  web_url: string;
  connected_at: Date;
  automatic_review_enabled: boolean;
  automatic_review_version: number;
  last_authentication_failure_at: Date | null;
}

const PUBLIC_COLUMNS = `id, instance_url, project_id, name, path_with_namespace, web_url, connected_at,
  automatic_review_enabled, automatic_review_version, last_authentication_failure_at`;

function summarize(row: RepositoryRow): RepositorySummary {
  return {
    id: row.id,
    instanceUrl: row.instance_url,
    projectId: Number(row.project_id),
    name: row.name,
    pathWithNamespace: row.path_with_namespace,
    webUrl: row.web_url,
    connectionStatus: "connected",
    connectedAt: row.connected_at.toISOString(),
    automaticReviewEnabled: row.automatic_review_enabled,
    automaticReviewVersion: row.automatic_review_version,
    lastAuthenticationFailureAt: row.last_authentication_failure_at?.toISOString() ?? null,
  };
}

export class RepositoryService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly connector: RepositoryConnector,
    private readonly cipher: CredentialCipher,
  ) {}

  async connect(input: RepositoryAccessInput): Promise<{ repository: RepositorySummary; created: boolean }> {
    const project = await this.connector.verify(input);
    const ciphertext = this.cipher.encrypt(input.token, `${project.instanceUrl}#${project.projectId}`);
    const inserted = await this.pool.query<RepositoryRow>(
      `INSERT INTO repositories
        (id, instance_url, project_id, name, path_with_namespace, web_url, http_url_to_repo, credential_ciphertext)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (team_id, instance_url, project_id) DO NOTHING RETURNING ${PUBLIC_COLUMNS}`,
      [randomUUID(), project.instanceUrl, project.projectId, project.name,
        project.pathWithNamespace, project.webUrl, project.httpUrlToRepo, ciphertext],
    );
    const created = inserted.rows[0];
    if (created) return { repository: summarize(created), created: true };

    // 单独读取让并发 INSERT 提交的记录对当前查询可见；重复接入不更新旧凭据或探测时间。
    const existing = await this.pool.query<RepositoryRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM repositories WHERE instance_url = $1 AND project_id = $2`,
      [project.instanceUrl, project.projectId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("无法读取已接入的仓库");
    return { repository: summarize(row), created: false };
  }

  async list(): Promise<RepositorySummary[]> {
    const result = await this.pool.query<RepositoryRow>(
      `SELECT ${PUBLIC_COLUMNS} FROM repositories ORDER BY connected_at DESC, id`,
    );
    return result.rows.map(summarize);
  }

  async get(id: string): Promise<RepositorySummary> {
    const result = await this.pool.query<RepositoryRow>(`SELECT ${PUBLIC_COLUMNS} FROM repositories WHERE id=$1`, [id]);
    if (!result.rows[0]) throw new ReviewError("not_found", "仓库不存在");
    return summarize(result.rows[0]);
  }

  async setAutomaticReview(id: string, enabled: boolean, version: number): Promise<RepositorySummary> {
    requireAdmin();
    await this.get(id);
    const result = await this.pool.query<RepositoryRow>(`UPDATE repositories SET automatic_review_enabled=$2,
      automatic_review_version=automatic_review_version+1 WHERE id=$1 AND automatic_review_version=$3 RETURNING ${PUBLIC_COLUMNS}`,
    [id, enabled, version]);
    if (!result.rows[0]) throw new ReviewError("automatic_review_conflict", "自动评审配置已被其他人更新，请读取最新配置后重新核对并保存");
    return summarize(result.rows[0]);
  }

  async recordAuthenticationFailure(id: string): Promise<void> {
    await this.pool.query("UPDATE repositories SET last_authentication_failure_at=clock_timestamp() WHERE id=$1", [id]);
  }

  async findByGitLabPath(origin: string, repositoryPath: string): Promise<RepositorySummary | undefined> {
    return (await this.list()).find((repository) => {
      const instance = new URL(repository.instanceUrl);
      const prefix = instance.pathname.split("/").filter(Boolean).map(decodeURIComponent).join("/");
      const path = [prefix, repository.pathWithNamespace].filter(Boolean).join("/");
      return instance.origin === origin && path === repositoryPath;
    });
  }

  async getCredentials(id: string): Promise<RepositoryCredentials> {
    const { rows } = await this.pool.query<RepositoryRow & { http_url_to_repo: string; credential_ciphertext: Buffer }>(
      `SELECT ${PUBLIC_COLUMNS}, http_url_to_repo, credential_ciphertext FROM repositories WHERE id = $1`, [id],
    );
    const row = rows[0];
    if (!row) throw new ReviewError("not_found", "仓库不存在");
    return {
      id: row.id, instanceUrl: row.instance_url, projectId: Number(row.project_id),
      pathWithNamespace: row.path_with_namespace, webUrl: row.web_url, httpUrlToRepo: row.http_url_to_repo,
      token: this.cipher.decrypt(row.credential_ciphertext, `${row.instance_url}#${row.project_id}`),
    };
  }

  async assertCredentialsReadable(): Promise<void> {
    const { rows } = await this.pool.query<{
      instance_url: string; project_id: string; credential_ciphertext: Buffer;
    }>("SELECT instance_url, project_id, credential_ciphertext FROM repositories");
    for (const row of rows) {
      this.cipher.decrypt(row.credential_ciphertext, `${row.instance_url}#${row.project_id}`);
    }
  }
}
