import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const transport = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: transport.lookup }));
vi.mock("node:https", () => ({ request: transport.request }));
import { publicAddress, sendWebhook } from "./webhook.js";

beforeEach(() => { transport.lookup.mockReset(); transport.request.mockReset(); });

describe("通知出口网络边界", () => {
  it("DNS 同时返回公网和内网地址时不建立连接", async () => {
    transport.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
    await expect(sendWebhook("https://notifications.example.com/hook", { body: "讨论" }, "delivery-1")).rejects.toThrow("公网");
    expect(transport.request).not.toHaveBeenCalled();
  });
  it("连接复用已校验地址，发送幂等投递标识并拒绝重定向", async () => {
    transport.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
    let options: { lookup: (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void; method: string; headers: Record<string, string> } | undefined;
    const received: string[] = [];
    transport.request.mockImplementation((_url: URL, settings: typeof options, onResponse: (response: unknown) => void) => {
      options = settings;
      const outgoing = Object.assign(new EventEmitter(), {
        destroy: vi.fn(), end: (body: string) => {
          received.push(body);
          onResponse({ statusCode: 302, resume: () => {}, destroy: () => {} });
          queueMicrotask(() => outgoing.emit("close"));
        },
      });
      return outgoing;
    });
    await expect(sendWebhook("https://notifications.example.com/hook", { body: "讨论" }, "delivery-1")).rejects.toThrow("返回失败");
    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(options?.method).toBe("POST"); expect(options?.headers["X-UReview-Delivery"]).toBe("delivery-1");
    const ordinary = vi.fn(); options?.lookup("notifications.example.com", {}, ordinary);
    expect(ordinary).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    const multiple = vi.fn(); options?.lookup("notifications.example.com", { all: true }, multiple);
    expect(multiple).toHaveBeenCalledWith(null, [{ address: "8.8.8.8", family: 4 }]);
    expect(transport.lookup).toHaveBeenCalledTimes(1);
    expect(JSON.parse(received[0]!)).toEqual({ body: "讨论" });
  });
  it("展开形式的 IPv6 特殊用途地址也被拒绝", () => {
    for (const address of ["2001:0000:0:0:0:0:0:1", "2001:0002::1", "2001:0db8::1", "2002:7f00:1::", "3fff:0000::1"]) expect(publicAddress(address)).toBe(false);
  });
});
