import { expect, it } from "vitest";
import { ssoConnectionMessage } from "./sso-connection";
it("连接测试分别提示网络、文档格式和 Issuer 差异", () => {
  expect(ssoConnectionMessage({ ok: false, code: "unavailable" })).toBe("无法访问统一认证，请检查地址和网络。");
  expect(ssoConnectionMessage({ ok: false, code: "invalid_discovery" })).toContain("discovery 内容无效");
  expect(ssoConnectionMessage({ ok: false, code: "issuer_mismatch", discoveredIssuer: "https://identity.example.test/" })).toBe("Issuer 与身份源返回的值不一致。身份源返回：https://identity.example.test/。请核对地址及末尾斜杠。");
  expect(ssoConnectionMessage({ ok: true })).toBe("身份源可达。");
  expect(ssoConnectionMessage({ ok: false, code: "unknown", raw: "private-response" })).not.toContain("private-response");
});
