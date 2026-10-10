import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { CollaborationError } from "./types.js";

export type WebhookTransport = (endpoint: string, payload: unknown, deliveryId: string) => Promise<unknown>;

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split(".").map(Number);
    const [a = 0, b = 0, c = 0] = octets;
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99)))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // 只接受全球单播；IPv4 映射、链路本地、文档和特殊用途前缀均不允许。
  if (isIP(address) !== 6) return false;
  const [first = 0, second = 0] = address.split(":").map((word) => Number.parseInt(word || "0", 16));
  return first >= 0x2000 && first <= 0x3fff
    && !(first === 0x2001 && (second < 0x0200 || second === 0x0db8))
    && first !== 0x2002 && !(first === 0x3fff && second < 0x1000);
}

export function validateWebhookUrl(endpoint: string): URL {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new CollaborationError(400, "invalid_endpoint", "请输入有效的 HTTPS 通知地址"); }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")
    || host === "localhost" || host.endsWith(".localhost") || (isIP(host) && !publicAddress(host))) {
    throw new CollaborationError(400, "invalid_endpoint", "通知地址必须使用公网 HTTPS 地址和 443 端口");
  }
  return url;
}

export const sendWebhook: WebhookTransport = async (endpoint, payload, deliveryId) => {
  const url = validateWebhookUrl(endpoint);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const startedAt = Date.now();
  let dnsTimeout: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    lookup(hostname, { all: true }),
    new Promise<never>((_resolve, reject) => { dnsTimeout = setTimeout(() => reject(new Error("通知出口域名解析超时")), Math.max(1, 10_000 - (Date.now() - startedAt))); }),
  ]).finally(() => clearTimeout(dnsTimeout));
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address))) throw new Error("通知地址未解析为公网地址");
  const target = addresses[0]!;
  const body = JSON.stringify(payload);
  return new Promise<unknown>((resolve, reject) => {
    // DNS 结果固定到本次连接，防止校验和建立连接之间切换到内网地址；不跟随重定向。
    const outgoing = request(url, {
      method: "POST", agent: false,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "X-UReview-Delivery": deliveryId },
      lookup: (_host, options, callback) => options.all ? callback(null, [target]) : callback(null, target.address, target.family),
    }, (response) => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume(); response.destroy(); reject(new Error("通知出口返回失败")); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1_048_576) { response.destroy(); reject(new Error("通知出口响应过大")); }
        else chunks.push(chunk);
      });
      response.once("error", reject);
      response.once("end", () => {
        const content = Buffer.concat(chunks).toString("utf8");
        try { resolve(content ? JSON.parse(content) : null); } catch { resolve(null); }
      });
    });
    const timeout = setTimeout(() => outgoing.destroy(new Error("通知出口超时")), Math.max(1, 10_000 - (Date.now() - startedAt)));
    outgoing.once("close", () => clearTimeout(timeout));
    outgoing.once("error", reject);
    outgoing.end(body);
  });
};
