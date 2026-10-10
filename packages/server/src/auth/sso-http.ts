import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuthService } from "./service.js";
import type { SsoConfiguration } from "./sso-config.js";
import { endpoints, exchangeIdentity, returnPath, SsoFailure } from "./sso-protocol.js";
import { loginSsoAccount } from "./sso-accounts.js";
import { setCookie } from "./http.js";

const bindingName = "ureview_sso_binding";
const random = () => randomBytes(32).toString("base64url");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function cookie(token: string, secure: boolean) { return `${bindingName}=${token}; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=${token ? 600 : 0}${secure ? "; Secure" : ""}`; }
function binding(request: FastifyRequest) { return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${bindingName}=`))?.slice(bindingName.length + 1) ?? ""; }
interface Attempt { code_verifier: string; nonce: string | null; return_path: string; binding_hash: string; configuration_version: number; valid: boolean }
export function registerSsoLogin(app: FastifyInstance, auth: AuthService, service: SsoConfiguration) {
  const secure = new URL(service.publicOrigin).protocol === "https:";
  const callback = `${service.publicOrigin}/api/auth/sso/callback`;
  app.get<{ Querystring: { returnTo?: string } }>("/api/auth/sso/start", async (request, reply) => {
    try {
      await auth.rateLimit(`sso:${request.ip}`, 30);
      const { configuration: config, version } = await service.current();
      if (!config.enabled) throw new SsoFailure("disabled");
      if (await auth.setupRequired()) throw new SsoFailure("disabled");
      const source = await endpoints(config);
      const state = random(), verifier = random(), bind = random(), nonce = config.protocol === "oidc" ? random() : null;
      await auth.pool.query("DELETE FROM auth_sso_attempts WHERE expires_at<=now()");
      await auth.pool.query(`INSERT INTO auth_sso_attempts(state_hash,code_verifier,nonce,return_path,binding_hash,configuration_version,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`, [digest(state), verifier, nonce, returnPath(request.query.returnTo), digest(bind), version]);
      const target = new URL(source.authorizationEndpoint);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: callback,
        scope: config.scope, state, code_challenge: digestChallenge(verifier), code_challenge_method: "S256", ...(nonce ? { nonce } : {}) })) target.searchParams.set(key, value);
      return reply.header("Set-Cookie", cookie(bind, secure)).header("Referrer-Policy", "no-referrer").redirect(target.href);
    } catch (error) { return reply.redirect(`/?sso_error=${error instanceof SsoFailure ? error.code : "unavailable"}`); }
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>("/api/auth/sso/callback", async (request, reply) => {
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Set-Cookie", cookie("", secure));
    try {
      const state = typeof request.query.state === "string" ? request.query.state : "";
      const attempt = (await auth.pool.query<Attempt>(`DELETE FROM auth_sso_attempts WHERE state_hash=$1
        RETURNING *,expires_at>now() AS valid`, [digest(state)])).rows[0];
      if (request.query.error !== undefined) throw new SsoFailure("denied");
      if (!attempt || !attempt.valid || !timingSafeEqual(Buffer.from(attempt.binding_hash), Buffer.from(digest(binding(request))))) throw new SsoFailure("expired");
      const { configuration: config, clientSecret, version } = await service.current();
      if (!config.enabled) throw new SsoFailure("disabled");
      if (version !== attempt.configuration_version) throw new SsoFailure("expired");
      if (typeof request.query.code !== "string" || !request.query.code) throw new SsoFailure("expired");
      const user = await exchangeIdentity(config, clientSecret, request.query.code, attempt.code_verifier, attempt.nonce, callback);
      const token = await loginSsoAccount(auth, config, user.provider, user.subject, user.claims);
      setCookie(reply, token, secure);
      return reply.redirect(returnPath(attempt.return_path));
    } catch (error) { return reply.redirect(`/?sso_error=${error instanceof SsoFailure ? error.code : "unavailable"}`); }
  });
}
function digestChallenge(value: string) { return createHash("sha256").update(value).digest("base64url"); }
