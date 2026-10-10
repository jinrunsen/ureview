import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { requireAdmin, requireIdentity } from "../auth/context.js";
import { normalizeExcludedDirectories } from "./exclusions.js";
import { ReviewError } from "./types.js";

export interface ReviewSettings {
  excludedDirectories: string[];
  version: number;
}

interface SettingsRow { excluded_directories: string[]; version: number }
const invalidMessage = "请填写有效的排除目录和配置版本";
function invalid(): ReviewError { return new ReviewError("invalid_review_settings", invalidMessage); }
function settings(row: SettingsRow): ReviewSettings {
  return { excludedDirectories: row.excluded_directories, version: row.version };
}

export class ReviewSettingsService {
  constructor(private readonly pool: pg.Pool) {}

  async get(repositoryId: string): Promise<ReviewSettings> {
    const result = await this.pool.query<SettingsRow>(`SELECT coalesce(s.excluded_directories,'[]'::jsonb) AS excluded_directories,
        coalesce(s.version,0) AS version FROM repositories r
        LEFT JOIN repository_review_settings s ON s.repository_id=r.id WHERE r.id=$1`, [repositoryId]);
    if (!result.rows[0]) throw new ReviewError("not_found", "仓库不存在");
    return settings(result.rows[0]);
  }

  async save(repositoryId: string, value: unknown): Promise<ReviewSettings> {
    requireAdmin();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
    const input = value as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["excludedDirectories", "version"].includes(key))
      || typeof input.version !== "number" || !Number.isSafeInteger(input.version)
      || input.version < 0 || input.version >= 2_147_483_647) throw invalid();
    const directories = normalizeExcludedDirectories(input.excludedDirectories);
    await this.get(repositoryId);
    const result = input.version === 0
      ? await this.pool.query<SettingsRow>(`INSERT INTO repository_review_settings(repository_id,excluded_directories) VALUES($1,$2)
          ON CONFLICT(repository_id) DO NOTHING RETURNING excluded_directories,version`, [repositoryId, JSON.stringify(directories)])
      : await this.pool.query<SettingsRow>(`UPDATE repository_review_settings SET excluded_directories=$2,version=version+1,updated_at=now()
          WHERE repository_id=$1 AND version=$3 RETURNING excluded_directories,version`, [repositoryId, JSON.stringify(directories), input.version]);
    if (!result.rows[0]) throw new ReviewError("review_settings_conflict", "评审配置已被其他人更新，请读取最新配置后重新核对并保存");
    return settings(result.rows[0]);
  }
}

export function registerReviewSettingsRoutes(app: FastifyInstance, pool: pg.Pool): void {
  const service = new ReviewSettingsService(pool);
  const params = { type: "object", required: ["repositoryId"], properties: {
    repositoryId: { type: "string", format: "uuid" },
  } };
  void app.register(async (routes) => {
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ReviewError && ["invalid_excluded_directories", "invalid_review_settings", "review_settings_conflict"].includes(error.code)) {
        return reply.code(error.code === "review_settings_conflict" ? 409 : 400).send({ error: { code: error.code, message: error.message } });
      }
      if (error instanceof Error && ("validation" in error || ("statusCode" in error && [400, 413, 415].includes(Number(error.statusCode))))) {
        return reply.code(400).send({ error: { code: "invalid_review_settings", message: invalidMessage } });
      }
      throw error;
    });
    routes.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/review-settings", { schema: { params } }, async (request) => {
      requireIdentity();
      return { settings: await service.get(request.params.repositoryId) };
    });
    routes.put<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/review-settings", { bodyLimit: 262_144, schema: { params } },
      async (request) => ({ settings: await service.save(request.params.repositoryId, request.body) }));
  });
}
