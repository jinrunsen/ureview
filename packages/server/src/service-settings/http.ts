import type { FastifyInstance } from "fastify";
import type { ModelSettingsInput, ModelVerificationInput, ServiceSettings } from "./service.js";

export function registerServiceSettingsRoutes(app: FastifyInstance, service: ServiceSettings): void {
  app.get("/api/service-settings", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { settings: await service.view() };
  });
  const version = { type: "integer", minimum: 0, maximum: 2147483646 };
  const phaseParams = { type: "object", additionalProperties: false, required: ["phase"], properties: { phase: { enum: ["generator", "grader"] } } };
  app.post<{ Params: { phase: "generator" | "grader" }; Body: { version: number } }>("/api/service-settings/:phase/reveal-key", {
    bodyLimit: 1024,
    schema: { params: phaseParams, body: { type: "object", additionalProperties: false, required: ["version"], properties: { version } } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return service.revealKey(request.params.phase, request.body.version);
  });
  app.post<{ Params: { phase: "generator" | "grader" }; Body: ModelVerificationInput }>("/api/service-settings/:phase/verify", {
    bodyLimit: 8192,
    schema: { params: phaseParams, body: { type: "object", additionalProperties: false, required: ["version", "model", "baseURL"], properties: {
      version, model: { type: "string", minLength: 1, maxLength: 256 }, baseURL: { type: "string", minLength: 1, maxLength: 2048 },
      apiKey: { type: "string", maxLength: 4096 },
    } } },
  }, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { verification: await service.verify(request.params.phase, request.body) };
  });
  app.put<{ Body: ModelSettingsInput }>("/api/service-settings", {
    bodyLimit: 16_384,
    schema: { body: { type: "object", additionalProperties: false, required: ["version"], properties: {
      version: { type: "integer", minimum: 0, maximum: 2147483646 },
      generatorModel: { type: "string", minLength: 1, maxLength: 256 }, graderModel: { type: "string", minLength: 1, maxLength: 256 },
      generatorBaseURL: { type: "string", minLength: 1, maxLength: 2048 }, graderBaseURL: { type: "string", minLength: 1, maxLength: 2048 },
      generatorApiKey: { type: "string", maxLength: 4096 }, graderApiKey: { type: "string", maxLength: 4096 },
    } } },
  }, async (request, reply) => { reply.header("Cache-Control", "no-store"); return { settings: await service.save(request.body) }; });
  app.get("/api/service-users", async () => ({ users: await service.users() }));
  app.put<{ Params: { id: string }; Body: { role: "user" | "service_admin" } }>("/api/service-users/:id", {
    schema: { params: { type: "object", required: ["id"], properties: { id: { type: "string", format: "uuid" } } },
      body: { type: "object", additionalProperties: false, required: ["role"], properties: { role: { enum: ["user", "service_admin"] } } } },
  }, async (request) => { await service.setRole(request.params.id, request.body.role); return { updated: true }; });
}
