import { ReviewError, type ModelIdentity } from "../reviews/types.js";

export interface ReviewModel extends ModelIdentity {
  api: "anthropic-messages" | "openai-completions" | "openai-responses";
  baseURL: string;
  apiKeyEnv: string;
}

export interface ReviewModels {
  generator: ReviewModel;
  grader: ReviewModel;
  allowSameVendor?: boolean;
}

export function assertModelSeparation(models: ReviewModels): void {
  if (!models.allowSameVendor &&
    models.generator.vendor.trim().toLowerCase() === models.grader.vendor.trim().toLowerCase()) {
    throw new ReviewError("same_model_vendor", "Generator 与 Grader 默认要求不同厂商；允许同厂商时请设置 UREVIEW_ALLOW_SAME_VENDOR=true");
  }
  if (models.generator.provider === models.grader.provider) {
    throw new ReviewError("same_provider_route", "请为 Generator 和 Grader 配置各自的模型路由名称");
  }
}

export function validateReviewModels(models: ReviewModels): void {
  for (const model of [models.generator, models.grader]) {
    if (!model.vendor.trim() || !model.provider.trim() || !model.model.trim()) {
      throw new ReviewError("invalid_model_config", "模型配置不完整，请检查厂商、路由和模型");
    }
    let url: URL;
    try { url = new URL(model.baseURL); }
    catch { throw new ReviewError("invalid_model_config", "模型接口地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ReviewError("invalid_model_config", "模型接口地址无效");
    }
  }
  assertModelSeparation(models);
}

export function loadReviewModels(env: NodeJS.ProcessEnv = process.env): ReviewModels | undefined {
  if (!Object.keys(env).some((key) => /^UREVIEW_(GENERATOR|GRADER)_/.test(key) && env[key]?.trim())) return undefined;
  function load(phase: "GENERATOR" | "GRADER"): ReviewModel | undefined {
    const prefix = `UREVIEW_${phase}_`;
    const vendor = env[`${prefix}VENDOR`]?.trim();
    const provider = env[`${prefix}PROVIDER`]?.trim();
    const model = env[`${prefix}MODEL`]?.trim();
    const api = env[`${prefix}API`]?.trim();
    const baseURL = env[`${prefix}BASE_URL`]?.trim();
    if (!vendor || !provider || !model || !baseURL ||
      (api !== "anthropic-messages" && api !== "openai-completions" && api !== "openai-responses")) {
      return undefined;
    }
    return { vendor, provider, model, api, baseURL, apiKeyEnv: `${prefix}API_KEY` };
  }
  const generator = load("GENERATOR");
  const grader = load("GRADER");
  if (!generator || !grader) throw new ReviewError("invalid_model_config", "请完整配置 Generator 和 Grader 的模型连接信息");
  const models: ReviewModels = { generator, grader, allowSameVendor: env["UREVIEW_ALLOW_SAME_VENDOR"]?.trim() === "true" };
  validateReviewModels(models);
  return models;
}
