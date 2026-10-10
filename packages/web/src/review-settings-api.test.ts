import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { getReviewSettings, saveReviewSettings } from "./review-settings-api";

afterEach(() => vi.restoreAllMocks());

describe("仓库评审范围配置 API", () => {
  it("读取指定仓库的排除目录，保存沿用读取版本与仓库", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ settings: { excludedDirectories: [], version: 0 } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ settings: { excludedDirectories: ["features/steps"], version: 1 } })));
    expect(await getReviewSettings("repository-a")).toEqual({ excludedDirectories: [], version: 0 });
    expect(await saveReviewSettings("repository-a", { excludedDirectories: ["features/steps/"], version: 0 }))
      .toEqual({ excludedDirectories: ["features/steps"], version: 1 });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/repositories/repository-a/review-settings");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/repositories/repository-a/review-settings");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "PUT", body: JSON.stringify({ excludedDirectories: ["features/steps/"], version: 0 }) });
  });

  it("保留版本冲突标识，交由页面核对最新配置", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { code: "review_settings_conflict", message: "评审范围已被修改" } }), { status: 409 }));
    await expect(saveReviewSettings("repository-a", { excludedDirectories: ["features/steps"], version: 2 }))
      .rejects.toEqual(new ApiError(409, "review_settings_conflict", "评审范围已被修改"));
  });

  it("读取和保存按仓库编码路径并传递取消信号", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ settings: { excludedDirectories: [], version: 0 } })));
    const controller = new AbortController();
    await getReviewSettings("repository/a", controller.signal);
    fetch.mockResolvedValue(new Response(JSON.stringify({ settings: { excludedDirectories: [], version: 1 } })));
    await saveReviewSettings("repository/b", { excludedDirectories: [], version: 0 }, controller.signal);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/repositories/repository%2Fa/review-settings");
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/repositories/repository%2Fb/review-settings");
    expect(fetch.mock.calls.map((call) => call[1]?.signal)).toEqual([controller.signal, controller.signal]);
  });

  it.each([
    { excludedDirectories: [], version: -1 },
    { excludedDirectories: [], version: 1.5 },
    { excludedDirectories: [null], version: 1 },
    { excludedDirectories: [""], version: 1 },
    { excludedDirectories: ["x".repeat(513)], version: 1 },
    { excludedDirectories: Array(101).fill("features"), version: 1 },
  ])("拒绝无效的目录列表或版本", async (settings) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ settings })));
    await expect(getReviewSettings("repository-a")).rejects.toThrow("服务返回的数据不完整");
  });
});
