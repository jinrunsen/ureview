import type { FastifyInstance } from "fastify";
import type { InboxService } from "./service.js";

export function registerInboxRoutes(app: FastifyInstance, inbox: InboxService): void {
  app.get("/api/inbox", async () => inbox.get());
  app.get("/api/notifications", async () => ({ notifications: await inbox.notifications() }));
  app.post<{ Params: { notificationId: string } }>("/api/notifications/:notificationId/read", { schema: {
    params: { type: "object", required: ["notificationId"], properties: { notificationId: { type: "string", format: "uuid" } } },
  } }, async (request) => { await inbox.markRead(request.params.notificationId); return { ok: true }; });
}
