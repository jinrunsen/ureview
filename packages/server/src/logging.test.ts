import { describe, expect, it, vi } from "vitest";
import { failureCategory, logEvent } from "./logging.js";

describe("运行日志", () => {
  it("上游错误正文和密钥不会成为故障分类", () => {
    const secret = "private-test-credential";
    expect(failureCategory(new Error(`security_plugin_uninstalled token=${secret}`))).toBe("security_plugin_required");
    expect(failureCategory(new Error(`unknown failure token=${secret}`))).toBe("operation_failed");
  });

  it("每个事件是一行可关联的 JSON", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      logEvent("review.started", { reviewId: "review-1" });
      expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ event: "review.started", reviewId: "review-1" });
    } finally { output.mockRestore(); }
  });
});
