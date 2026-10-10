import type { FastifyInstance } from "fastify";
import type { InstanceHealthService } from "./service.js";

export function registerInstanceHealthRoutes(app: FastifyInstance, service: InstanceHealthService): void {
  app.get("/api/onboarding", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { onboarding: await service.onboarding() };
  });
  app.get("/api/instance-health", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { health: await service.get() };
  });
}
