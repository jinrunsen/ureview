import { IdentityService, registerIdentityRoutes } from "./identities.js";
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { withTeam } from "../db/tenant.js";
import { AuthError, currentIdentity, requireAdmin, requireIdentity, withIdentity } from "./context.js";
import type { AuthService, NewMember } from "./service.js";
import type { WebhookAuthentication } from "../repositories/http.js";

const cookieName = "ureview_session";
function sessionToken(request: FastifyRequest): string | undefined {
  return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}
export function setCookie(reply: FastifyReply, token: string, secure: boolean): void {
  reply.header("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 604_800 : 0}${secure ? "; Secure" : ""}`);
}
const text = { type: "string", minLength: 1, maxLength: 254 };
const email = { anyOf: [{ type: "string", maxLength: 254 }, { type: "null" }] };
const password = { type: "string", minLength: 6, maxLength: 32 };
const name = { type: "string", minLength: 1, maxLength: 120 };
const role = { type: "string", enum: ["admin", "member"] };
const uuid = { type: "string", format: "uuid" };
function body(properties: Record<string, object>, required = Object.keys(properties)): object {
  return { type: "object", required, additionalProperties: false, properties };
}

export function installAuthentication(app: FastifyInstance, auth: AuthService, publicOrigin: string, webhookToken?: string,
  webhookAuthentication?: WebhookAuthentication): void {
  registerIdentityRoutes(app, new IdentityService(auth.pool));
  const secure = new URL(publicOrigin).protocol === "https:";
  const publicRoutes = new Set(["/api/auth/session", "/api/auth/login", "/api/auth/setup", "/api/auth/sso/start", "/api/auth/sso/callback"]);
  app.addHook("onRequest", (request, reply, done) => {
    const path = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
    if (!path.startsWith("/api/")) { done(); return; }
    reply.header("Cache-Control", "no-store");
    const isWebhook = path === "/api/repositories/:repositoryId/events/gitlab";
    const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    if (!isWebhook && isMutation && (request.headers["x-ureview-request"] !== "1" ||
      (request.headers.origin !== undefined && request.headers.origin !== publicOrigin))) {
      done(new AuthError(403, "invalid_origin", "请求来源不正确，请刷新页面后重试")); return;
    }
    if (isWebhook) {
      if (!webhookToken) { done(new AuthError(503, "webhook_unconfigured", "服务尚未配置 webhook 密钥")); return; }
      const supplied = request.headers["x-gitlab-token"];
      const received = Buffer.from(typeof supplied === "string" ? supplied : "");
      const expected = Buffer.from(webhookToken);
      const valid = received.length === expected.length && timingSafeEqual(received, expected);
      const params = request.params;
      if (!params || typeof params !== "object" || !("repositoryId" in params) || typeof params.repositoryId !== "string"
        || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.repositoryId)) {
        done(new AuthError(valid ? 400 : 401, valid ? "invalid_input" : "invalid_webhook_token", valid ? "仓库标识不正确" : "Webhook 密钥不正确")); return;
      }
      const repositoryId = params.repositoryId;
      void auth.repositoryTeam(repositoryId).then(async (teamId) => {
        if (!valid) {
          if (teamId) await withTeam(teamId, () => webhookAuthentication?.rejected(repositoryId));
          done(new AuthError(401, "invalid_webhook_token", "Webhook 密钥不正确")); return;
        }
        if (!teamId) { done(new AuthError(404, "not_found", "仓库不存在")); return; }
        withTeam(teamId, () => { webhookAuthentication?.accepted(request, repositoryId); done(); });
      }).catch(done);
      return;
    }
    void auth.getIdentity(sessionToken(request)).then((user) => {
      if (!user && !publicRoutes.has(path)) { done(new AuthError(401, "authentication_required", "请先登录")); return; }
      if (!user) { done(); return; }
      withIdentity(user, () => {
        try {
          if (request.method === "POST" && path === "/api/repositories") requireAdmin();
          done();
        } catch (error) { done(error instanceof Error ? error : new Error("权限验证失败")); }
      });
    }, done);
  });

  app.get("/api/auth/session", async () => auth.sessionView(currentIdentity()));
  app.post<{ Body: { token: string; username: string; email?: string | null; name: string; password: string } }>("/api/auth/setup", {
    bodyLimit: 4096, schema: { body: body({ token: text, username: text, email, name, password }, ["token", "username", "name", "password"]) },
  }, async (request, reply) => {
    await auth.rateLimit(`setup:${request.ip}`, 10);
    const token = await auth.setup(request.body);
    setCookie(reply, token, secure);
    return auth.sessionView(await auth.getIdentity(token));
  });
  app.post<{ Body: { username: string; password: string } }>("/api/auth/login", {
    bodyLimit: 4096, schema: { body: body({ username: text, password: { type: "string", minLength: 1, maxLength: 128 } }) },
  }, async (request, reply) => {
    await auth.rateLimit(`login:${request.ip}`, 30);
    const token = await auth.login(request.body.username, request.body.password);
    setCookie(reply, token, secure);
    return auth.sessionView(await auth.getIdentity(token));
  });
  app.post("/api/auth/logout", async (request, reply) => {
    await auth.logout(sessionToken(request) ?? "");
    setCookie(reply, "", secure);
    return { ok: true };
  });
  app.post<{ Body: { currentPassword: string; newPassword: string } }>("/api/auth/password", {
    bodyLimit: 4096,
    schema: { body: body({ currentPassword: { type: "string", minLength: 1, maxLength: 128 }, newPassword: password }) },
  }, async (request) => {
    const token = sessionToken(request) ?? "";
    await auth.changePassword(token, request.body.currentPassword, request.body.newPassword);
    return auth.sessionView(await auth.getIdentity(token));
  });
  app.post<{ Body: { teamId: string } }>("/api/auth/team", { schema: { body: body({ teamId: uuid }) } }, async (request) => {
    const token = sessionToken(request) ?? "";
    await auth.switchTeam(token, requireIdentity(), request.body.teamId);
    return auth.sessionView(await auth.getIdentity(token));
  });
  app.get("/api/team/members", async () => ({ members: await auth.members(requireIdentity().teamId) }));
  app.post<{ Body: NewMember }>("/api/admin/members", {
    bodyLimit: 4096, schema: { body: body({ username: text, email, name, password, role }, ["username", "name", "password", "role"]) },
  }, async (request, reply) => { await auth.createMember(request.body); return reply.code(201).send({ ok: true }); });
  app.post<{ Body: { username: string; role: "admin" | "member" } }>("/api/admin/memberships", {
    bodyLimit: 4096, schema: { body: body({ username: text, role }) },
  }, async (request, reply) => { await auth.addMember(request.body.username, request.body.role); return reply.code(201).send({ ok: true }); });
  app.post<{ Body: { name: string } }>("/api/admin/teams", { schema: { body: body({ name }) } }, async (request, reply) => {
    return reply.code(201).send(await auth.createTeam(request.body.name));
  });
}
