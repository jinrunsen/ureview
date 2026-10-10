import { registerCompression } from "./compression.js";
import { RuleImportService, registerRuleImportRoutes } from "./rules/imports.js";
import type { ImportGenerator } from "./runtime/import-generator.js";
import { registerSsoLogin } from "./auth/sso-http.js";
import { registerSsoConfiguration, type SsoConfiguration } from "./auth/sso-config.js";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type pg from "pg";
import { RepositoryAccessError, type RepositoryAccessInput } from "./repositories/connector.js";
import { PERMISSION_NOTICE, type RepositoryService } from "./repositories/service.js";
import type { ReviewService } from "./reviews/service.js";
import { ReviewError } from "./reviews/types.js";
import type { ReviewListOptions } from "./reviews/store.js";
import { AuthError } from "./auth/context.js";
import { registerCollaborationRoutes } from "./collaboration/http.js";
import type { CollaborationService } from "./collaboration/service.js";
import { CollaborationError } from "./collaboration/types.js";
import { registerRuleCatalogRoutes, type RuleCatalogService } from "./rules/catalog.js";
import { installAuthentication } from "./auth/http.js";
import type { AuthService } from "./auth/service.js";
import { registerManagedRuleRoutes, type ManagedRuleService } from "./rules/managed.js";
import type { RuleDraftGenerator } from "./rules/managed-types.js";
import { registerRuleSessionRoutes, RuleSessionService } from "./rules/sessions.js";
import type { RuleConversationGenerator } from "./rules/sessions-types.js";
import { registerRuleLibraryRoutes, type RuleLibraryService } from "./rules/library.js";
import { registerRuleProposalRoutes } from "./rules/proposals.js";
import { registerRuleDetailRoutes } from "./rules/detail.js";
import { registerReviewSettingsRoutes } from "./reviews/settings.js";

import { registerServiceSettingsRoutes } from "./service-settings/http.js";
import type { ServiceSettings } from "./service-settings/service.js";
import { logEvent } from "./logging.js";
import { registerAgentSessionRoutes } from "./agent-sessions/http.js";
import { registerDispositionRoutes } from "./reviews/disposition-http.js";
import { registerRepositoryDetailRoutes } from "./repositories/http.js";
import { RepositoryDeletionService } from "./repositories/deletion.js";
import { RepositoryWebhookService } from "./repositories/webhooks.js";
import { registerInboxRoutes } from "./inbox/http.js";
import { InboxService } from "./inbox/service.js";
import { registerTeamOverviewRoutes } from "./team-overview/http.js";
import { registerInstanceHealthRoutes } from "./instance-health/http.js";
import { InstanceHealthService } from "./instance-health/service.js";
import type { ReadingDocumentStore } from "./reviews/reading-document-store.js";

export interface AppDependencies {
  serviceSettings?: ServiceSettings;
  ssoConfiguration?: SsoConfiguration;
  collaboration?: CollaborationService;
  catalog?: RuleCatalogService;
  managedRules?: ManagedRuleService;
  ruleLibrary?: RuleLibraryService;
  importGenerator?: ImportGenerator;
  startImportWorker?: boolean;
  ruleGenerator?: RuleDraftGenerator;
  ruleConversationGenerator?: RuleConversationGenerator;
  pool: pg.Pool;
  repositories?: RepositoryService;
  webDir?: string;
  worktreeDir?: string;
  sessionViewerDir?: string;
  reviews?: ReviewService;
  webhookToken?: string;
  auth?: AuthService;
  publicOrigin?: string;
  readingDocuments?: ReadingDocumentStore;
}

type Availability = "ok" | "error";

/** 健康检查的回答。database 单独列出来，是为了让排障的人一眼看出坏在哪一层。 */
interface HealthReport {
  status: Availability;
  database: Availability;
}

