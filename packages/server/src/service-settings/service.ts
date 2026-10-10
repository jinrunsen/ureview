import type pg from "pg";
import { AuthError, requireServiceAdmin } from "../auth/context.js";
import type { CredentialCipher } from "../repositories/credentials.js";

import { loadReviewModels } from "../runtime/config.js";
import { verifyModelConnection, type ModelProbe } from "../runtime/model-probe.js";
import { modelFailureCode } from "../instance-health/model-failure.js";

export interface ModelSettingsInput { version: number; generatorApiKey?: string; graderApiKey?: string; generatorModel?: string; generatorBaseURL?: string; graderModel?: string; graderBaseURL?: string }

const phases = ["generator", "grader"] as const;
type Phase = typeof phases[number];
export interface ModelVerificationInput { version: number; model: string; baseURL: string; apiKey?: string }
interface KeyRow { generator: Buffer | null; grader: Buffer | null; version: number; generator_model: string | null; grader_model: string | null; generator_base_url: string | null; grader_base_url: string | null }
export class ServiceSettings {
  constructor(private readonly pool: pg.Pool, private readonly cipher: CredentialCipher,
    private readonly env: NodeJS.ProcessEnv = process.env, private readonly probe: ModelProbe = verifyModelConnection) {}

  private async current(version: number): Promise<KeyRow> {
    requireServiceAdmin();
    if (!Number.isInteger(version) || version < 0) throw new AuthError(400, "invalid_settings_version", "配置版本不正确，请刷新页面");
    const row = (await this.pool.query<KeyRow>("SELECT * FROM service_model_keys")).rows[0]!;
    if (row.version !== version) throw new AuthError(409, "service_settings_conflict", "服务配置已被更新，请刷新页面后重新填写");
    return row;
  }

  private storedKey(row: KeyRow, phase: Phase): string | undefined {
    const encrypted = row[phase];
    return encrypted ? this.cipher.decrypt(encrypted, `service-model:${phase}`) : this.env[`UREVIEW_${phase.toUpperCase()}_API_KEY`]?.trim() || undefined;
  }

  async revealKey(phase: Phase, version: number) {
    const row = await this.current(version);
    const apiKey = this.storedKey(row, phase);
    if (!apiKey) throw new AuthError(404, "model_key_not_configured", "尚未配置 API key");
    return { apiKey, version: row.version };
  }

  async verify(phase: Phase, input: ModelVerificationInput) {
    const row = await this.current(input.version);
    const model = this.model(input.model);
    const baseURL = this.url(input.baseURL);
    if (!model || !baseURL) throw new AuthError(400, "invalid_model_config", "请填写模型名称和 Base URL");
    const apiKey = this.keyValue(input.apiKey) ?? this.storedKey(row, phase);
    if (!apiKey) throw new AuthError(400, "model_key_not_configured", "请先填写 API key");
    const prefix = `UREVIEW_${phase.toUpperCase()}_`;
    const api = this.env[`${prefix}API`]?.trim();
    if (api !== "anthropic-messages" && api !== "openai-completions" && api !== "openai-responses") {
      throw new AuthError(400, "model_protocol_not_configured", "模型调用协议尚未配置，请检查服务部署配置");
    }
    const configuredProvider = this.env[`${prefix}PROVIDER`]?.trim();
    const provider = configuredProvider ? `${configuredProvider}-v${row.version}` : `ureview-${phase}`;
    const result = await this.probe({ api, provider, model, baseURL, apiKey });
    if (result.ok) {
      await this.pool.query(`INSERT INTO service_model_health(phase,last_success_at) VALUES($1,now())
        ON CONFLICT(phase) DO UPDATE SET last_success_at=excluded.last_success_at`, [phase]);
    } else {
      await this.pool.query(`INSERT INTO service_model_health(phase,last_failure_at,last_failure_code) VALUES($1,now(),$2)
        ON CONFLICT(phase) DO UPDATE SET last_failure_at=excluded.last_failure_at,last_failure_code=excluded.last_failure_code`,
      [phase, modelFailureCode(result.code)]);
    }
    return result;
  }

