import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { IdentityScenario } from "./identity-scenario.js";

export const savedModelKey = "sk-fixture-saved-model";
export const candidateModelKey = "sk-fixture-candidate-model";
export class ModelConnectionScenario {
  identity!: IdentityScenario;
  modelURL = "";
  readonly requests: Array<{ path: string; authorization: string; userAgent: string; body: Record<string, unknown> }> = [];
  private model: Server | undefined;

  async start(web: { webDir?: string; port?: number; publicOrigin?: string } = {}): Promise<void> {
    this.model = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        this.requests.push({ path: request.url ?? "", authorization: request.headers.authorization ?? "", userAgent: request.headers["user-agent"] ?? "", body });
        if (body.model === "deepseek-slow") await new Promise((resolve) => setTimeout(resolve, 2500));
        if (![savedModelKey, candidateModelKey].some((key) => request.headers.authorization === `Bearer ${key}`)) {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `PRIVATE_AUTH_DETAIL ${request.headers.authorization}`, type: "authentication_error" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({ id: "connection-check", object: "chat.completion.chunk", created: 1, model: body.model, choices, ...(usage ? { usage } : {}) })}\n\n`;
        response.write(chunk([{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }]));
        response.write(chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 }));
        response.end("data: [DONE]\n\n");
      } catch { response.writeHead(400); response.end(); }
    });
    await new Promise<void>((resolve) => this.model!.listen(0, "127.0.0.1", resolve));
    const address = this.model.address(); assert.ok(address && typeof address !== "string");
    this.modelURL = `http://127.0.0.1:${address.port}`;
    this.identity = new IdentityScenario({ ...web, serviceEnvironment: {
      UREVIEW_GENERATOR_API: "openai-completions", UREVIEW_GRADER_API: "openai-completions",
    } });
    await this.identity.start(); await this.identity.setup();
    const saved = await this.identity.request("/api/service-settings", { version: 0,
      generatorModel: "deepseek-flash", graderModel: "deepseek-v4-pro",
      generatorBaseURL: `${this.modelURL}/v1`, graderBaseURL: `${this.modelURL}/v1`,
      generatorApiKey: savedModelKey, graderApiKey: savedModelKey,
    }, { method: "PUT" });
    assert.equal(saved.status, 200);
  }

  async stop(): Promise<void> {
    try { await this.identity?.stop(); }
    finally { this.model?.closeAllConnections(); if (this.model) await new Promise<void>((resolve) => this.model!.close(() => resolve())); }
  }
}
