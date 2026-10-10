import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { TeamOverviewService } from "./service.js";

export function registerTeamOverviewRoutes(app: FastifyInstance, pool: pg.Pool) {
  const service = new TeamOverviewService(pool);
  app.get("/api/team-overview", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return service.get();
  });
}