  async resolve(ref: string): Promise<string | undefined> {
    const phase = phases.find((value) => ref === `UREVIEW_${value.toUpperCase()}_API_KEY`);
    if (!phase) return undefined;
    const row = (await this.pool.query<KeyRow>("SELECT * FROM service_model_keys")).rows[0];
    const encrypted = row?.[phase];
    return encrypted ? this.cipher.decrypt(encrypted, `service-model:${phase}`) : undefined;
  }

  async view() {
    requireServiceAdmin();
    const row = (await this.pool.query<KeyRow>("SELECT * FROM service_model_keys")).rows[0]!;
    const info = (phase: Phase) => {
      const prefix = `UREVIEW_${phase.toUpperCase()}_`;
      return { configured: Boolean(row[phase] || this.env[`${prefix}API_KEY`]?.trim()),
        source: row[phase] ? "database" : this.env[`${prefix}API_KEY`]?.trim() ? "environment" : "none",
        model: row[`${phase}_model`] ?? this.env[`${prefix}MODEL`] ?? "", baseURL: row[`${phase}_base_url`] ?? this.env[`${prefix}BASE_URL`] ?? "" };
    };
    return { version: row.version, generator: info("generator"), grader: info("grader") };
  }

  async save(input: ModelSettingsInput) {
    const admin = requireServiceAdmin();
    const generator = this.key(input.generatorApiKey, "generator");
    const grader = this.key(input.graderApiKey, "grader");
    const generatorModel = this.model(input.generatorModel);
    const graderModel = this.model(input.graderModel);
    const generatorURL = this.url(input.generatorBaseURL);
    const graderURL = this.url(input.graderBaseURL);
    if (!generator && !grader && !generatorModel && !graderModel && !generatorURL && !graderURL) throw new AuthError(400, "empty_model_keys", "请至少填写一项模型配置");
    const result = await this.pool.query(`UPDATE service_model_keys SET generator=coalesce($1,generator),grader=coalesce($2,grader),
      generator_model=coalesce($5,generator_model),grader_model=coalesce($6,grader_model),
      generator_base_url=coalesce($7,generator_base_url),grader_base_url=coalesce($8,grader_base_url),
      version=version+1,updated_by=$3,updated_at=now() WHERE singleton AND version=$4 RETURNING version`, [generator,grader,admin.userId,input.version,generatorModel,graderModel,generatorURL,graderURL]);
    if (!result.rowCount) throw new AuthError(409, "service_settings_conflict", "服务配置已被更新，请刷新页面后重新填写");
    return this.view();
  }

  async models() {
    const row = (await this.pool.query<KeyRow>("SELECT * FROM service_model_keys")).rows[0]!;
    return loadReviewModels(this.modelEnvironment(row));
  }

  /** 只返回配置是否齐全；引导读取不暴露连接地址或密钥。 */
  async availability() {
    const row = (await this.pool.query<KeyRow>("SELECT * FROM service_model_keys")).rows[0]!;
    const env = this.modelEnvironment(row);
    const models = phases.map((phase) => {
      const prefix = `UREVIEW_${phase.toUpperCase()}_`;
      const model = env[`${prefix}MODEL`]?.trim() ?? "";
      const baseURL = env[`${prefix}BASE_URL`]?.trim() ?? "";
      let validURL = false;
      try {
        const url = new URL(baseURL);
        validURL = ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
      } catch { /* 未配置时保持未完成。 */ }
      const hasKey = Boolean(row[phase] || env[`${prefix}API_KEY`]?.trim());
      const configured = Boolean(hasKey && model && validURL && env[`${prefix}VENDOR`]?.trim() && env[`${prefix}PROVIDER`]?.trim()
        && ["anthropic-messages", "openai-completions", "openai-responses"].includes(env[`${prefix}API`]?.trim() ?? ""));
      const source: "database" | "environment" | "none" = row[phase] || row[`${phase}_model`] || row[`${phase}_base_url`] ? "database"
        : Object.entries(env).some(([key, value]) => key.startsWith(prefix) && value?.trim()) ? "environment" : "none";
      return { phase, configured, source, model };
    });
    let ready = models.every((model) => model.configured);
    try { ready = Boolean(loadReviewModels(env)) && ready; } catch { ready = false; }
    return { ready, models };
  }

