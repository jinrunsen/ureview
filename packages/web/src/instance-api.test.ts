import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstanceHealth, getOnboarding, type InstanceHealth, type OnboardingChecklist } from "./instance-api";

const onboarding: OnboardingChecklist = {
  completed: false, canManageModels: false, repositoryId: "payment-gateway",
  steps: [{ id: "models", completed: true }, { id: "repository", completed: true }, { id: "webhook", completed: false }, { id: "rules", completed: false }, { id: "review", completed: false }],
};
const health: InstanceHealth = {
  period: { from: "2026-09-29T00:00:00Z", to: "2026-10-06T00:00:00Z" },
  models: [
    { phase: "generator", configured: true, source: "database", model: "review-pro", lastSuccessAt: "2026-10-05T12:00:00Z", lastFailure: { at: "2026-10-05T10:00:00Z", code: "rate_limited" } },
    { phase: "grader", configured: false, source: "none", model: "", lastSuccessAt: null, lastFailure: null },
  ],
  queue: { queued: 1, running: 2, oldestQueuedAt: "2026-10-05T23:55:00Z", oldestWaitSeconds: 300 },
  failures: [{ code: "review_failed", count: 1, reviews: [{ id: "payment-review", title: "更新支付校验", repositoryName: "支付网关", iid: 7, round: 2, completedAt: "2026-10-05T12:00:00Z", teamId: "payment", teamName: "支付团队", canOpen: false }] }],
  modelMetrics: [{ phase: "generator", provider: "model-gateway", model: "review-pro", total: 4, completed: 3, failed: 1, completionRate: 0.75, averageRejectedSubmissions: 0.5 }],
  versions: { ureview: "0.0.0", dsh: "0.8.0", migration: "0030-instance-health.sql" },
};
function respond(value: unknown, status = 200) { return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(value), { status })); }
afterEach(() => vi.restoreAllMocks());

describe("引导与实例健康 API 契约", () => {
  it("读取五步系统状态并保留模型管理权限", async () => {
    const fetch = respond({ onboarding });
    expect(await getOnboarding()).toEqual(onboarding);
    expect(fetch).toHaveBeenCalledWith("/api/onboarding", expect.objectContaining({ cache: "no-store" }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ onboarding: { ...onboarding, steps: [onboarding.steps[0], ...onboarding.steps.slice(0, 4)] } })));
    await expect(getOnboarding()).rejects.toThrow("数据不完整");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ onboarding: { ...onboarding, completed: true } })));
    await expect(getOnboarding()).rejects.toThrow("数据不完整");
  });

  it("健康记录保留跨团队评审权限与平均被拒提交次数", async () => {
    const fetch = respond({ health });
    const result = await getInstanceHealth();
    expect(result).toEqual(health);
    expect(fetch).toHaveBeenCalledWith("/api/instance-health", expect.objectContaining({ cache: "no-store" }));
    expect(result.failures[0]?.reviews[0]?.canOpen).toBe(false);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ health: { ...health, modelMetrics: [{ ...health.modelMetrics[0], completionRate: 1.5 }] } })));
    await expect(getInstanceHealth()).rejects.toThrow("数据不完整");
  });

  it("拒绝未知模型失败分类和不完整的跨团队评审记录", async () => {
    const fetch = respond({ health: { ...health, models: [{ ...health.models[0], lastFailure: { at: "2026-10-05T10:00:00Z", code: "raw_upstream_message" } }, health.models[1]] } });
    await expect(getInstanceHealth()).rejects.toThrow("数据不完整");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ health: { ...health, failures: [{ ...health.failures[0], reviews: [{ ...health.failures[0]?.reviews[0], canOpen: undefined }] }] } })));
    await expect(getInstanceHealth()).rejects.toThrow("数据不完整");
  });

  it("权限错误保留服务端说明", async () => {
    const fetch = respond({ error: { code: "service_admin_required", message: "需要服务管理员权限。" } }, 403);
    await expect(getInstanceHealth()).rejects.toMatchObject({ status: 403, code: "service_admin_required" });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "admin_required", message: "需要团队管理员权限。" } }), { status: 403 }));
    await expect(getOnboarding()).rejects.toMatchObject({ status: 403, code: "admin_required" });
  });
});
