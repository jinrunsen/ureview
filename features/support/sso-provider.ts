import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";

export class SsoProvider {
  private server?: Server;
  origin = "";
  claims: Record<string, unknown> = { sub: "employee-zhaolei", preferred_username: "zhaolei", name: "赵磊", email: "zhaolei@example.test", email_verified: true };
  tokenFailure = false;
  interactive = false;
  clientSecret = "enterprise-fixture-secret";
  private codes = new Map<string, URLSearchParams>();
  async start() {
    this.server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", this.origin);
      const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
      if (url.pathname.endsWith("openid-configuration")) return json({ issuer: this.origin, authorization_endpoint: `${this.origin}/authorize`, token_endpoint: `${this.origin}/token`, userinfo_endpoint: `${this.origin}/userinfo` });
      if (url.pathname.endsWith("authorize")) {
        if (!url.searchParams.has("redirect_uri")) return json({ ready: true });
        if (url.searchParams.get("client_id") !== "enterprise-client" || url.searchParams.get("response_type") !== "code"
          || url.searchParams.get("code_challenge_method") !== "S256") return json({ error: "invalid_request" }, 400);
        if (this.interactive && !url.searchParams.has("confirmed")) {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          const target = new URL(url); target.searchParams.set("confirmed", "1");
          response.end(`<html lang="zh"><h1>公司统一认证</h1><a href="${target.href.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">确认登录</a></html>`); return;
        }
        const code = randomBytes(24).toString("hex"); this.codes.set(code, url.searchParams);
        const target = new URL(url.searchParams.get("redirect_uri")!); target.searchParams.set("state", url.searchParams.get("state")!); target.searchParams.set("code", code);
        response.writeHead(302, { location: target.href }); response.end(); return;
      }
      if (url.pathname.endsWith("token")) {
        if (this.tokenFailure) return json({ error: `private-provider-response-${this.clientSecret}` }, 503);
        let body = ""; for await (const chunk of request) body += chunk;
        const params = new URLSearchParams(body); const auth = this.codes.get(params.get("code") ?? ""); this.codes.delete(params.get("code") ?? "");
        const expectedBasic = `Basic ${Buffer.from(`enterprise-client:${this.clientSecret}`).toString("base64")}`;
        if (!auth || params.get("grant_type") !== "authorization_code" || !(request.headers.authorization === expectedBasic || (params.get("client_secret") === this.clientSecret && params.get("client_id") === "enterprise-client"))
          || params.get("redirect_uri") !== auth.get("redirect_uri") || createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") !== auth.get("code_challenge")) return json({ error: "invalid_grant" }, 400);
        const claims = { ...this.claims, iss: this.origin, aud: "enterprise-client", exp: Math.floor(Date.now() / 1000) + 300, nonce: auth.get("nonce") };
        return json({ access_token: "private-access-token", token_type: "Bearer", id_token: `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature` });
      }
      if (url.pathname === "/userinfo" || url.pathname === "/oauth2/get_user_info") {
        if (request.headers.authorization !== "Bearer private-access-token") return json({ error: "unauthorized" }, 401);
        return json(url.pathname === "/userinfo" ? this.claims : { code: 0, data: this.claims });
      }
      json({ error: "not_found" }, 404);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address(); if (!address || typeof address === "string") throw new Error("身份源启动失败");
    this.origin = `http://127.0.0.1:${address.port}`;
  }
  async stop() { this.server?.closeAllConnections(); await new Promise<void>((resolve, reject) => this.server ? this.server.close((error) => error ? reject(error) : resolve()) : resolve()); }
}
