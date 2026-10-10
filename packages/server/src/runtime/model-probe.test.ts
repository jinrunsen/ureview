import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyModelConnection, type ModelConnectionInput } from "./model-probe.js";

interface ProbeRequest { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); vi.restoreAllMocks(); });

async function serve(reply: (response: ServerResponse, request: ProbeRequest) => void) {
  const requests: ProbeRequest[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const record = { path: request.url!, headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> };
    requests.push(record); reply(response, record);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("模型协议样例没有监听端口");
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => resolve()); }); });
  return { baseURL: `http://127.0.0.1:${address.port}/v1`, requests };
}
const connection = (baseURL: string, api: ModelConnectionInput["api"] = "openai-completions"): ModelConnectionInput => ({
  baseURL, api, provider: "ureview-probe", model: "fixture-model", apiKey: "fixture-private-key",
});
function sse(response: ServerResponse, events: Array<Record<string, unknown>>, done = false): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`${typeof event["type"] === "string" ? `event: ${event["type"]}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
  if (done) response.write("data: [DONE]\n\n");
  response.end();
}
function complete(response: ServerResponse, text = "OK", finish = "stop"): void {
  const common = { id: "completion-probe", object: "chat.completion.chunk", created: 1, model: "fixture-model" };
  sse(response, [
    { ...common, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ], true);
}
function anthropic(response: ServerResponse): void {
  sse(response, [
    { type: "message_start", message: { id: "message-probe", type: "message", role: "assistant", model: "fixture-model", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ]);
}
function responses(response: ServerResponse): void {
  const part = { type: "output_text", text: "OK", annotations: [] };
  const item = { id: "message-probe", type: "message", role: "assistant", content: [part], status: "completed" };
  const envelope = { id: "response-probe", object: "response", model: "fixture-model", created_at: 1, status: "in_progress", output: [] };
  sse(response, [
    { type: "response.created", response: envelope },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "OK" },
    { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: "OK" },
    { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...envelope, status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map((event, sequence_number) => ({ ...event, sequence_number })));
}

describe("正式 dsh 适配器的模型连接验证", () => {
  it.each([
    { api: "openai-completions" as const, path: "/v1/chat/completions", reply: complete },
    { api: "anthropic-messages" as const, path: "/v1/messages?beta=true", reply: anthropic },
    { api: "openai-responses" as const, path: "/v1/responses", reply: responses },
  ])("$api 发送真实小请求，使用正式 Harness 归属头并验证终结响应", async ({ api, path, reply }) => {
    const server = await serve((response) => reply(response));
    const baseURL = api === "anthropic-messages" ? server.baseURL.replace(/\/v1$/, "") : server.baseURL;
    const result = await verifyModelConnection(connection(baseURL, api));
    expect(result).toMatchObject({ ok: true, code: "verified", message: "模型连接验证通过。" });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.path).toBe(path);
    expect(request.headers["user-agent"]).toContain("deepseek-harness/0.1.7-alpha.2");
    expect(request.headers[api === "anthropic-messages" ? "x-api-key" : "authorization"]).toContain("fixture-private-key");
    expect(request.body["model"]).toBe("fixture-model");
    expect(request.body["tools"] ?? []).toEqual([]);
    expect(JSON.stringify(request.body)).toContain("Reply with OK.");
    expect(JSON.stringify(result)).not.toContain("fixture-private-key");
  });

  it.each([
    { status: 401, error: "invalid_api_key", expected: "authentication_failed" },
    { status: 403, error: "security_plugin_uninstalled", expected: "security_plugin_required" },
    { status: 404, error: "model_not_found", expected: "model_not_found" },
    { status: 429, error: "rate_limit_exceeded", expected: "rate_limited" },
    { status: 500, error: "upstream_failed", expected: "connection_failed" },
  ])("HTTP $status 返回安全分类 $expected，单次探测不重试也不泄漏错误正文", async ({ status, error, expected }) => {
    const secret = "private-upstream-payload-sentinel";
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const server = await serve((response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: error, message: `${error}: ${secret}; key=fixture-private-key` } }));
    });
    const result = await verifyModelConnection(connection(server.baseURL));
    expect(result).toMatchObject({ ok: false, code: expected });
    expect(server.requests).toHaveLength(1);
    for (const text of [JSON.stringify(result), JSON.stringify(logger.mock.calls), JSON.stringify(warning.mock.calls)]) {
      expect(text).not.toContain(secret); expect(text).not.toContain("fixture-private-key");
    }
  });

  it.each(["empty", "invalid-json", "unterminated", "tool-finish"] as const)("HTTP 200 的 %s 响应不能作为验证通过", async (mode) => {
    const server = await serve((response) => {
      if (mode === "empty") { complete(response, ""); return; }
      if (mode === "tool-finish") { complete(response, "工具未配置", "tool_calls"); return; }
      if (mode === "invalid-json") { response.writeHead(200, { "content-type": "application/json" }); response.end("malformed"); return; }
      sse(response, [{ id: "partial", object: "chat.completion.chunk", model: "fixture-model", choices: [{ index: 0, delta: { content: "unfinished" }, finish_reason: null }] }]);
    });
    const result = await verifyModelConnection(connection(server.baseURL));
    expect(result.ok).toBe(false);
    expect(["protocol_error", "connection_failed"]).toContain(result.code);
  });

  it.each([
    { reasoning: true, finish: "length" }, { reasoning: false, finish: "length" }, { reasoning: true, finish: "stop" },
  ])("没有可见文本仍可凭正常思考结果或预算终止验证，reasoning=$reasoning finish=$finish", async ({ reasoning, finish }) => {
    const server = await serve((response) => {
      if (!reasoning) { complete(response, "", "length"); return; }
      const common = { id: "thinking-probe", object: "chat.completion.chunk", created: 1, model: "fixture-model" };
      sse(response, [
        { ...common, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "private-thinking-sentinel" }, finish_reason: null }] },
        { ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 64, total_tokens: 65 } },
      ], true);
    });
    const result = await verifyModelConnection(connection(server.baseURL));
    expect(result).toMatchObject({ ok: true, code: "verified" });
    expect(server.requests).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private-thinking-sentinel");
  });

  it("超时取消实际 HTTP 连接，后续独立验证仍能使用新的密钥", async () => {
    let disconnected: Promise<unknown> | undefined;
    const blocked = await serve((response) => { disconnected = once(response, "close"); });
    const result = await verifyModelConnection(connection(blocked.baseURL), 100);
    expect(result).toMatchObject({ ok: false, code: "timeout" });
    expect(blocked.requests).toHaveLength(1);
    await disconnected;
    const next = await serve((response) => complete(response));
    const success = await verifyModelConnection({ ...connection(next.baseURL), apiKey: "different-probe-key" });
    expect(success.ok).toBe(true);
    expect(next.requests[0]!.headers["authorization"]).toBe("Bearer different-probe-key");
  });

  it("验证输入无效时不发起请求，模型输出不作为验证结果返回", async () => {
    const server = await serve((response) => complete(response, "private-model-output-sentinel"));
    expect(await verifyModelConnection({ ...connection(server.baseURL), apiKey: "" })).toMatchObject({ ok: false, code: "invalid_config" });
    expect(await verifyModelConnection({ ...connection(server.baseURL), baseURL: "file:///tmp/model" })).toMatchObject({ ok: false, code: "invalid_config" });
    expect(server.requests).toHaveLength(0);
    const result = await verifyModelConnection(connection(server.baseURL));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("private-model-output-sentinel");
  });

  it("并发验证使用独立凭据与模型路由，不相互覆盖连接配置", async () => {
    const first = await serve((response) => complete(response));
    const second = await serve((response) => complete(response));
    const results = await Promise.all([
      verifyModelConnection({ ...connection(first.baseURL), apiKey: "first-request-private-key", model: "first-model" }),
      verifyModelConnection({ ...connection(second.baseURL), apiKey: "second-request-private-key", model: "second-model" }),
    ]);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(first.requests[0]!.headers["authorization"]).toBe("Bearer first-request-private-key");
    expect(first.requests[0]!.body["model"]).toBe("first-model");
    expect(second.requests[0]!.headers["authorization"]).toBe("Bearer second-request-private-key");
    expect(second.requests[0]!.body["model"]).toBe("second-model");
  });
});
