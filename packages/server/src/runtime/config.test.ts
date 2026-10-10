import { describe, expect, it } from "vitest";
import { loadReviewModels, validateReviewModels } from "./config.js";

const configured = {
  UREVIEW_GENERATOR_VENDOR: "vendor-a", UREVIEW_GENERATOR_PROVIDER: "generator",
  UREVIEW_GENERATOR_MODEL: "model-a", UREVIEW_GENERATOR_API: "anthropic-messages",
  UREVIEW_GENERATOR_BASE_URL: "https://models.example.test", UREVIEW_GENERATOR_API_KEY: "secret-a",
  UREVIEW_GRADER_VENDOR: "vendor-b", UREVIEW_GRADER_PROVIDER: "grader",
  UREVIEW_GRADER_MODEL: "model-b", UREVIEW_GRADER_API: "openai-completions",
  UREVIEW_GRADER_BASE_URL: "https://models.example.test/v1", UREVIEW_GRADER_API_KEY: "secret-b",
};

describe("评审模型配置", () => {
  it("未配置任何模型时仍允许启动仓库接入服务", () => {
    expect(loadReviewModels({})).toBeUndefined();
  });
  it("密钥未填写时可以启动，在服务配置页面补充密钥", () => {
    expect(loadReviewModels({ ...configured, UREVIEW_GENERATOR_API_KEY: "", UREVIEW_GRADER_API_KEY: "" })?.generator.model).toBe("model-a");
  });
  it("完整配置只返回密钥环境变量名", () => {
    const models = loadReviewModels(configured);
    expect(models?.generator.vendor).toBe("vendor-a");
    expect(models?.grader.apiKeyEnv).toBe("UREVIEW_GRADER_API_KEY");
    expect(JSON.stringify(models)).not.toContain("secret-");
  });
  it("显式允许同厂商后保留厂商身份，后续校验使用已加载的选择", () => {
    const env = { ...configured, UREVIEW_GENERATOR_VENDOR: "deepseek", UREVIEW_GRADER_VENDOR: "deepseek",
      UREVIEW_ALLOW_SAME_VENDOR: "true" };
    const models = loadReviewModels(env)!;
    expect(models.allowSameVendor).toBe(true);
    expect(models.generator.vendor).toBe("deepseek");
    expect(models.grader.vendor).toBe("deepseek");
    env.UREVIEW_ALLOW_SAME_VENDOR = "false";
    expect(() => validateReviewModels(models)).not.toThrow();
  });
  it.each([undefined, "", "false", "1"])("同厂商开关为 %s 时仍拒绝同厂商", (allowSameVendor) => {
    expect(() => loadReviewModels({ ...configured, UREVIEW_GRADER_VENDOR: "vendor-a",
      UREVIEW_ALLOW_SAME_VENDOR: allowSameVendor })).toThrow(expect.objectContaining({ code: "same_model_vendor" }));
  });
  it("允许同厂商时仍拒绝共用模型路由", () => {
    expect(() => loadReviewModels({ ...configured, UREVIEW_GRADER_VENDOR: "vendor-a",
      UREVIEW_GRADER_PROVIDER: "generator", UREVIEW_ALLOW_SAME_VENDOR: "true" }))
      .toThrow(expect.objectContaining({ code: "same_provider_route" }));
  });
  it.each([
    { UREVIEW_GENERATOR_MODEL: "model-only" },
    { ...configured, UREVIEW_GRADER_VENDOR: "VENDOR-A" },
    { ...configured, UREVIEW_GRADER_PROVIDER: "generator" },
    { ...configured, UREVIEW_GRADER_API: "unsupported" },
    { ...configured, UREVIEW_GRADER_BASE_URL: "https://secret-user:secret-pass@models.example.test" },
  ])("不完整或相互冲突的模型配置在启动前失败且不显示密钥", (env) => {
    expect(() => loadReviewModels(env)).toThrow();
    try { loadReviewModels(env); }
    catch (error) { expect(String(error)).not.toContain("secret-"); }
  });
});
