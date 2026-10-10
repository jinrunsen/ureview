import { discover, ssoUrl, type SsoConfig } from "./sso-config.js";

export type SsoFailureCode = "disabled" | "expired" | "denied" | "unavailable" | "missing_identity" | "no_team";
export class SsoFailure extends Error {
  constructor(readonly code: SsoFailureCode) { super("企业登录未完成"); }
}
export function fieldAt(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split(".")) {
    if (!key || ["__proto__", "prototype", "constructor"].includes(key) || !current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = Reflect.get(current, key);
  }
  return current;
}
export function returnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || /[\\\x00-\x20\x7f]/.test(value)) return "/";
  try {
    const url = new URL(value, "https://ureview.invalid");
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== "https://ureview.invalid" || /[%\\]/.test(path) || path.startsWith("//") || path === "/api" || path.startsWith("/api/")) return "/";
    const normalized = new URL(path, "https://ureview.invalid");
    if (normalized.pathname === "/api" || normalized.pathname.startsWith("/api/") || normalized.origin !== url.origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return "/"; }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SsoFailure("unavailable");
  return value as Record<string, unknown>;
}
export function validateIdToken(token: unknown, issuer: string, clientId: string, nonce: string): Record<string, unknown> {
  try {
    if (typeof token !== "string" || token.length > 65536 || token.split(".").length !== 3) throw new Error();
    const claims = record(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")));
    const audience = claims.aud;
    if (claims.iss !== issuer || !(audience === clientId || (Array.isArray(audience) && audience.every((a) => typeof a === "string") && audience.includes(clientId)))
      || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 || claims.nonce !== nonce
      || (claims.azp !== undefined && claims.azp !== clientId) || (Array.isArray(audience) && audience.length > 1 && claims.azp !== clientId)) throw new Error();
    if (typeof claims.sub !== "string" || !claims.sub.trim()) throw new SsoFailure("missing_identity");
    return claims;
  } catch (error) { if (error instanceof SsoFailure) throw error; throw new SsoFailure("unavailable"); }
}
export async function endpoints(config: SsoConfig) {
  try {
    if (config.protocol === "oidc") return await discover(config.issuer, 10000);
    const token = new URL(ssoUrl(config.tokenEndpoint)); token.search = "";
    return { issuer: token.href, authorizationEndpoint: ssoUrl(config.authorizationEndpoint), tokenEndpoint: ssoUrl(config.tokenEndpoint), userinfoEndpoint: ssoUrl(config.userinfoEndpoint) };
  } catch { throw new SsoFailure("unavailable"); }
}
export async function exchangeIdentity(config: SsoConfig, secret: string, code: string, verifier: string, nonce: string | null, callback: string) {
  try {
    const source = await endpoints(config);
    const body = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: callback });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (config.tokenAuthMethod === "client_secret_basic") {
      const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
      headers.authorization = `Basic ${Buffer.from(`${encode(config.clientId)}:${encode(secret)}`).toString("base64")}`;
    } else { body.set("client_id", config.clientId); body.set("client_secret", secret); }
    const response = await fetch(source.tokenEndpoint, { method: "POST", body, headers, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new SsoFailure("unavailable"); }
    const tokens = record(await response.json());
    let claims = config.protocol === "oidc" ? validateIdToken(tokens.id_token, source.issuer, config.clientId, nonce ?? "") : {};
    if (source.userinfoEndpoint) {
      if (typeof tokens.access_token !== "string" || !tokens.access_token || /[\r\n]/.test(tokens.access_token)) throw new SsoFailure("unavailable");
      const info = await fetch(source.userinfoEndpoint, { headers: { authorization: `Bearer ${tokens.access_token}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!info.ok) { await info.body?.cancel(); throw new SsoFailure("unavailable"); }
      const userinfo = record(await info.json());
      if (config.protocol === "oidc" && userinfo.sub !== claims.sub) throw new SsoFailure("unavailable");
      // 任何一份声明明确说邮箱未验证时，都禁止邮箱关联。
      const unverified = claims.email_verified === false || userinfo.email_verified === false;
      claims = { ...claims, ...userinfo, ...(unverified ? { email_verified: false } : {}) };
    }
    const rawSubject = fieldAt(claims, config.subjectField);
    const subject = typeof rawSubject === "number" && Number.isSafeInteger(rawSubject) ? String(rawSubject) : typeof rawSubject === "string" && rawSubject.trim() ? rawSubject : "";
    if (!subject) throw new SsoFailure("missing_identity");
    return { provider: source.issuer, subject, claims };
  } catch (error) { if (error instanceof SsoFailure) throw error; throw new SsoFailure("unavailable"); }
}
