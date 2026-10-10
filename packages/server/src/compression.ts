import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { createGzip, gzip } from "node:zlib";
import { promisify } from "node:util";

const compress = promisify(gzip);
function acceptsGzip(header: string | undefined): boolean {
  const encodings = new Map((header ?? "").split(",").map((part) => {
    const [name, ...parameters] = part.trim().toLowerCase().split(";");
    const quality = parameters.find((parameter) => parameter.trim().startsWith("q="));
    return [name, quality ? Number(quality.trim().slice(2)) : 1];
  }));
  return (encodings.get("gzip") ?? encodings.get("*") ?? 0) > 0;
}
export function registerCompression(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    const type = String(reply.getHeader("content-type") ?? "");
    if (!/^(application\/(?:json|javascript|wasm)|text\/|image\/svg\+xml)/i.test(type) || reply.hasHeader("content-encoding") || reply.statusCode === 204 || reply.statusCode === 206 || reply.statusCode === 304) return payload;
    const vary = String(reply.getHeader("vary") ?? "");
    if (!vary.split(",").some((value) => value.trim().toLowerCase() === "accept-encoding")) reply.header("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
    if (!acceptsGzip(request.headers["accept-encoding"]) || request.method === "HEAD") return payload;
    if (typeof payload === "string" || Buffer.isBuffer(payload)) {
      if (Buffer.byteLength(payload) < 1024) return payload;
      const compressed = await compress(payload);
      reply.header("Content-Encoding", "gzip").header("Content-Length", compressed.length);
      return compressed;
    }
    if (payload instanceof Readable && Number(reply.getHeader("content-length")) >= 1024) {
      reply.header("Content-Encoding", "gzip").removeHeader("content-length");
      const compressed = createGzip();
      payload.on("error", (error) => compressed.destroy(error));
      compressed.on("close", () => payload.destroy());
      return payload.pipe(compressed);
    }
    return payload;
  });
}
