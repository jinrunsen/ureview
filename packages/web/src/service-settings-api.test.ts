import { afterEach, describe, expect, it, vi } from "vitest";
import { revealModelKey, verifyModelConnection } from "./service-settings-api";

afterEach(() => vi.restoreAllMocks());

describe("模型密钥显示与验证", () => {
  it("显示密钥只提交配置版本并要求响应属于同一版本", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ apiKey: "sk-fixture-generator", version: 4 })));
    expect(await revealModelKey("generator", 4)).toEqual({ apiKey: "sk-fixture-generator", version: 4 });
    const [path, options] = fetch.mock.calls[0]!;
    expect(path).toBe("/api/service-settings/generator/reveal-key");
    expect(options?.method).toBe("POST");
    expect(options?.cache).toBe("no-store");
    expect(JSON.parse(String(options?.body))).toEqual({ version: 4 });
    await expect(revealModelKey("generator", 5)).rejects.toThrow("数据不完整");
  });

  it("验证使用当前连接草稿，空密钥不提交，新的密钥单独提交", async () => {
    const result = { verification: { ok: true, code: "ok", message: "模型调用成功。", latencyMs: 35 } };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify(result)));
    const input = { version: 4, model: "review-pro", baseURL: "https://models.example.test/v1", apiKey: "  " };
    expect(await verifyModelConnection("grader", input)).toEqual(result);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/service-settings/grader/verify");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ version: 4, model: input.model, baseURL: input.baseURL });
    await verifyModelConnection("generator", { ...input, apiKey: " sk-fixture-draft " });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ ...input, apiKey: "sk-fixture-draft" });
  });

  it("模型调用失败作为验证结果展示，拒绝无效结果和无权限响应", async () => {
    const verification = { ok: false, code: "model_authentication_failed", message: "模型服务拒绝了此 API key。", latencyMs: 29 };
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ verification })));
    const input = { version: 2, model: "review-pro", baseURL: "https://models.example.test/v1" };
    expect((await verifyModelConnection("grader", input)).verification).toEqual(verification);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ verification: { ...verification, latencyMs: -1 } })));
    await expect(verifyModelConnection("grader", input)).rejects.toThrow("数据不完整");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "service_admin_required", message: "需要服务管理员权限。" } }), { status: 403 }));
    await expect(revealModelKey("grader", 2)).rejects.toMatchObject({ status: 403, code: "service_admin_required" });
  });
});
