import type pg from "pg";
import type { FastifyInstance } from "fastify";
import { AuthError, requireServiceAdmin } from "./context.js";
import type { CredentialCipher } from "../repositories/credentials.js";

export interface SsoConfig {
  enabled: boolean; protocol: "oidc" | "oauth2"; issuer: string;
  authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string;
  clientId: string; scope: string; tokenAuthMethod: "client_secret_basic" | "client_secret_post";
  buttonLabel: string; subjectField: string; usernameField: string; nameField: string; emailField: string;
  linking: "username" | "email" | "none"; defaultTeamId: string; passwordLogin: "all" | "service_admin";
}
export const defaultSsoConfig: SsoConfig = {
  enabled: false, protocol: "oidc", issuer: "", authorizationEndpoint: "", tokenEndpoint: "", userinfoEndpoint: "",
  clientId: "", scope: "openid profile email", tokenAuthMethod: "client_secret_basic", buttonLabel: "使用企业账号登录",
  subjectField: "sub", usernameField: "preferred_username", nameField: "name", emailField: "email",
  linking: "username", defaultTeamId: "", passwordLogin: "all",
};
interface ConfigRow { configuration: Partial<SsoConfig>; client_secret: Buffer | null; version: number }
export interface SsoInput { version: number; configuration: SsoConfig; clientSecret?: string }
function invalid(): never { throw new AuthError(400, "invalid_sso_config", "请检查企业登录配置的必填项、地址和字段路径"); }
export function ssoUrl(value: string): string {
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.username || url.password || url.hash) invalid();
    return url.href;
  } catch { return invalid(); }
}
export function validateSsoConfig(value: unknown): SsoConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const config = { ...defaultSsoConfig, ...value };
  if (Object.keys(config).some((key) => !Object.hasOwn(defaultSsoConfig, key))) invalid();
  if (typeof config.enabled !== "boolean") invalid();
  for (const [key, item] of Object.entries(config)) if (key !== "enabled" && (typeof item !== "string" || item.length > 2048 || /[\x00-\x1f\x7f]/.test(item))) invalid();
  if (!["oidc", "oauth2"].includes(config.protocol) || !["client_secret_basic", "client_secret_post"].includes(config.tokenAuthMethod)
    || !["username", "email", "none"].includes(config.linking) || !["all", "service_admin"].includes(config.passwordLogin)
    || !config.buttonLabel.trim() || config.buttonLabel.length > 40) invalid();
  for (const field of [config.subjectField, config.usernameField, config.nameField, config.emailField]) {
    if (field && !/^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*)*$/.test(field)) invalid();
  }
  if (config.enabled) {
    if (!config.clientId.trim() || !config.subjectField || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(config.defaultTeamId)) invalid();
    for (const endpoint of config.protocol === "oidc" ? [config.issuer] : [config.authorizationEndpoint, config.tokenEndpoint, config.userinfoEndpoint]) ssoUrl(endpoint);
  }
  return config;
}
class DiscoveryFailure extends Error {
  constructor(readonly code: "unavailable" | "invalid_discovery" | "issuer_mismatch", readonly discoveredIssuer?: string) { super("身份源连接测试未通过"); }
}
export async function discover(issuer: string, timeout = 5000) {
  ssoUrl(issuer);
  let response: Response;
  try {
    response = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(timeout), redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw new Error(); }
  } catch { throw new DiscoveryFailure("unavailable"); }
  let value: unknown;
  try { value = await response.json(); }
  catch (error) { throw new DiscoveryFailure(error instanceof SyntaxError ? "invalid_discovery" : "unavailable"); }
  let source: { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; userinfoEndpoint: string };
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("issuer" in value) || typeof value.issuer !== "string"
      || !value.issuer || value.issuer.length > 2048 || /[\x00-\x20\x7f]/.test(value.issuer)
      || !("authorization_endpoint" in value) || typeof value.authorization_endpoint !== "string"
      || !("token_endpoint" in value) || typeof value.token_endpoint !== "string") throw new Error();
    ssoUrl(value.issuer);
    if (new URL(value.issuer).search) throw new Error();
    const userinfo = "userinfo_endpoint" in value ? value.userinfo_endpoint : undefined;
    if (userinfo !== undefined && typeof userinfo !== "string") throw new Error();
    source = { issuer: value.issuer, authorizationEndpoint: ssoUrl(value.authorization_endpoint), tokenEndpoint: ssoUrl(value.token_endpoint),
      userinfoEndpoint: userinfo ? ssoUrl(userinfo) : "" };
  } catch { throw new DiscoveryFailure("invalid_discovery"); }
  if (source.issuer !== issuer) throw new DiscoveryFailure("issuer_mismatch", source.issuer);
  return source;
}
export class SsoConfiguration {
  constructor(readonly pool: pg.Pool, private readonly cipher: CredentialCipher, readonly publicOrigin: string) {}
  async current() {
    const row = (await this.pool.query<ConfigRow>("SELECT * FROM service_sso WHERE singleton")).rows[0]!;
    return { configuration: { ...defaultSsoConfig, ...row.configuration }, version: row.version,
      clientSecret: row.client_secret ? this.cipher.decrypt(row.client_secret, "service-sso:client-secret") : "" };
  }
  async view() {
    requireServiceAdmin();
    const row = await this.current();
    return { configuration: row.configuration, version: row.version, secretConfigured: Boolean(row.clientSecret),
      callbackUrl: `${this.publicOrigin}/api/auth/sso/callback`,
      teams: (await this.pool.query<{ id: string; name: string }>("SELECT id,name FROM teams ORDER BY created_at,id")).rows };
  }
  async save(input: SsoInput) {
    const admin = requireServiceAdmin();
    if (!input || typeof input !== "object") invalid();
    const configuration = validateSsoConfig(input.configuration);
    if (!Number.isSafeInteger(input.version) || input.version < 0 || (input.clientSecret !== undefined && (typeof input.clientSecret !== "string" || input.clientSecret.length > 4096))) invalid();
    const current = await this.current();
    if (current.version !== input.version) throw new AuthError(409, "sso_conflict", "配置已被更新，请刷新页面后重新填写");
    const secret = input.clientSecret?.trim() || current.clientSecret;
    if (configuration.enabled && (!secret || !(await this.pool.query("SELECT id FROM teams WHERE id=$1", [configuration.defaultTeamId])).rowCount)) invalid();
    const result = await this.pool.query(`UPDATE service_sso SET configuration=$1,client_secret=$2,version=version+1,updated_by=$3,updated_at=now()
      WHERE singleton AND version=$4`, [configuration, secret ? this.cipher.encrypt(secret, "service-sso:client-secret") : null, admin.userId, input.version]);
    if (!result.rowCount) throw new AuthError(409, "sso_conflict", "配置已被更新，请刷新页面后重新填写");
    return this.view();
  }
  async test(input: { protocol: string; issuer?: string; authorizationEndpoint?: string }) {
    requireServiceAdmin();
    try {
      if (input.protocol === "oidc") return { ok: true, code: "reachable", ...await discover(input.issuer ?? "") };
      if (input.protocol !== "oauth2") invalid();
      const response = await fetch(ssoUrl(input.authorizationEndpoint ?? ""), { signal: AbortSignal.timeout(5000), redirect: "manual" });
      await response.body?.cancel();
      return { ok: response.status < 500, code: response.status < 500 ? "reachable" : "unavailable" };
    } catch (error) {
      if (error instanceof DiscoveryFailure) return { ok: false, code: error.code,
        ...(error.code === "issuer_mismatch" ? { discoveredIssuer: error.discoveredIssuer } : {}) };
      return { ok: false, code: "unavailable" };
    }
  }
}
export function registerSsoConfiguration(app: FastifyInstance, service: SsoConfiguration) {
  app.get("/api/service-sso", () => service.view());
  app.put<{ Body: SsoInput }>("/api/service-sso", { bodyLimit: 16384 }, (request) => service.save(request.body));
  app.post<{ Body: { protocol: string; issuer?: string; authorizationEndpoint?: string } }>("/api/service-sso/test", { bodyLimit: 16384 }, (request) => service.test(request.body));
}
