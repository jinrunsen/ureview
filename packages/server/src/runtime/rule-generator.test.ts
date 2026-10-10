import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register } from "tsx/esm/api";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootReviewHost } from "./host.js";
import { RULE_GENERATION_TIMEOUT_MS, type RuleDraftGenerator } from "./rule-generator.js";
import { mockRuleDraft, startMockModelServer, type MockModelOptions } from "./test-support.js";

let directory: string;
let host: Awaited<ReturnType<typeof bootReviewHost>> | undefined;
let mock: Awaited<ReturnType<typeof startMockModelServer>> | undefined;
let generator: RuleDraftGenerator;
beforeAll(() => { register(); });
beforeEach(async () => { host = undefined; mock = undefined; directory = await mkdtemp(join(tmpdir(), "ureview-rule-generation-")); });
afterEach(async () => {
  vi.restoreAllMocks();
  try { await host?.dispose(); }
  finally { try { await mock?.dispose(); } finally { await rm(directory, { recursive: true, force: true }); } }
});
async function start(options: MockModelOptions = {}) {
  mock = await startMockModelServer(options);
  host = await bootReviewHost({ homeDir: directory, models: mock.models,
    onReady: async (_runtime, created) => { generator = created; return async () => {}; } });
}

function expectResponseLanguageLast(system: unknown): void {
  const expected = "思考过程（reasoning）、中间说明、回答和解释必须使用简体中文。所有面向用户的自然语言内容，包括解读正文、文件分组名称和主题、finding 标题、问题描述、证据说明、修复提示词、评分解释、规范正文与示例注释，都使用简体中文。Mermaid 图中的说明文字使用简体中文。工具名、结构化字段名、枚举值、代码标识符、文件路径、URL 和原文引用保持原样，不要翻译；代码示例遵循对应语言的语法。";
  const text = typeof system === "string" ? system : Array.isArray(system) ? system.map((block: unknown) => {
    if (typeof block !== "object" || block === null || !("text" in block) || typeof block.text !== "string") {
      throw new Error("模型请求的 system 段必须包含文本");
    }
    return block.text;
  }).join("\n\n") : "";
  expect(text.trimEnd().split(/\n\s*\n/).at(-1)).toBe(expected);
  expect(text.split(expected)).toHaveLength(2);
  expect(text.split("必须使用简体中文")).toHaveLength(2);
}