export function buildApp({ pool, repositories, webDir, worktreeDir, sessionViewerDir, reviews, webhookToken, auth, collaboration, catalog, managedRules, ruleLibrary, importGenerator, startImportWorker, ruleGenerator, ruleConversationGenerator, publicOrigin = "http://localhost:3000", serviceSettings, readingDocuments, ssoConfiguration }: AppDependencies): FastifyInstance {
  const app = Fastify({ logger: false });
  registerCompression(app);
  app.addHook("onResponse", async (request, reply) => {
    if (request.routeOptions.url === "/health") return;
    logEvent("http.response", { requestId: request.id, method: request.method,
      route: request.routeOptions.url ?? "unmatched", status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime) });
  });
  const webhookAuthentication = repositories ? registerRepositoryDetailRoutes(app, { repositories,
    deletion: new RepositoryDeletionService(pool, worktreeDir),
    webhooks: new RepositoryWebhookService(pool, repositories, publicOrigin, Boolean(webhookToken)), authenticated: Boolean(auth),
    ...(reviews ? { reviews } : {}), ...(webhookToken ? { webhookToken } : {}) }) : undefined;
  if (ssoConfiguration) registerSsoConfiguration(app, ssoConfiguration);
  if (auth) installAuthentication(app, auth, publicOrigin, webhookToken, webhookAuthentication);

  if (auth && ssoConfiguration) registerSsoLogin(app, auth, ssoConfiguration);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthError || error instanceof CollaborationError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    const status = error instanceof Error && "statusCode" in error ? error.statusCode : undefined;
    if ((error instanceof Error && "validation" in error) || status === 400 || status === 413 || status === 415) {
      return reply.code(status === 413 ? 413 : 400).send({
        error: { code: "invalid_input", message: request.routeOptions.url === "/api/repositories" && request.method === "POST"
          ? "请填写 GitLab 实例地址、仓库路径和访问令牌" : "请求参数不正确" },
      });
    }
    if (error instanceof RepositoryAccessError) {
      const statuses = { invalid_input: 400, access_denied: 422, invalid_scope: 422, unavailable: 502, invalid_response: 502 };
      return reply.code(statuses[error.code]).send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof ReviewError) {
      const code = error.code === "not_found" ? 404
        : ["invalid_event", "invalid_pull_request_url"].includes(error.code) ? 400
        : error.code === "repository_not_connected" ? 422 : ["conflict", "automatic_review_conflict"].includes(error.code) ? 409 : 502;
      return reply.code(code).send({ error: { code: error.code, message: error.message } });
    }
    return reply.code(500).send({ error: { code: "internal_error", message: "操作未完成，请稍后重试" } });
  });

  app.get("/health", async (_request, reply) => {
    let database: Availability = "ok";
    try {
      await pool.query("SELECT 1");
    } catch {
      database = "error";
    }

    // 连不上库就明说不健康。这里返回 200 的话，compose 会以为服务起好了。
    const report: HealthReport = { status: database, database };
    return reply.code(database === "ok" ? 200 : 503).send(report);
  });

  if (repositories) {
    app.get("/api/repositories", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { repositories: await repositories.list(), permissionNotice: PERMISSION_NOTICE };
    });
    app.post<{ Body: RepositoryAccessInput }>("/api/repositories", {
      bodyLimit: 16_384,
      schema: {
        body: {
          type: "object",
          required: ["instanceUrl", "projectPath", "token"],
          additionalProperties: false,
          properties: {
            instanceUrl: { type: "string", minLength: 1, maxLength: 2048 },
            projectPath: { type: "string", minLength: 1, maxLength: 1024 },
            token: { type: "string", minLength: 1, maxLength: 4096 },
          },
        },
      },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const result = await repositories.connect(request.body);
      return reply.code(result.created ? 201 : 200).send({ ...result, permissionNotice: PERMISSION_NOTICE });
    });
  }

  if (webDir) void app.register(fastifyStatic, { root: webDir, wildcard: false });
  if (sessionViewerDir) void app.register(fastifyStatic, { root: sessionViewerDir, prefix: "/agent-session-viewer/",
    decorateReply: !webDir, setHeaders(response) { response.header("Content-Security-Policy", "frame-ancestors 'self'"); } });

  if (reviews) {
    if (auth) registerInboxRoutes(app, new InboxService(pool, reviews.store));
    registerDispositionRoutes(app, pool);
    const identifier = { type: "string", format: "uuid" };
    const reviewParams = { type: "object", required: ["id"], properties: { id: identifier } };
    app.post<{ Body: { url: string; requestId: string } }>("/api/reviews", {
      bodyLimit: 4096,
      schema: { body: {
        type: "object", required: ["url", "requestId"], additionalProperties: false,
        properties: { url: { type: "string", minLength: 1, maxLength: 2048 }, requestId: identifier },
      } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reply.code(202).send(await reviews.startFromUrl(request.body.url, request.body.requestId));
    });
    app.get<{ Querystring: ReviewListOptions }>("/api/reviews", {
      schema: { querystring: {
        type: "object", additionalProperties: false,
        properties: {
          repositoryId: identifier,
          status: { type: "string", enum: ["queued", "running", "completed", "failed"] },
          page: { type: "integer", minimum: 1, maximum: 1_000_000, default: 1 },
          pageSize: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        },
      } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return reviews.store.listLatest(request.query);
    });
    app.get<{ Params: { repositoryId: string; iid: number } }>("/api/repositories/:repositoryId/pull-requests/:iid/reviews", {
      schema: { params: {
        type: "object", required: ["repositoryId", "iid"],
        properties: { repositoryId: identifier, iid: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER } },
      } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { reviews: await reviews.store.history(request.params.repositoryId, request.params.iid) };
    });
    app.post<{ Params: { id: string }; Body: { requestId: string } }>("/api/reviews/:id/rerun", {
      bodyLimit: 1024,
      schema: { params: reviewParams, body: {
        type: "object", required: ["requestId"], additionalProperties: false, properties: { requestId: identifier },
      } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const result = await reviews.rerun(request.params.id, request.body.requestId);
      return reply.code(result.created ? 202 : 200).send({ reviewId: result.id, created: result.created });
    });
    app.post<{ Params: { id: string } }>("/api/reviews/:id/viewed", {
      schema: { params: reviewParams },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return collaboration ? collaboration.markViewed(request.params.id) : { viewedAt: await reviews.store.markViewed(request.params.id) };
    });
    app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/reviews", {
      schema: { params: { type: "object", required: ["repositoryId"], properties: { repositoryId: identifier } } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { reviews: await reviews.store.list(request.params.repositoryId) };
    });
    app.get<{ Params: { id: string } }>("/api/reviews/:id", {
      schema: { params: { type: "object", required: ["id"], properties: { id: identifier } } },
    }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const review = await reviews.store.get(request.params.id);
      if (!review) throw new ReviewError("not_found", "评审不存在");
      return { review };
    });
    if (readingDocuments) {
      app.get<{ Params: { id: string } }>("/api/reviews/:id/reading-documents", { schema: { params: reviewParams } }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        return { documents: await readingDocuments.list(request.params.id) };
      });
      app.post<{ Params: { id: string } }>("/api/reviews/:id/reading-documents", { schema: { params: reviewParams } }, async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        return reply.code(202).send({ document: await readingDocuments.requestRegeneration(request.params.id) });
      });
    }
  }

  if (auth) {
    registerTeamOverviewRoutes(app, pool);
    registerInstanceHealthRoutes(app, new InstanceHealthService(pool, serviceSettings));
  }
  if (collaboration) registerCollaborationRoutes(app, { service: collaboration });
  if (catalog && repositories) registerRuleCatalogRoutes(app, { pool, repositories, service: catalog });
  const ruleSessions = auth && managedRules ? new RuleSessionService(pool, ruleConversationGenerator) : undefined;
  const generateRule = ruleSessions && ruleConversationGenerator ? async (intent: string) => {
    const created = await ruleSessions.create({});
    const updated = await ruleSessions.turn(created.id, { version: created.version, message: intent });
    const turn = updated.turns.at(-1);
    if (turn?.status !== "completed" || !turn.draft) throw new ReviewError(turn?.errorCode ?? "rule_generation_failed", turn?.error ?? "规范生成未完成");
    return turn.draft;
  } : ruleGenerator;
  if (managedRules && repositories) registerManagedRuleRoutes(app, { pool, repositories,
    ...(generateRule ? { generator: generateRule } : {}) });
  if (auth && managedRules) registerRuleSessionRoutes(app, { pool,
    ...(ruleConversationGenerator ? { generator: ruleConversationGenerator } : {}), ...(ruleSessions ? { service: ruleSessions } : {}) });
  if (auth && managedRules) {
    registerRuleImportRoutes(app, new RuleImportService(pool, importGenerator), startImportWorker);
    registerRuleLibraryRoutes(app, { pool, ...(ruleLibrary ? { service: ruleLibrary } : {}) });
    registerRuleProposalRoutes(app, { pool });
    registerRuleDetailRoutes(app, { pool });
  }
  registerReviewSettingsRoutes(app, pool);
  registerAgentSessionRoutes(app, pool);
  if (serviceSettings) registerServiceSettingsRoutes(app, serviceSettings);
  return app;
}
