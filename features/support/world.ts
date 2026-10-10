import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { After, Before, setDefaultTimeout, setWorldConstructor, World } from "@cucumber/cucumber";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { runMigrations } from "../../packages/server/src/db/migrate.js";
import { buildApp } from "../../packages/server/src/http.js";
import { CredentialCipher } from "../../packages/server/src/repositories/credentials.js";
import { RepositoryService } from "../../packages/server/src/repositories/service.js";
import { testServerUrl } from "../../packages/server/src/test-support.js";
import { RepositoryFixtureConnector } from "./repository-fixtures.js";
import { ReviewScenario } from "./review-scenario.js";

export type RepositorySummary = Awaited<ReturnType<RepositoryService["list"]>>[number];

export interface RepositoryResponse {
  repository?: RepositorySummary;
  repositories?: RepositorySummary[];
  created?: boolean;
  permissionNotice?: string;
  error?: { code: string; message: string };
}

export class ApiWorld extends World {
  review!: ReviewScenario;
  readonly connector = new RepositoryFixtureConnector();
  readonly databaseName = `ureview_bdd_${randomUUID().replaceAll("-", "")}`;
  private databaseCreated = false;
  private pool: pg.Pool | undefined;
  private app: FastifyInstance | undefined;
  baseUrl = "";
  actor = "";
  repositoryName = "";
  accessToken = "";
  responseStatus = 0;
  responseBody: RepositoryResponse = {};
  listedRepository: RepositorySummary | undefined;

  async start(): Promise<void> {
    try {
      const admin = new pg.Client({ connectionString: testServerUrl });
      try {
        await admin.connect();
        await admin.query(`CREATE DATABASE ${this.databaseName}`);
        this.databaseCreated = true;
      } finally {
        await admin.end();
      }

      const databaseUrl = new URL(testServerUrl);
      databaseUrl.pathname = `/${this.databaseName}`;
      this.pool = new pg.Pool({ connectionString: databaseUrl.toString() });
      await runMigrations(
        this.pool,
        fileURLToPath(new URL("../../packages/server/migrations", import.meta.url)),
      );
      const repositories = new RepositoryService(
        this.pool,
        this.connector,
        new CredentialCipher(randomBytes(32)),
      );
      this.app = buildApp({ pool: this.pool, repositories });
      this.baseUrl = await this.app.listen({ host: "127.0.0.1", port: 0 });
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "场景启动失败，清理资源时也发生错误");
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    const errors: unknown[] = [];
    const app = this.app;
    this.app = undefined;
    try {
      await app?.close();
    } catch (error) {
      errors.push(error);
    }
    const pool = this.pool;
    this.pool = undefined;
    try {
      await pool?.end();
    } catch (error) {
      errors.push(error);
    }
    if (this.databaseCreated) {
      const admin = new pg.Client({ connectionString: testServerUrl });
      try {
        await admin.connect();
        await admin.query(`DROP DATABASE ${this.databaseName} WITH (FORCE)`);
        this.databaseCreated = false;
      } catch (error) {
        errors.push(error);
      } finally {
        await admin.end().catch((error: unknown) => errors.push(error));
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "清理场景资源失败");
  }

  async request(path: string, body?: object): Promise<{
    status: number;
    body: RepositoryResponse;
  }> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as RepositoryResponse };
  }
}

setDefaultTimeout(30_000);
setWorldConstructor(ApiWorld);

Before({ tags: "@story:repository-onboarding" }, async function (this: ApiWorld) {
  await this.start();
});

After({ tags: "@story:repository-onboarding" }, async function (this: ApiWorld) {
  await this.stop();
});

Before({ tags: "@layer:api and (@story:review-new-pull-request or @story:repository-rules or @story:drill-finding-code or @story:review-summary or @story:prioritize-findings or @story:review-rounds or @story:review-list or @story:pr-design-reading or @story:reading-explains-implementation)", timeout: 60_000 }, async function (this: ApiWorld) {
  this.review = new ReviewScenario();
  await this.review.start();
});

After({ tags: "@layer:api and (@story:review-new-pull-request or @story:repository-rules or @story:drill-finding-code or @story:review-summary or @story:prioritize-findings or @story:review-rounds or @story:review-list or @story:pr-design-reading or @story:reading-explains-implementation)", timeout: 60_000 }, async function (this: ApiWorld) {
  await this.review?.stop();
});