  private modelEnvironment(row: KeyRow): NodeJS.ProcessEnv {
    const env = { ...this.env };
    for (const phase of phases) {
      const prefix = `UREVIEW_${phase.toUpperCase()}_`;
      if (row[`${phase}_model`]) env[`${prefix}MODEL`] = row[`${phase}_model`]!;
      if (row[`${phase}_base_url`]) env[`${prefix}BASE_URL`] = row[`${phase}_base_url`]!;
      if (env[`${prefix}PROVIDER`]) env[`${prefix}PROVIDER`] = `${env[`${prefix}PROVIDER`]}-v${row.version}`;
    }
    return env;
  }

  private model(value: string | undefined): string | null {
    if (value === undefined) return null;
    const model = value.trim();
    if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model)) throw new AuthError(400, "invalid_model_name", "模型名称需为 1 至 256 个字符");
    return model;
  }
  private url(value: string | undefined): string | null {
    if (value === undefined) return null;
    let url: URL;
    try { url = new URL(value.trim()); } catch { throw new AuthError(400, "invalid_model_url", "请填写有效的模型 Base URL"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || value.length > 2048) {
      throw new AuthError(400, "invalid_model_url", "模型 Base URL 不得包含凭据、查询参数或片段");
    }
    return url.toString().replace(/\/$/, "");
  }

  private keyValue(value: string | undefined): string | null {
    if (!value?.trim()) return null;
    const key = value.trim();
    if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new AuthError(400, "invalid_model_key", "API key 需为不含空白的 ASCII 字符，最多 4096 个字符");
    return key;
  }

  private key(value: string | undefined, phase: Phase): Buffer | null {
    const key = this.keyValue(value);
    return key === null ? null : this.cipher.encrypt(key, `service-model:${phase}`);
  }

  async users() {
    requireServiceAdmin();
    return (await this.pool.query<{ id: string; username: string; name: string; email: string | null; serviceRole: string }>(
      'SELECT id,username,name,email,service_role AS "serviceRole" FROM auth_users ORDER BY created_at,id')).rows;
  }

  async setRole(userId: string, role: "user" | "service_admin") {
    requireServiceAdmin();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(1937462282)");
      const current = (await client.query<{ service_role: string; has_password: boolean }>("SELECT service_role,password_hash IS NOT NULL AS has_password FROM auth_users WHERE id=$1", [userId])).rows[0];
      if (!current) throw new AuthError(404, "user_not_found", "账号不存在");
      if (current.service_role === "service_admin" && role === "user") {
        const count = (await client.query<{ count: string }>("SELECT count(*) FROM auth_users WHERE service_role='service_admin'")).rows[0]!;
        if (Number(count.count) <= 1) throw new AuthError(409, "last_service_admin", "至少需要保留一名服务管理员");
        if (current.has_password) {
          const passwords = (await client.query<{ count: string }>("SELECT count(*) FROM auth_users WHERE service_role='service_admin' AND password_hash IS NOT NULL")).rows[0]!;
          if (Number(passwords.count) <= 1) throw new AuthError(409, "last_password_service_admin", "至少需要保留一名可用密码登录的服务管理员");
        }
      }
      await client.query("UPDATE auth_users SET service_role=$1 WHERE id=$2", [role,userId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
