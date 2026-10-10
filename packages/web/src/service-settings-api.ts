import { isRecord, request } from "./api";

export type ModelPhase = "generator" | "grader";
export interface ModelVerification { ok: boolean; code: string; message: string; latencyMs: number }
export interface VerificationInput { version: number; model: string; baseURL: string; apiKey?: string }

export function revealModelKey(phase: ModelPhase, version: number, signal?: AbortSignal) {
  return request(`/api/service-settings/${phase}/reveal-key`, (value): value is { apiKey: string; version: number } =>
    isRecord(value) && typeof value.apiKey === "string" && value.apiKey.length > 0 && Number.isSafeInteger(value.version) && value.version === version,
  { method: "POST", body: JSON.stringify({ version }), signal });
}

export function verifyModelConnection(phase: ModelPhase, input: VerificationInput, signal?: AbortSignal) {
  const apiKey = input.apiKey?.trim();
  return request(`/api/service-settings/${phase}/verify`, (value): value is { verification: ModelVerification } => {
    if (!isRecord(value) || !isRecord(value.verification)) return false;
    const result = value.verification;
    return typeof result.ok === "boolean" && typeof result.code === "string" && typeof result.message === "string"
      && typeof result.latencyMs === "number" && Number.isFinite(result.latencyMs) && result.latencyMs >= 0;
  }, { method: "POST", body: JSON.stringify({ version: input.version, model: input.model, baseURL: input.baseURL, ...(apiKey ? { apiKey } : {}) }), signal });
}
