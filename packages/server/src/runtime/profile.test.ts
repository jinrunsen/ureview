import { describe, expect, it } from "vitest";
import { modelContextWindow } from "./profile.js";

describe("模型上下文窗口", () => {
  it("按模型 ID 读取部署声明，未声明时用 128K", () => {
    const env = { UREVIEW_MODEL_CONTEXT_WINDOWS: "DeepSeek-V4-Flash-Local-Csc=262144, glm-5.2-local = 131072" };
    expect(modelContextWindow("DeepSeek-V4-Flash-Local-Csc", env)).toBe(262_144);
    expect(modelContextWindow("glm-5.2-local", env)).toBe(131_072);
    expect(modelContextWindow("other", env)).toBe(131_072);
    expect(modelContextWindow("other", {})).toBe(131_072);
  });

  it("窗口不是足够大的整数时拒绝启动", () => {
    expect(() => modelContextWindow("m", { UREVIEW_MODEL_CONTEXT_WINDOWS: "m=256k" })).toThrow("UREVIEW_MODEL_CONTEXT_WINDOWS");
    expect(() => modelContextWindow("m", { UREVIEW_MODEL_CONTEXT_WINDOWS: "m=8192" })).toThrow("UREVIEW_MODEL_CONTEXT_WINDOWS");
  });
});
