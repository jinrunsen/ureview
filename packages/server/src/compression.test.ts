import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { registerCompression } from "./compression.js";
let app: FastifyInstance | undefined;
let directory: string | undefined;
afterEach(async () => { await app?.close(); if (directory) await rm(directory, { recursive: true }); directory = undefined; });
function setup() { app = Fastify(); registerCompression(app); return app; }
describe("响应压缩", () => {
  it.each([undefined, "identity", "gzip;q=0, *;q=1", "br"])("客户端接受 %s 时保持原始 JSON", async (encoding) => {
    const server = setup(), data = { text: "规范正文".repeat(400) };
    server.get("/data", async () => data);
    const response = await server.inject({ url: "/data", headers: encoding ? { "accept-encoding": encoding } : {} });
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.json()).toEqual(data); expect(response.headers.vary).toBe("Accept-Encoding");
  });
  it.each(["gzip", "br, gzip;q=0.5", "*"])("客户端接受 %s 时压缩大 JSON 并设置正确长度", async (encoding) => {
    const server = setup(), data = { text: "规范正文".repeat(400) };
    server.get("/data", async (_request, reply) => reply.header("Vary", "Origin").send(data));
    const response = await server.inject({ url: "/data", headers: { "accept-encoding": encoding } });
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers.vary).toBe("Origin, Accept-Encoding");
    expect(Number(response.headers["content-length"])).toBe(response.rawPayload.length);
    expect(JSON.parse(gunzipSync(response.rawPayload).toString())).toEqual(data);
  });
  it("小于 1 KB 的 JSON 保持原样", async () => {
    const server = setup(); server.get("/small", async () => ({ ok: true }));
    const response = await server.inject({ url: "/small", headers: { "accept-encoding": "gzip" } });
    expect(response.headers["content-encoding"]).toBeUndefined(); expect(response.json()).toEqual({ ok: true });
  });
  it("压缩静态资源流，小文件与不接受 gzip 的请求保持原样", async () => {
    const server = setup(); directory = await mkdtemp(join(tmpdir(), "ureview-compression-"));
    const script = 'window.message = "规范";\n'.repeat(300);
    await writeFile(join(directory, "app.js"), script); await writeFile(join(directory, "small.css"), "body { color: red }");
    await server.register(fastifyStatic, { root: directory });
    const compressed = await server.inject({ url: "/app.js", headers: { "accept-encoding": "gzip" } });
    expect(compressed.headers["content-encoding"]).toBe("gzip"); expect(gunzipSync(compressed.rawPayload).toString()).toBe(script);
    const range = await server.inject({ url: "/app.js", headers: { "accept-encoding": "gzip", range: "bytes=0-1500" } });
    expect(range.statusCode).toBe(206); expect(range.headers["content-encoding"]).toBeUndefined(); expect(range.rawPayload).toEqual(Buffer.from(script).subarray(0, 1501));
    const raw = await server.inject("/app.js"); expect(raw.body).toBe(script); expect(raw.headers["content-encoding"]).toBeUndefined();
    const small = await server.inject({ url: "/small.css", headers: { "accept-encoding": "gzip" } }); expect(small.headers["content-encoding"]).toBeUndefined();
  });
});
