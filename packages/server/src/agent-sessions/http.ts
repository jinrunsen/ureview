import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { AgentSessionStore } from "./store.js";
import { AgentSessionError, agentSessionKinds, type AgentSessionListOptions } from "./types.js";

export function registerAgentSessionRoutes(app: FastifyInstance, pool: pg.Pool): AgentSessionStore {
  const store = new AgentSessionStore(pool);
  void app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof AgentSessionError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    const id = { type: "string", format: "uuid" };
    const params = { type: "object", required: ["id"], additionalProperties: false, properties: { id } };
    routes.get<{ Querystring: AgentSessionListOptions }>("/api/agent-sessions", { schema: { querystring: {
      type: "object", additionalProperties: false, properties: {
        page: { type: "integer", minimum: 1, maximum: 1_000_000 }, pageSize: { type: "integer", minimum: 1, maximum: 100 },
        kind: { type: "string", enum: [...agentSessionKinds] }, status: { type: "string", enum: ["running", "completed", "failed"] },
        reviewId: id, ruleSessionId: id, search: { type: "string", maxLength: 200 },
      },
    } } }, async (request) => store.list(request.query));
    routes.get<{ Params: { id: string } }>("/api/agent-sessions/:id", { schema: { params } }, async (request) => ({ session: await store.get(request.params.id) }));
    routes.get<{ Params: { id: string }; Querystring: { after?: number; limit?: number } }>("/api/agent-sessions/:id/events", {
      schema: { params, querystring: { type: "object", additionalProperties: false, properties: {
        after: { type: "integer", minimum: -1, maximum: Number.MAX_SAFE_INTEGER }, limit: { type: "integer", minimum: 1, maximum: 500 },
      } } },
    }, async (request) => store.events(request.params.id, request.query.after, request.query.limit));
  });
  return store;
}
