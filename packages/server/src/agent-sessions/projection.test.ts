import { MessageId, ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionSeq, type SessionEvent } from "@deepseek-ai/dsh-session";
import { describe, expect, it } from "vitest";
import { projectSessionEvent, redactSessionText } from "./projection.js";

const envelope = { seq: SessionSeq(0), time: 1 };
describe("会话展示事件的敏感信息边界", () => {
  it("保留请求模型与工具 schema，认证与供应商重放信息不进入展示副本", () => {
    const secret = "nonstandard-provider-secret";
    const event: SessionEvent = { ...envelope, type: "request/header", data: { reason: "initial", header: {
      config: Object.assign({ provider: "fixture", model: "fixture-flash" }, { apiKey: secret, credentials: { token: secret } }),
    } } };
    expect(projectSessionEvent(event)).toEqual({ ...envelope, type: "request/header", data: { reason: "initial", header: { config: { provider: "fixture", model: "fixture-flash" } } } });
    const assistant: SessionEvent = { ...envelope, type: "assistant/message", surfaceOp: "append", data: {
      turn: 1, step: 1, stream: [], message: { id: MessageId("answer"), role: "assistant", content: [{ type: "text", text: "库存不足时应返回错误" }],
        source: { kind: "model", provider: "fixture", model: "fixture-flash", replayState: { private: secret } } },
    } };
    expect(JSON.stringify(projectSessionEvent(assistant))).not.toContain(secret);
    expect(JSON.stringify(projectSessionEvent(assistant))).toContain("库存不足时应返回错误");
  });

  it("原始上游错误替换为安全分类，工具消息中的令牌和认证头脱敏", () => {
    const event: SessionEvent = { ...envelope, type: "turn/end", data: { turn: 1,
      reason: { kind: "error", error: { code: "UPSTREAM", message: "security_plugin_uninstalled headers: arbitrary-secret-value" } } } };
    expect(projectSessionEvent(event).data).toEqual({ turn: 1, reason: { kind: "error", error: { code: "security_plugin_required", message: "模型网关要求安装安全插件。" } } });
    const result: SessionEvent = { ...envelope, type: "tool/result", surfaceOp: "append", data: { turn: 1, step: 1,
      message: { id: MessageId("result"), role: "tool", toolCallId: ToolCallId("call"), source: { kind: "tool", callId: ToolCallId("call") },
        content: [{ type: "text", text: 'request api_key="nonstandard-secret" Authorization: Bearer foo.bar sk-1234567890 glpat-1234567890' }] },
      meta: { headers: { authorization: "raw-secret" } } } };
    const projected = JSON.stringify(projectSessionEvent(result));
    for (const secret of ["nonstandard-secret", "foo.bar", "sk-1234567890", "glpat-1234567890", "raw-secret"]) expect(projected).not.toContain(secret);
    expect(projected).toContain("[redacted]");
    expect(redactSessionText("https://user:password@example.test/api")).toBe("https://[redacted]@example.test/api");
  });

  it("未知扩展事件保留位置但不泄漏内容，供官方只读时间线按顺序消费", () => {
    const source: SessionEvent = { ...envelope, type: "ureview/hidden", data: { reason: "private transport state" }, ignorable: true };
    expect(projectSessionEvent(source)).toEqual({ ...envelope, type: "ureview/hidden", data: { reason: "此事件不包含可展示的会话内容。" }, ignorable: true });
  });
});
