import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { DispositionError, FindingDispositionService } from "./dispositions.js";

export function registerDispositionRoutes(app: FastifyInstance, pool: pg.Pool) {
  const service = new FindingDispositionService(pool);
  const identifier = { type: "string", format: "uuid" };
  const params = { type: "object", required: ["id", "findingId"], properties: { id: identifier, findingId: identifier } };
  void app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof DispositionError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
      throw error;
    });
    routes.addHook("onSend", async (_request, reply) => { reply.header("Cache-Control", "no-store"); });
    routes.patch<{ Params: { id: string; findingId: string }; Body: unknown }>("/api/reviews/:id/findings/:findingId/disposition", {
      bodyLimit: 20000, schema: { params },
    }, async (request) => ({ finding: await service.change(request.params.id, request.params.findingId, request.body) }));
    routes.get<{ Params: { id: string; findingId: string } }>("/api/reviews/:id/findings/:findingId/disposition-history", { schema: { params } },
      async (request) => service.history(request.params.id, request.params.findingId));
  });
}
