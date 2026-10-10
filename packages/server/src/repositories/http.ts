import type { RepositoryDeletionService } from "./deletion.js";
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AuthError, requireIdentity } from "../auth/context.js";
import { currentTeamId, withTeam } from "../db/tenant.js";
import type { ReviewService } from "../reviews/service.js";
import type { RepositoryService } from "./service.js";
import type { RepositoryWebhookService, WebhookOutcome } from "./webhooks.js";

function deliveryId(request: FastifyRequest): unknown {
  const current = request.headers["webhook-id"] ?? request.headers["idempotency-key"];
  if (current !== undefined) return current;
  const legacy = request.headers["x-gitlab-event-uuid"];
  if (typeof legacy !== "string" || !legacy.trim() || legacy.length > 256) return undefined;
  // 递归事件共享 UUID，载荷摘要用于区分同一事件链中的不同通知。
  return `legacy:${createHash("sha256").update(JSON.stringify([legacy, request.body])).digest("hex")}`;
}

export const repositoryWebhookRoute = "/api/repositories/:repositoryId/events/gitlab";
export interface WebhookAuthentication {
  accepted(request: FastifyRequest, repositoryId: string): void;
  rejected(repositoryId: string): Promise<void>;
}
interface Receipt { repositoryId: string; receivedAt: Date; teamId: string | undefined; outcome?: WebhookOutcome }
const params = { type: "object", required: ["repositoryId"], properties: { repositoryId: { type: "string", format: "uuid" } } };

export function registerRepositoryDetailRoutes(app: FastifyInstance, dependencies: {
  repositories: RepositoryService; deletion: RepositoryDeletionService; webhooks: RepositoryWebhookService; reviews?: ReviewService;
  authenticated: boolean; webhookToken?: string;
}): WebhookAuthentication {
  const { repositories, deletion, webhooks, reviews, authenticated, webhookToken } = dependencies;
  const receipts = new WeakMap<FastifyRequest, Receipt>();
  const authentication: WebhookAuthentication = {
    accepted(request, repositoryId) { receipts.set(request, { repositoryId, receivedAt: new Date(), teamId: currentTeamId() }); },
    rejected: (repositoryId) => repositories.recordAuthenticationFailure(repositoryId),
  };
  app.addHook("onSend", async (request, reply, payload) => {
    const receipt = receipts.get(request);
    if (!receipt) return payload;
    receipts.delete(request);
    const write = () => webhooks.record(receipt.repositoryId, receipt.receivedAt, request.headers["x-gitlab-event"], request.body,
      receipt.outcome ?? { result: "failed", reviewId: null,
        reason: [400, 413, 415].includes(reply.statusCode) ? "Webhook 请求格式不正确" : "事件处理失败" });
    if (receipt.teamId) await withTeam(receipt.teamId, write); else await write();
    return payload;
  });
  if (!authenticated) app.addHook("onRequest", async (request) => {
    if (request.routeOptions.url !== repositoryWebhookRoute) return;
    if (!webhookToken) throw new AuthError(503, "webhook_unconfigured", "服务尚未配置 webhook 密钥");
    const repositoryId = (request.params as { repositoryId: string }).repositoryId;
    const supplied = request.headers["x-gitlab-token"];
    const received = Buffer.from(typeof supplied === "string" ? supplied : "");
    const expected = Buffer.from(webhookToken);
    const valid = received.length === expected.length && timingSafeEqual(received, expected);
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(repositoryId)) {
      throw new AuthError(valid ? 400 : 401, valid ? "invalid_input" : "invalid_webhook_token", valid ? "仓库标识不正确" : "Webhook 密钥不正确");
    }
    if (!valid) { await authentication.rejected(repositoryId); throw new AuthError(401, "invalid_webhook_token", "Webhook 密钥不正确"); }
    await repositories.get(repositoryId);
    authentication.accepted(request, repositoryId);
  });
  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId", { schema: { params } }, async (request) => {
    requireIdentity();
    return { repository: await repositories.get(request.params.repositoryId) };
  });
  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/deletion-preview", { schema: { params } }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { preview: await deletion.preview(request.params.repositoryId) };
  });
  app.delete<{ Params: { repositoryId: string }; Body: { pathWithNamespace: string } }>(
    "/api/repositories/:repositoryId", { bodyLimit: 4096, schema: { params, body: {
      type: "object", required: ["pathWithNamespace"], additionalProperties: false,
      properties: { pathWithNamespace: { type: "string", maxLength: 1024 } },
    } } }, async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      return { deleted: true, preview: await deletion.delete(request.params.repositoryId, request.body.pathWithNamespace) };
    });
  app.put<{ Params: { repositoryId: string }; Body: { enabled: boolean; version: number } }>(
    "/api/repositories/:repositoryId/automatic-review", { bodyLimit: 1024, schema: { params, body: {
      type: "object", required: ["enabled", "version"], additionalProperties: false,
      properties: { enabled: { type: "boolean" }, version: { type: "integer", minimum: 1, maximum: 2_147_483_646 } },
    } } }, async (request) => ({ repository: await repositories.setAutomaticReview(request.params.repositoryId, request.body.enabled, request.body.version) }));
  app.get<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/events", { schema: { params } }, async (request) => {
    requireIdentity();
    return webhooks.list(request.params.repositoryId);
  });
  app.post<{ Params: { repositoryId: string } }>("/api/repositories/:repositoryId/webhook-check", { schema: { params } }, async (request) => {
    return { check: await webhooks.check(request.params.repositoryId) };
  });
  if (reviews) app.post<{ Params: { repositoryId: string }; Body: unknown }>(repositoryWebhookRoute, { bodyLimit: 1_048_576, schema: { params } },
    async (request, reply) => {
      const receipt = receipts.get(request);
      if (!receipt) throw new AuthError(401, "invalid_webhook_token", "Webhook 密钥不正确");
      const outcome = await webhooks.receive(request.params.repositoryId, request.headers["x-gitlab-event"],
        deliveryId(request), request.body, reviews);
      receipt.outcome = outcome;
      if (outcome.result === "ignored") return reply.code(202).send({ ignored: true });
      return reply.code(outcome.created ? 202 : 200).send({ reviewId: outcome.reviewId, created: outcome.created });
    });
  return authentication;
}
