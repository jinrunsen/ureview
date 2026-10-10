import type { FastifyInstance } from "fastify";
import type { CollaborationService } from "./service.js";
import type { EndpointInput } from "./delivery.js";
import { CollaborationError } from "./types.js";

export function registerCollaborationRoutes(app: FastifyInstance, { service }: { service: CollaborationService }) {
  const id = { type: "string", format: "uuid" };
  const review = { type: "object", required: ["id"], additionalProperties: false, properties: { id } };
  const thread = { type: "object", required: ["id", "findingId"], additionalProperties: false, properties: { id, findingId: id } };
  app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof CollaborationError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      if (error instanceof Error && "validation" in error) return reply.code(400).send({ error: { code: "invalid_input", message: "请求参数不正确" } });
      throw error;
    });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.get("/api/collaboration/members", async () => ({ members: await service.members() }));
    routes.get("/api/collaboration/unread", async () => service.unread());
    routes.get<{ Params: { id: string; findingId: string } }>("/api/reviews/:id/findings/:findingId/comments", { schema: { params: thread } }, async (request) => service.listComments(request.params.id, request.params.findingId));
    routes.post<{ Params: { id: string; findingId: string }; Body: { requestId: string; body: string; parentId?: string; mentions?: string[] } }>("/api/reviews/:id/findings/:findingId/comments", {
      bodyLimit: 24_000,
      schema: { params: thread, body: { type: "object", required: ["requestId", "body"], additionalProperties: false, properties: {
        requestId: id, body: { type: "string", minLength: 1, maxLength: 4000 }, parentId: id,
        mentions: { type: "array", maxItems: 20, uniqueItems: true, items: id },
      } } },
    }, async (request, reply) => {
      const result = await service.addComment(request.params.id, request.params.findingId, request.body);
      return reply.code(result.created ? 201 : 200).send(result);
    });
    routes.post<{ Params: { id: string; findingId: string }; Body: { ids: string[] } }>("/api/reviews/:id/findings/:findingId/comments/read", {
      schema: { params: thread, body: { type: "object", required: ["ids"], additionalProperties: false, properties: { ids: { type: "array", maxItems: 1000, items: id } } } },
    }, async (request) => service.markRead(request.params.id, request.params.findingId, request.body.ids));
    routes.get<{ Params: { id: string } }>("/api/reviews/:id/participation", { schema: { params: review } }, async (request) => service.participation(request.params.id));
    routes.put<{ Params: { id: string }; Body: { completed: boolean } }>("/api/reviews/:id/participation", {
      schema: { params: review, body: { type: "object", required: ["completed"], additionalProperties: false, properties: { completed: { type: "boolean" } } } },
    }, async (request) => service.finishReview(request.params.id, request.body.completed));
    routes.get<{ Params: { id: string } }>("/api/reviews/:id/platform-discussions", { schema: { params: review } }, async (request) => service.platformDiscussions(request.params.id));
    const endpointProperties = {
      name: { type: "string", minLength: 1, maxLength: 100 },
      endpoint: { type: "string", minLength: 1, maxLength: 2048 },
      secret: { anyOf: [{ type: "string", maxLength: 256 }, { type: "null" }] },
    };
    routes.get("/api/notification-endpoints", async () => service.endpoints());
    routes.post<{ Body: EndpointInput }>("/api/notification-endpoints", {
      bodyLimit: 8192, schema: { body: { type: "object", additionalProperties: false, required: ["name", "kind", "endpoint"], properties: {
        ...endpointProperties, kind: { type: "string", enum: ["wecom", "feishu", "dingtalk", "webhook"] },
      } } },
    }, async (request, reply) => reply.code(201).send(await service.createEndpoint(request.body)));
    routes.patch<{ Params: { id: string }; Body: Partial<Pick<EndpointInput, "name" | "endpoint" | "secret">> }>("/api/notification-endpoints/:id", {
      bodyLimit: 8192, schema: { params: review, body: { type: "object", additionalProperties: false, minProperties: 1, properties: endpointProperties } },
    }, async (request) => service.updateEndpoint(request.params.id, request.body));
    routes.delete<{ Params: { id: string } }>("/api/notification-endpoints/:id", { schema: { params: review } }, async (request) => service.removeEndpoint(request.params.id));
    routes.get("/api/notification-settings", async () => service.settings());
    routes.put<{ Body: { endpoint: string | null } }>("/api/notification-settings", {
      bodyLimit: 4096, schema: { body: { type: "object", required: ["endpoint"], additionalProperties: false, properties: { endpoint: { anyOf: [{ type: "string", minLength: 1, maxLength: 2048 }, { type: "null" }] } } } },
    }, async (request) => service.configure(request.body.endpoint));
  });
}