describe("自然语言规范生成的正式 dsh 接线", () => {
  it("通过 Generator 的唯一上报工具生成草稿，没有代码读取工具，完成后释放会话", async () => {
    await start();
    expect(await generator.generate("付款入口必须校验金额为正整数分")).toEqual(mockRuleDraft);
    expect(mock!.requests.length).toBeGreaterThan(0);
    for (const request of mock!.requests) expectResponseLanguageLast(request.body.system);
    expect(mock!.requests.every((request) => request.body.model === "fixture-generator")).toBe(true);
    expect(mock!.requests.every((request) => request.body.tools?.map((tool) => tool.name).join() === "submit_rule")).toBe(true);
    expect(JSON.stringify(mock!.requests[0]!.body.messages)).toContain("付款入口必须校验金额为正整数分");
    expect(host!.activeAgentCount).toBe(0);
  });

  it("生成与恢复规范会话时保留判断题属性", async () => {
    const draft = { ...mockRuleDraft, judgement: true, severity: "warning" as const };
    await start({ ruleDraft: draft });
    const sessionId = "ureview-rule-judgement";
    const first = await generator.continue({ sessionId, message: "检查可能的 Feature Envy" });
    expect(first.draft.judgement).toBe(true);
    const offset = mock!.requests.length;
    const second = await generator.continue({ sessionId, message: "补充 Strategy 的例外", draft: first.draft, checkpoint: first.checkpoint });
    expect(second.draft.judgement).toBe(true);
    expect(JSON.stringify(mock!.requests[offset]!.body.messages)).toContain('\\"judgement\\":true');
    expect(JSON.stringify(mock!.requests[0]!.body.messages)).toContain("judgement=true");
  });

  it("公开凭据服务在每次模型请求解析当前密钥，更新不需要重启 host", async () => {
    mock = await startMockModelServer();
    let key = "fixture-key-first";
    host = await bootReviewHost({ homeDir: directory, models: mock.models, resolveCredential: async () => key,
      onReady: async (_runtime, created) => { generator = created; return async () => {}; } });
    await generator.generate("金额必须为正数");
    expect(mock.requests.every((request) => request.apiKey === "fixture-key-first")).toBe(true);
    const offset = mock.requests.length;
    key = "fixture-key-second";
    await generator.generate("日志不得包含明文凭据");
    expect(mock.requests.slice(offset).length).toBeGreaterThan(0);
    expect(mock.requests.slice(offset).every((request) => request.apiKey === "fixture-key-second")).toBe(true);
  });

  it("修改模型名称和地址后新会话使用新路由，旧路由仍保留", async () => {
    mock = await startMockModelServer();
    const second = await startMockModelServer();
    let current = mock.models;
    host = await bootReviewHost({ homeDir: directory, models: current, resolveModels: async () => current,
      onReady: async (_runtime, created) => { generator = created; return async () => {}; } });
    try {
      await generator.generate("金额必须为正数");
      current = { ...second.models, generator: { ...second.models.generator, provider: "updated-generator", model: "updated-model" }, grader: { ...second.models.grader, provider: "updated-grader" } };
      await generator.generate("金额必须为正整数分");
      expect(second.requests.length).toBeGreaterThan(0);
      expect(second.requests.every((r) => r.body.model === "updated-model")).toBe(true);
      current = mock.models;
      const offset = mock.requests.length;
      await generator.generate("日志不得包含明文密钥");
      expect(mock.requests.slice(offset).length).toBeGreaterThan(0);
      expect(mock.requests.slice(offset).every((r) => r.body.model === "fixture-generator")).toBe(true);
    } finally { await second.dispose(); }
  });

  it.each(["missing", "duplicate", "invalid", "error"] as const)("模型生成分支 %s 返回安全失败并释放会话", async (mode) => {
    await start({ ruleGenerationMode: mode });
    const failure: unknown = await generator.generate("日志不得包含明文凭据").catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: mode === "error" ? "rule_generation_failed" : "invalid_rule_draft",
    });
    expect(String(failure)).not.toContain("PRIVATE_MODEL_ERROR_SENTINEL");
    if (mode === "error") expect(mock!.requests).toHaveLength(1);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("模型长时间不返回时，60 秒截止触发取消并释放会话", async () => {
    await start({ ruleGenerationMode: "hang" });
    const schedule = globalThis.setTimeout;
    // 只缩短产品截止计时器；协议连接和 dsh 的真实取消、释放仍完整执行。
    const timer = vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      schedule(callback, delay === RULE_GENERATION_TIMEOUT_MS ? 100 : delay, ...args)) as typeof setTimeout);
    await expect(generator.generate("付款入口必须校验金额")).rejects.toMatchObject({ code: "rule_generation_timeout", message: expect.stringContaining("60 秒") });
    expect(timer.mock.calls.some((call) => call[1] === 60_000)).toBe(true);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("无模型或无效意图不会发起请求，也不创建会话", async () => {
    host = await bootReviewHost({ homeDir: directory, onReady: async (_runtime, created) => { generator = created; return async () => {}; } });
    await expect(generator.generate("金额必须为正数")).rejects.toMatchObject({ code: "models_not_configured" });
    await expect(generator.generate(" ")).rejects.toMatchObject({ code: "invalid_rule_intent" });
    await expect(generator.generate("金".repeat(4001))).rejects.toMatchObject({ code: "invalid_rule_intent" });
    expect(host.activeAgentCount).toBe(0);
  });

  it("重启 host 后恢复同一会话的消息和工具历史，并使用用户手改草稿继续调整", async () => {
    const options: MockModelOptions = { ruleReply: "已补充金额校验。" };
    await start(options);
    const sessionId = "ureview-rule-restart";
    const first = await generator.continue({ sessionId, message: "付款金额必须为正整数分" });
    expect(first.reply).toBe("已补充金额校验。");
    expect(first.checkpoint.header.id).toBe(sessionId);
    expect(first.checkpoint.header.version).toBeGreaterThan(0);
    expect(first.checkpoint.events.some((event) => event.type === "tool/call" && event.data.name === "submit_rule")).toBe(true);
    expect(first.checkpoint.events.some((event) => event.type === "tool/result")).toBe(true);
    const saved = JSON.parse(JSON.stringify(first.checkpoint));
    await host!.dispose();
    host = undefined;
    options.ruleDraft = { ...mockRuleDraft, name: "支付金额与币种校验", body: "先校验正整数分，再校验支持的币种。" };
    options.ruleReply = "保留金额约束，并加入币种校验。";
    host = await bootReviewHost({ homeDir: directory, models: mock!.models,
      onReady: async (_runtime, created) => { generator = created; return async () => {}; } });
    const requestOffset = mock!.requests.length;
    const manualDraft = { ...mockRuleDraft, name: "", body: "我手动补充的币种要求" };
    const second = await generator.continue({ sessionId, message: "还要拒绝不支持的币种", draft: manualDraft, checkpoint: saved });
    const messages = mock!.requests[requestOffset]!.body.messages;
    const text = JSON.stringify(messages);
    expect(text).toContain("付款金额必须为正整数分");
    expect(text).toContain("还要拒绝不支持的币种");
    expect(text).toContain("我手动补充的币种要求");
    expect(text).toContain("tool_result");
    expect(messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
      .find((part) => part.type === "tool_use" && part.name === "submit_rule")?.input).toEqual(mockRuleDraft);
    expect(second.draft).toEqual(options.ruleDraft);
    expect(second.reply).toBe(options.ruleReply);
    expect(second.checkpoint.header).toEqual(first.checkpoint.header);
    expect(second.checkpoint.events.slice(0, first.checkpoint.events.length)).toEqual(first.checkpoint.events);
    expect(second.checkpoint.events.filter((event) => event.type === "user/message" && event.data.source.kind === "ureview-rule-generation")).toHaveLength(2);
    expect(second.checkpoint.events.map((event) => event.seq)).toEqual(second.checkpoint.events.map((_event, index) => index));
    for (const request of mock!.requests) expectResponseLanguageLast(request.body.system);
    expect(saved).toEqual(first.checkpoint);
    expect(host.activeAgentCount).toBe(0);
  });

  it("失败轮不改写已保存检查点，重试仍带上一轮上下文", async () => {
    const options: MockModelOptions = {};
    await start(options);
    const sessionId = "ureview-rule-retry";
    const first = await generator.continue({ sessionId, message: "日志不得输出密码" });
    const saved = JSON.stringify(first.checkpoint);
    options.ruleGenerationMode = "error";
    await expect(generator.continue({ sessionId, message: "增加 token 脱敏", checkpoint: first.checkpoint }))
      .rejects.toMatchObject({ code: "rule_generation_failed" });
    expect(JSON.stringify(first.checkpoint)).toBe(saved);
    expect(host!.activeAgentCount).toBe(0);
    options.ruleGenerationMode = "success";
    const offset = mock!.requests.length;
    const retried = await generator.continue({ sessionId, message: "增加 token 脱敏", checkpoint: first.checkpoint });
    expect(JSON.stringify(mock!.requests[offset]!.body.messages)).toContain("日志不得输出密码");
    expect(retried.checkpoint.events.filter((event) => event.type === "user/message" && event.data.source.kind === "ureview-rule-generation")).toHaveLength(2);
  });

  it("继续调整提交草稿后连接中断时，只重试说明请求并保留完整会话", async () => {
    const options: MockModelOptions = {};
    await start(options);
    const sessionId = "ureview-rule-transient-reply";
    const first = await generator.continue({ sessionId, message: "禁止直接拼接 SQL" });
    const saved = JSON.stringify(first.checkpoint);
    const offset = mock!.requests.length;
    options.ruleDraft = { ...mockRuleDraft, name: "repo 层数据库访问约束", body: "约束仅适用于 repo 层。" };
    options.ruleReply = "已将约束限制在 repo 层。";
    options.ruleReplyFailures = 1;
    const next = await generator.continue({ sessionId, message: "约束范围限制在仓库的repo层", draft: first.draft, checkpoint: first.checkpoint });
    expect(next.draft).toEqual(options.ruleDraft);
    expect(next.reply).toBe(options.ruleReply);
    const attempts = mock!.requests.slice(offset);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]!.body.messages).toEqual(attempts[1]!.body.messages);
    expect(JSON.stringify(attempts[2]!.body.messages)).toContain("tool_result");
    const events = next.checkpoint.events.slice(first.checkpoint.events.length);
    expect(events.filter((event) => event.type === "tool/call")).toHaveLength(1);
    expect(events.filter((event) => event.type === "user/message")).toHaveLength(1);
    expect(events.filter((event) => event.type === "turn/end").map((event) => event.data.reason.kind)).toEqual(["completed"]);
    expect(JSON.stringify(first.checkpoint)).toBe(saved);
    expect(host!.activeAgentCount).toBe(0);
    const resumed = await generator.continue({ sessionId, message: "补充 Go 示例", checkpoint: next.checkpoint });
    expect(resumed.checkpoint.events.slice(0, next.checkpoint.events.length)).toEqual(next.checkpoint.events);
  });

  it("说明请求持续断开时，最多重试两次并返回安全原因，不改写成功检查点", async () => {
    const options: MockModelOptions = {};
    await start(options);
    const sessionId = "ureview-rule-exhausted-reply";
    const first = await generator.continue({ sessionId, message: "禁止直接拼接 SQL" });
    const saved = JSON.stringify(first.checkpoint);
    const offset = mock!.requests.length;
    options.ruleReplyFailures = 10;
    await expect(generator.continue({ sessionId, message: "约束仅限 repo 层", checkpoint: first.checkpoint }))
      .rejects.toMatchObject({ code: "rule_model_unavailable" });
    expect(mock!.requests.slice(offset)).toHaveLength(4);
    expect(JSON.stringify(first.checkpoint)).toBe(saved);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("模型请求退避期间到达生成截止时间时，取消重试并释放会话", async () => {
    await start({ ruleReplyFailures: 10 });
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    let retryScheduled = false;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
      if (delay === RULE_GENERATION_TIMEOUT_MS) expire = () => callback(...args);
      const timer = schedule(callback, delay, ...args);
      if (mock!.requests.length === 2 && delay !== undefined && delay >= 450 && delay <= 550) {
        retryScheduled = true;
        // 等真实退避计时器注册后再触发截止，避免依赖前两次 HTTP 的耗时。
        queueMicrotask(() => expire?.());
      }
      return timer;
    }) as typeof setTimeout);
    await expect(generator.continue({ sessionId: "ureview-rule-cancel-retry", message: "约束仅限 repo 层" }))
      .rejects.toMatchObject({ code: "rule_generation_timeout" });
    expect(retryScheduled).toBe(true);
    expect(mock!.requests).toHaveLength(2);
    expect(host!.activeAgentCount).toBe(0);
  });

  it("公开 resume 为中断在工具调用后的日志补齐失败结果，并继续下一轮", async () => {
    await start();
    const sessionId = "ureview-rule-interrupted";
    const first = await generator.continue({ sessionId, message: "金额必须为正数" });
    const callIndex = first.checkpoint.events.findIndex((event) => event.type === "tool/call");
    expect(callIndex).toBeGreaterThan(0);
    const interrupted = { ...first.checkpoint, events: first.checkpoint.events.slice(0, callIndex + 1) };
    const offset = mock!.requests.length;
    const restored = await generator.continue({ sessionId, message: "补充整数约束", checkpoint: interrupted });
    expect(restored.checkpoint.events.slice(0, interrupted.events.length)).toEqual(interrupted.events);
    expect(JSON.stringify(mock!.requests[offset]!.body.messages)).toContain("outcome is unknown");
    expect(JSON.stringify(mock!.requests[offset]!.body.messages)).toContain('"is_error":true');
    expect(restored.checkpoint.events.some((event) => event.type === "turn/end" && event.data.reason.kind === "interrupted")).toBe(true);
    expect(restored.draft).toEqual(mockRuleDraft);
    expect(host!.activeAgentCount).toBe(0);
  });

  it.each(["version", "identity", "sequence"] as const)("拒绝 %s 损坏的检查点，不向模型发送历史", async (mode) => {
    await start();
    const sessionId = "ureview-rule-corrupt";
    const first = await generator.continue({ sessionId, message: "金额必须为正整数" });
    const checkpoint = mode === "version" ? { ...first.checkpoint, header: { ...first.checkpoint.header, version: 9999 } }
      : mode === "identity" ? { ...first.checkpoint, header: { ...first.checkpoint.header, id: "foreign-session" } }
      : { ...first.checkpoint, events: first.checkpoint.events.slice(1) };
    const count = mock!.requests.length;
    const failure: unknown = await generator.continue({ sessionId, message: "补充币种", checkpoint }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "rule_generation_failed", message: "规范生成未完成，请稍后重试" });
    expect(mock!.requests).toHaveLength(count);
    expect(host!.activeAgentCount).toBe(0);
    expect((await generator.continue({ sessionId, message: "补充币种", checkpoint: first.checkpoint })).draft).toEqual(mockRuleDraft);
  });

  it("并行规范会话互不共享历史，同一会话并发请求被拒绝且不影响持有者", async () => {
    let entered!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await start({ beforeReply: async () => { entered(); await gate; } });
    const first = generator.continue({ sessionId: "ureview-rule-parallel-a", message: "ALPHA_ONLY 金额校验" });
    await arrived;
    await expect(generator.continue({ sessionId: "ureview-rule-parallel-a", message: "不应进入的并发请求" }))
      .rejects.toMatchObject({ code: "rule_generation_failed" });
    const second = generator.continue({ sessionId: "ureview-rule-parallel-b", message: "BETA_ONLY 日志脱敏" });
    release();
    const results = await Promise.all([first, second]);
    expect(JSON.stringify(results[0]!.checkpoint)).toContain("ALPHA_ONLY");
    expect(JSON.stringify(results[0]!.checkpoint)).not.toContain("BETA_ONLY");
    expect(JSON.stringify(results[1]!.checkpoint)).toContain("BETA_ONLY");
    expect(JSON.stringify(results[1]!.checkpoint)).not.toContain("ALPHA_ONLY");
    expect(mock!.requests.every((request) => !JSON.stringify(request.body).includes("不应进入的并发请求"))).toBe(true);
    expect(host!.activeAgentCount).toBe(0);
  });
});
