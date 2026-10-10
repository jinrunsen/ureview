import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { ManagedRuleDeletion } from "./managed-rule-deletion";
import { deleteManagedRule } from "./managed-rules-api";
import { RuleProposals } from "./rule-proposals";
import type { RuleProposal } from "./rule-proposals-api";

const rule = { id: "money/cents", version: 3, name: "金额使用整数分" };
let root: Root | undefined;
let restoreDialog: (() => void) | undefined;

async function mount(content?: ReactNode) {
  const { document, window } = parseHTML("<!doctype html><html><body><main></main></body></html>");
  vi.stubGlobal("window", window); vi.stubGlobal("document", document); vi.stubGlobal("HTMLElement", window.HTMLElement);
  vi.stubGlobal("location", { search: "?proposalStatus=accepted" });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callback(0));
  Object.defineProperties(window.HTMLElement.prototype, {
    showModal: { configurable: true, value(this: HTMLElement) { this.setAttribute("open", ""); } },
    close: { configurable: true, value(this: HTMLElement) { this.removeAttribute("open"); } },
  });
  restoreDialog = () => { Reflect.deleteProperty(window.HTMLElement.prototype, "showModal"); Reflect.deleteProperty(window.HTMLElement.prototype, "close"); };
  const container = document.querySelector("main")!; const onDeleted = vi.fn(); root = createRoot(container);
  await act(async () => { root!.render(content ?? createElement(ManagedRuleDeletion, { rule, onDeleted })); });
  function button(text: string) {
    const element = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
    if (!element) throw new Error(`找不到按钮：${text}`);
    return element;
  }
  return { container, button, onDeleted };
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined; restoreDialog?.(); restoreDialog = undefined;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("已删除规范的提案历史", () => {
  const ruleId = "managed:beec986b-7390-407f-88c0-a8115558177e";
  const proposal: RuleProposal = { id: "proposal-one", source: "feedback", status: "accepted", name: rule.name, body: "金额使用整数分，费率另行设置精度。",
    managedRuleId: null, ruleId, repositoryId: null, reasonCategory: "rule_incorrect", feedbackCount: 1,
    feedback: [{ findingId: "finding-one", reviewId: "review-one", title: "费率使用了浮点数", explanation: "费率不属于金额", createdAt: "2026-10-08T08:00:00Z" }],
    candidate: null, createdAt: "2026-10-08T08:00:00Z", reviewedAt: "2026-10-08T08:10:00Z", reviewedBy: { id: "admin-one", name: "陈敏" }, rejectionReason: null };
  const content = () => createElement(RuleProposals, { repositories: [], canManage: true, revision: 0, onChanged: vi.fn() });

  it.each(["generation", "library", "feedback"] as const)("已删除的 %s 规范没有评审快照时，保留历史并隐藏失效链接与 Git 修改建议", async (source) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [{ ...proposal, source }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "规范不存在" } }), { status: 404 }));
    const view = await mount(content());
    expect(fetch).toHaveBeenCalledTimes(1);
    await act(async () => { view.button(proposal.name).click(); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/rules/${encodeURIComponent(ruleId)}/detail`);
    const dialog = view.container.querySelector("dialog")!;
    expect(dialog.textContent).toContain("关联规范已删除，提案历史保留");
    expect(dialog.textContent).toContain(proposal.body); expect(dialog.textContent).toContain("陈敏");
    expect(dialog.querySelector('a[href*="rules=1"]')).toBeNull();
    expect(dialog.textContent).not.toContain("Git 规范修改建议");
    expect(dialog.querySelector("#git-suggestion-body")).toBeNull();
  });

  it("已删除规范仍有历史快照时提供详情入口，并保留反馈与审核记录", async () => {
    const snapshot = { rule: { id: ruleId, name: rule.name, body: proposal.body, goodExample: "", badExample: "", layer: "team", languages: [], overrides: [], judgement: false,
      overriddenBy: [], scope: "global", repositories: [], waivers: [], source: { kind: "managed" }, version: 3, status: "snapshot" },
      summary: { hits: 0, adopted: 0, dismissed: 0, ignored: 0, dismissalReasons: {} }, records: [] };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({ proposals: [proposal] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot)));
    const view = await mount(content());
    await act(async () => { view.button(proposal.name).click(); });
    const dialog = view.container.querySelector("dialog")!;
    expect(dialog.querySelector('a[href*="rules=1"]')?.textContent).toContain("查看关联规范与执行记录");
    expect(dialog.textContent).toContain("费率不属于金额"); expect(dialog.textContent).toContain("审核记录");
    expect(dialog.textContent).not.toContain("Git 规范修改建议");
  });

  it("Git 规范反馈仍显示修改建议", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ proposals: [{ ...proposal, ruleId: "repository:.agents/rules/money.md", repositoryId: "repo-one" }] })));
    const view = await mount(content());
    await act(async () => { view.button(proposal.name).click(); });
    const dialog = view.container.querySelector("dialog")!;
    expect(dialog.textContent).toContain("Git 规范修改建议"); expect(dialog.querySelector("#git-suggestion-body")).not.toBeNull();
    expect(dialog.textContent).not.toContain("关联规范已删除"); expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("删除规范确认", () => {
  it("打开确认显示规范名与保留历史的说明，取消不发送请求", async () => {
    const fetch = vi.spyOn(globalThis, "fetch"); const view = await mount();
    await act(async () => { view.button("删除规范").click(); });
    expect(view.container.querySelector("dialog[open]")?.textContent).toContain(rule.name);
    expect(view.container.querySelector("dialog")?.textContent).toContain("不再参与后续评审");
    expect(view.container.querySelector("dialog")?.textContent).toContain("历史评审及当时的规范快照会保留");
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => { view.button("取消").click(); });
    expect(view.container.querySelector("dialog")).toBeNull();
    expect(fetch).not.toHaveBeenCalled(); expect(view.onDeleted).not.toHaveBeenCalled();
  });

  it("确认携带所见版本，请求完成前阻止重复删除与关闭，成功后通知页面", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const fetch = vi.spyOn(globalThis, "fetch").mockReturnValue(pending); const view = await mount();
    await act(async () => { view.button("删除规范").click(); });
    const confirm = view.button("确认删除");
    await act(async () => { confirm.click(); confirm.click(); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/managed-rules/money%2Fcents");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ version: 3 });
    expect(view.button("正在删除…").disabled).toBe(true); expect(view.button("取消").disabled).toBe(true);
    await act(async () => { view.container.querySelector<HTMLButtonElement>('[aria-label="关闭详情"]')!.click(); });
    expect(view.container.querySelector("dialog")).not.toBeNull(); expect(view.onDeleted).not.toHaveBeenCalled();
    await act(async () => { resolve(new Response(JSON.stringify({ deleted: true }))); });
    expect(view.onDeleted).toHaveBeenCalledTimes(1);
  });

  it.each([
    [403, "只有团队管理员可以删除规范"],
    [404, "规范不存在"],
    [409, "规范已有更新，请刷新后重试"],
  ])("删除失败 %s 时显示原因并保留规范确认页", async (status, message) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: { message } }), { status: Number(status) }));
    const view = await mount();
    await act(async () => { view.button("删除规范").click(); });
    await act(async () => { view.button("确认删除").click(); });
    expect(fetch).toHaveBeenCalledTimes(1); expect(view.onDeleted).not.toHaveBeenCalled();
    expect(view.container.querySelector('[role="alert"]')?.textContent).toBe(message);
    expect(view.container.querySelector("dialog")?.textContent).toContain(rule.name);
    expect(view.button("取消").disabled).toBe(false);
    expect(view.button("确认删除").disabled).toBe(false);
  });

  it("失败后可以重新确认，只有成功响应才通知页面", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ deleted: true })));
    const view = await mount();
    await act(async () => { view.button("删除规范").click(); });
    await act(async () => { view.button("确认删除").click(); });
    expect(view.onDeleted).not.toHaveBeenCalled();
    await act(async () => { view.button("确认删除").click(); });
    expect(view.onDeleted).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([{}, { deleted: false }, { deleted: "true" }])("删除响应没有明确成功时拒绝返回成功：%j", async (result) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(result)));
    await expect(deleteManagedRule(rule.id, rule.version)).rejects.toThrow("数据不完整");
  });
});
