import { afterEach, expect, it, vi } from "vitest";
import { consumeSsoError } from "./sso-errors";
afterEach(() => vi.unstubAllGlobals());
it("显示固定错误说明并移除错误参数，保留其他站内参数", () => {
  const replaceState = vi.fn();
  vi.stubGlobal("window", { location: { href: "https://review.example.test/?sso_error=expired&rules=1#details" }, history: { state: null, replaceState } });
  expect(consumeSsoError()).toBe("登录已过期或来源不一致，请重新登录。");
  expect(replaceState).toHaveBeenCalledWith(null, "", "/?rules=1#details");
});
it.each(["private-provider-response", "__proto__", "constructor"])("未知类别 %s 不作为文案回显", (error) => {
  vi.stubGlobal("window", { location: { href: `https://review.example.test/?sso_error=${error}` }, history: { state: null, replaceState: vi.fn() } });
  expect(consumeSsoError()).toBe("企业登录未完成，请重新登录。");
});
