import { afterEach, describe, expect, it, vi } from "vitest";
import { agentSessionPageUrl, agentSessionSource, getAgentSession, listAgentSessions, preferredAgentSession, type AgentSessionSummary } from "./agent-sessions-api";

const generator: AgentSessionSummary = {
  id: "generator-stock", title: "修复库存释放", kind: "review_generator", status: "completed", model: "review-flash", provider: "generator",
  createdAt: "2026-10-05T00:00:00Z", updatedAt: "2026-10-05T00:01:00Z", completedAt: "2026-10-05T00:01:00Z",
  reviewId: "review-stock-round-two", ruleSessionId: null, repositoryName: "commerce/inventory", prNumber: 18, headSha: "a".repeat(40), reviewRound: 2, lastSeq: 24, errorCode: null,
};
const grader: AgentSessionSummary = { ...generator, id: "grader-stock", kind: "review_grader", provider: "grader", model: "review-pro", status: "failed", errorCode: "model_unavailable" };
afterEach(() => vi.restoreAllMocks());

describe("通用会话查看入口", () => {
  it("优先显示失败阶段，正常评审从 Generator 开始，不改动原列表顺序", () => {
    expect(preferredAgentSession([generator, grader])).toBe(grader);
    expect(preferredAgentSession([{ ...grader, status: "completed" }, generator])).toBe(generator);
    expect(preferredAgentSession([])).toBeUndefined();
  });
  it("来源链接绑定具体评审轮次，规范链接绑定逻辑对话", () => {
    expect(agentSessionSource(generator)).toBe("/?review=review-stock-round-two");
    expect(agentSessionSource({ ...generator, reviewId: null, ruleSessionId: "rule/payment", kind: "rule_generation" })).toBe("/?rules=1&session=rule%2Fpayment");
  });
  it("独立页面链接保留具体会话和当前视图", () => {
    const url = new URL(agentSessionPageUrl("grader/stock", "trajectory"), "http://localhost");
    expect(url.pathname).toBe("/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ "session-viewer": "grader/stock", view: "trajectory" });
  });
  it("用只读请求传递业务筛选与分页并解析状态元信息", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ items: [grader], total: 24, page: 2, pageSize: 20 })));
    const result = await listAgentSessions({ reviewId: generator.reviewId!, kind: "review_grader", status: "failed", search: "库存 PR !18", page: 2, pageSize: 20 });
    expect(result.items[0]?.reviewRound).toBe(2);
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://localhost");
    expect(url.pathname).toBe("/api/agent-sessions");
    expect(Object.fromEntries(url.searchParams)).toEqual({ reviewId: "review-stock-round-two", kind: "review_grader", status: "failed", search: "库存 PR !18", page: "2", pageSize: "20" });
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ session: generator })));
    expect((await getAgentSession("generator/stock")).session.id).toBe(generator.id);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/agent-sessions/generator%2Fstock");
  });
  it("拒绝错误状态及缺失业务轮次的数据，不误显示会话历史", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ session: { ...generator, status: "unknown" } })));
    await expect(getAgentSession(generator.id)).rejects.toThrow("数据不完整");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ items: [{ ...generator, reviewRound: 0 }], total: 1, page: 1, pageSize: 20 })));
    await expect(listAgentSessions({ page: 1 })).rejects.toThrow("数据不完整");
  });
});
