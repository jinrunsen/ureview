import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionPreferences, saveSessionPreferences } from "./agent-session-preferences";

afterEach(() => vi.unstubAllGlobals());

describe("会话面板的浏览器偏好", () => {
  it("每位用户分别恢复宽度和全屏选择", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    saveSessionPreferences("zhang-wei", { width: 75, full: true });
    expect(readSessionPreferences("zhang-wei")).toEqual({ width: 75, full: true });
    expect(readSessionPreferences("li-na")).toEqual({ width: 65, full: false });
    saveSessionPreferences("li-na", { width: 50, full: false });
    expect(readSessionPreferences("zhang-wei")).toEqual({ width: 75, full: true });
  });
  it("无效内容和越界宽度分别降级，不阻止查看会话", () => {
    const getItem = vi.fn().mockReturnValue("{");
    vi.stubGlobal("localStorage", { getItem });
    expect(readSessionPreferences("zhang-wei")).toEqual({ width: 65, full: false });
    getItem.mockReturnValue('{"width":200,"full":true}');
    expect(readSessionPreferences("zhang-wei")).toEqual({ width: 65, full: true });
    getItem.mockReturnValue('{"width":70,"full":"true"}');
    expect(readSessionPreferences("zhang-wei")).toEqual({ width: 70, full: false });
  });
  it("浏览器拒绝读写存储时仍可使用默认布局", () => {
    vi.stubGlobal("localStorage", {
      getItem() { throw new Error("存储不可用"); },
      setItem() { throw new Error("存储不可用"); },
    });
    expect(readSessionPreferences("zhang-wei")).toEqual({ width: 65, full: false });
    expect(() => saveSessionPreferences("zhang-wei", { width: 75, full: true })).not.toThrow();
  });
});
