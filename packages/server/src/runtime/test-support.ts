import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { FindingCandidate } from "../reviews/types.js";
import type { ReviewModels } from "./config.js";
import type { FileGroup } from "../reviews/file-groups.js";
import type { GeneratedRuleDraft } from "../rules/managed-types.js";

type CandidateInput = Omit<FindingCandidate, "id" | "ruleId" | "generatedAt"> & { ruleId?: string };
interface MockToolResultExpectation {
  isError: boolean;
  includes?: string;
}

/** 脚本中的这一步不调用工具，只回复文本结束本轮，用来等待宿主的下一条消息。 */
export const END_TURN = "";

export interface MockToolStep {
  /** 工具名；为 END_TURN 时这一步只回复文本。 */
  name: string;
  input: object | ((ids: string[]) => object);
  result: MockToolResultExpectation;
}

export interface MockModelOptions {
  importReply?: (body: RequestBody) => { name: string; input: object } | "error" | undefined;
  mode?: "finding" | "empty" | "no-report" | "model-error" | "missing-grade" | "invalid-range"
    | "missing-file-groups" | "invalid-file-groups" | "duplicate-file-groups";
  generatorScript?: MockToolStep[];
  /** 解读写作会话的脚本；脚本中的函数参数收到 [PR 标题]，便于引用需求原文。 */
  readingScript?: MockToolStep[];
  readingMode?: "success" | "model-error";
  /** 解读审读会话的脚本，默认提交空意见。 */
  readingReviewScript?: MockToolStep[];
  readingReviewMode?: "success" | "model-error";
  graderScript?: MockToolStep[];
  compactAfterGeneratorSteps?: number;
  path?: string;
  startLine?: number;
  endLine?: number;
  grepPattern?: string;
  candidates?: CandidateInput[];
  beforeReply?: (phase: MockPhase) => Promise<void>;
  extraCalls?: Array<{ name: string; input: object }>;
  discoveryCalls?: Array<{ name: string; input: object }>;
  graderCalls?: Array<{ name: string; input: object }>;
  fileGroups?: FileGroup[];
  scores?: number[];
  ruleDraft?: GeneratedRuleDraft;
  ruleReply?: string;
  ruleReplyFailures?: number;
  ruleGenerationMode?: "success" | "missing" | "duplicate" | "invalid" | "error" | "hang";
}

export const mockRuleDraft: GeneratedRuleDraft = {
  layer: "team", languages: [], judgement: false,
  name: "扣款金额必须为正数", body: "执行扣款前校验金额为正整数分，拒绝零和负数。",
  goodExample: "if (!Number.isInteger(amount) || amount <= 0) throw new Error('invalid amount');",
  badExample: "balance -= amount;", category: "correctness", severity: "error",
};

export function makeMockFileGroups(paths = ["src/payment.ts"]): FileGroup[] {
  return paths.length ? [{ name: "订单超时处理", files: paths.map((path) => ({ path, theme: "处理超时订单及库存释放" })) }] : [];
}

export type MockPhase = "reading" | "reading-review" | "generator" | "grader" | "rule";

/** 解读写作的默认脚本：读取引用的行，提交提纲与五个必需章节，然后结束。 */
export function makeMockDocumentScript(path = "src/payment.ts", startLine = 1, endLine = 3, title = ""): MockToolStep[] {
  const ok = { isError: false };
  const range = `${path}#L${startLine}-L${endLine}`;
  const sections: Record<string, string> = {
    summary: "<p>超时订单处理恢复已占用的库存，释放后的库存可供后续订单使用。</p>",
    background: `<p>改动前，超时订单占用的库存不会自动恢复。</p><ur-source source="pull_request" quote="${title.replaceAll("\"", "&quot;")}"></ur-source>`,
    scope: "<p>改动集中在库存恢复入口及其调用方。</p>",
    design: `<p>改动后，订单超时会调用库存恢复操作。</p><svg viewBox="0 0 240 60"><rect class="c-bad" x="10" y="10" width="90" height="36"></rect>`
      + `<text x="55" y="32" text-anchor="middle">改前：库存不恢复</text><rect class="c-ok" x="140" y="10" width="90" height="36"></rect>`
      + `<text x="185" y="32" text-anchor="middle">改后：库存恢复</text></svg>`,
    walkthrough: `<ur-code ref="${range}" title="入口"><ur-note line="${startLine}">接收超时订单标识。</ur-note></ur-code>`
      + `<ur-code ref="${range}" title="核心逻辑"></ur-code><ur-code ref="${range}" title="数据结构"></ur-code>`,
  };
  return [
    { name: "read", input: { file_path: path, offset: startLine, limit: endLine - startLine + 1 }, result: ok },
    { name: "submit_outline", input: { sections: [
      { id: "summary", label: "概要", title: "改动让超时订单恢复已占用的库存" },
      { id: "background", label: "背景", title: "改动前超时订单不会恢复库存" },
      { id: "scope", label: "改动范围", title: "改动集中在库存恢复入口" },
      { id: "design", label: "方案与行为变化", title: "订单超时后调用库存恢复操作" },
      { id: "walkthrough", label: "代码导读", title: "从超时入口读到库存恢复" },
    ] }, result: ok },
    ...Object.entries(sections).map(([id, html]) => ({ name: "write_section", input: { id, html }, result: ok })),
    { name: "finish_document", input: {}, result: ok },
  ];
}

export function makeMockReadingReviewScript(): MockToolStep[] {
  return [{ name: "submit_review", input: { issues: [] }, result: { isError: false } }];
}

interface RequestBody {
  model: string;
  messages: Array<{ role: string; content: string | Array<{
    type: string; name?: string; text?: string; input?: Record<string, unknown>; id?: string; tool_use_id?: string;
    is_error?: boolean; content?: string | Array<{ type: string; text?: string }>;
  }> }>;
  tools?: Array<{ name: string }>;
  [key: string]: unknown;
}

/** 从写作任务里取出 PR 标题，默认脚本用它引用需求原文。 */
function pullRequestTitle(body: RequestBody): string {
  const texts = body.messages.flatMap((message) => typeof message.content === "string"
    ? [message.content] : message.content.flatMap((part) => part.text ? [part.text] : []));
  for (const line of texts.flatMap((text) => text.split("\n"))) {
    const match = /^\[pull_request\] PR 标题：(.+)$/.exec(line);
    if (match) return match[1]!;
  }
  return "";
}

function respond(response: ServerResponse, id: string, tool?: { name: string; input: unknown }, reply = "评审完成") {
  const block = tool ? { type: "tool_use", id: `tool_${id}`, name: tool.name, input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } : { type: "text_delta", text: reply };
  const events = [
    { type: "message_start", message: { id, type: "message", role: "assistant", model: "fixture", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

// 只替换模型的 HTTP 协议端点；工具执行、会话生命周期与 profile 仍由正式 dsh 提供。
export async function startMockModelServer(options: MockModelOptions = {}) {
  const requests: Array<{ url: string; body: RequestBody; apiKey?: string }> = [];
  const path = options.path ?? "src/payment.ts";
  const startLine = options.startLine ?? 1;
  const endLine = options.endLine ?? 3;
  const candidates = options.candidates ?? [{
    title: "金额缺少边界检查", description: "传入负金额时仍然执行扣款。", severity: "high" as const,
    location: { path, startLine, endLine },
    evidence: [{ path, startLine, endLine, description: "扣款入口没有校验金额" }],
    fixPrompt: "在扣款入口拒绝非正金额，并补充边界用例。",
  }];
  const scriptErrors: string[] = [];
  const scriptPositions = new Map<string, number>();
  const scriptedCalls = new Map<string, number>();
  const validatedCalls = new Set<string>();
  let overflowSent = false;
  let compactionRequests = 0;
  let sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RequestBody;
      requests.push({ url: request.url ?? "", body, ...(typeof request.headers["x-api-key"] === "string" ? { apiKey: request.headers["x-api-key"] } : {}) });
      const phase: MockPhase = body.tools?.some((tool) => tool.name === "submit_outline") ? "reading"
        : body.tools?.some((tool) => tool.name === "submit_review") ? "reading-review"
          : body.tools?.some((tool) => tool.name === "submit_rule") ? "rule"
            : body.model === "fixture-grader" ? "grader" : "generator";
      await options.beforeReply?.(phase);
      const mode = options.mode ?? "finding";
      if ((phase === "reading" ? options.readingMode : phase === "reading-review" ? options.readingReviewMode : mode) === "model-error") {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "人工模型失败" } }));
        return;
      }
      const calls = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : [])
        .filter((content) => content.type === "tool_use");
      const id = `fixture_${++sequence}`;
      const lastMessage = body.messages.at(-1)?.content;
      const lastText = typeof lastMessage === "string" ? lastMessage : lastMessage?.map((part) => part.text ?? "").join("\n") ?? "";
      if (lastText.includes("You are now acting as a compaction engine")) {
        compactionRequests++;
        respond(response, id, undefined, "src/payment.ts 的 1–3 行已读取。有效结论已提交，请继续完成报告。");
        return;
      }
      if (options.importReply && body.tools?.some((tool) => ["submit_plan", "submit_entries"].includes(tool.name))) {
        const reply = options.importReply(body);
        if (reply === "error") { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "PRIVATE_IMPORT_MODEL_FAILURE" } })); }
        else respond(response, id, reply);
        return;
      }
      if (body.tools?.some((tool) => tool.name === "submit_rule")) {
        if (options.ruleGenerationMode === "hang") return;
        if (options.ruleGenerationMode === "error") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "PRIVATE_MODEL_ERROR_SENTINEL" } }));
          return;
        }
        const limit = options.ruleGenerationMode === "duplicate" ? 2 : options.ruleGenerationMode === "missing" ? 0 : 1;
        const input = options.ruleGenerationMode === "invalid" ? { ...mockRuleDraft, category: "invalid" } : options.ruleDraft ?? mockRuleDraft;
        const userIndex = body.messages.findLastIndex((message) => message.role === "user" &&
          (typeof message.content === "string" || message.content.some((part) => part.type === "text")));
        const turnCalls = body.messages.slice(userIndex + 1).flatMap((message) => Array.isArray(message.content) ? message.content : [])
          .filter((part) => part.type === "tool_use");
        if (turnCalls.length >= limit && (options.ruleReplyFailures ?? 0) > 0) {
          options.ruleReplyFailures!--;
          response.destroy();
          return;
        }
        respond(response, id, turnCalls.length < limit ? { name: "submit_rule", input } : undefined, options.ruleReply ?? "已根据本轮要求更新规范草稿。");
        return;
      }
      // 默认的解读脚本按本会话已发出的调用数推进，多个评审并行时互不干扰。
      const defaultScript = phase === "reading" && !options.readingScript ? makeMockDocumentScript(path, startLine, endLine, pullRequestTitle(body))
        : phase === "reading-review" && !options.readingReviewScript ? makeMockReadingReviewScript() : undefined;
      if (defaultScript) {
        const next = defaultScript[calls.length];
        respond(response, id, next ? { name: next.name, input: next.input } : undefined);
        return;
      }
      const script = phase === "reading" ? options.readingScript : phase === "reading-review" ? options.readingReviewScript
        : phase === "grader" ? options.graderScript : options.generatorScript;
      if (script) {
        const parts = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
        for (const call of calls) {
          if (!call.id || validatedCalls.has(call.id)) continue;
          const index = scriptedCalls.get(call.id) ?? -1;
          const expected = script[index];
          const result = parts.find((part) => part.type === "tool_result" && part.tool_use_id === call.id);
          const resultText = typeof result?.content === "string" ? result.content
            : result?.content?.map((part) => part.text ?? "").join("\n") ?? "";
          if (!expected || call.name !== expected.name || !result || Boolean(result.is_error) !== expected.result.isError ||
            (expected.result.includes !== undefined && !resultText.includes(expected.result.includes))) {
            scriptErrors.push(`${body.model} 第 ${index + 1} 步 ${call.name} 的工具回执不符：${JSON.stringify(result)}`);
            respond(response, id);
            return;
          }
          validatedCalls.add(call.id);
        }
        const position = scriptPositions.get(phase) ?? 0;
        if (phase === "generator" && position === options.compactAfterGeneratorSteps && !overflowSent) {
          overflowSent = true;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: context window exceeded" } }));
          return;
        }
        const next = script[position];
        const text = body.messages.map((message) => typeof message.content === "string"
          ? message.content : message.content.map((part) => part.text ?? "").join("\n")).join("\n");
        const ids = phase === "reading" ? [pullRequestTitle(body)]
          : [...new Set([...text.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((match) => match[1]!))];
        if (next) {
          if (next.name !== END_TURN) scriptedCalls.set(`tool_${id}`, position);
          scriptPositions.set(phase, position + 1);
        }
        respond(response, id, next && next.name !== END_TURN ? { name: next.name,
          input: typeof next.input === "function" ? next.input(ids) : next.input } : undefined);
        return;
      }
      if (body.model === "fixture-grader") {
        if (mode === "missing-grade") { respond(response, id); return; }
        if (calls.length < (options.graderCalls?.length ?? 0)) {
          respond(response, id, options.graderCalls![calls.length]);
          return;
        }
        const text = body.messages.map((message) => typeof message.content === "string"
          ? message.content : message.content.map((part) => part.text ?? "").join("\n")).join("\n");
        const ids = [...new Set([...text.matchAll(/"id":"([0-9a-f-]{36})"/g)].map((match) => match[1]!))];
        const graded = new Set(calls.filter((call) => call.name === "grade_finding").map((call) => call.input?.["findingId"]));
        const findingId = ids.find((candidateId) => !graded.has(candidateId));
        respond(response, id, findingId ? { name: "grade_finding", input: { findingId,
          score: options.scores?.[ids.indexOf(findingId)] ?? 88 } } : undefined);
        return;
      }
      if (mode === "no-report") { respond(response, id); return; }
      const ranges = new Map([[path, { startLine, endLine }]]);
      for (const candidate of candidates) {
        for (const range of [candidate.location, ...candidate.evidence]) {
          const previous = ranges.get(range.path);
          ranges.set(range.path, { startLine: Math.min(previous?.startLine ?? range.startLine, range.startLine),
            endLine: Math.max(previous?.endLine ?? range.endLine, range.endLine) });
        }
      }
      const discovery: Array<{ name: string; input: object }> = options.discoveryCalls ?? [
        ...(options.extraCalls ?? []),
        { name: "glob", input: { pattern: "**/*" } },
        { name: "grep", input: { pattern: options.grepPattern ?? "amount" } },
        ...[...ranges].map(([path, range]) => ({ name: "read", input: {
          file_path: path, offset: range.startLine, limit: range.endLine - range.startLine + 1,
        } })),
      ];
      const index = calls.length;
      if (index < discovery.length) { respond(response, id, discovery[index]); return; }
      const reportIndex = index - discovery.length;
      if (mode !== "empty" && reportIndex < candidates.length) {
        const candidate = structuredClone(candidates[reportIndex]!);
        if (mode === "invalid-range") candidate.location.endLine = 99999;
        respond(response, id, { name: "report_finding", input: candidate });
        return;
      }
      const groupCalls = calls.filter((call) => call.name === "report_file_groups").length;
      if (mode !== "missing-file-groups" && groupCalls < (mode === "duplicate-file-groups" ? 2 : 1)) {
        const texts = body.messages.flatMap((message) => typeof message.content === "string"
          ? [message.content] : message.content.flatMap((part) => part.text ? [part.text] : []));
        let paths = [path];
        for (const line of texts.flatMap((text) => text.split("\n"))) {
          try {
            const value = JSON.parse(line) as { pullRequest?: object; files?: Array<{ oldPath: string; newPath: string; deletedFile: boolean }> };
            if (value.pullRequest && Array.isArray(value.files)) {
              paths = value.files.map((file) => file.deletedFile ? file.oldPath : file.newPath);
            }
          } catch { /* 消息中只有评审输入这一行是 JSON。 */ }
        }
        const fileGroups = mode === "invalid-file-groups" ? [{ name: "无效路径", files: [{ path: "unrelated.ts", theme: "不属于本次改动" }] }]
          : structuredClone(options.fileGroups ?? makeMockFileGroups(paths));
        respond(response, id, { name: "report_file_groups", input: { fileGroups } });
        return;
      }
      if (!calls.some((call) => call.name === "finish_report")) {
        respond(response, id, { name: "finish_report", input: {} });
        return;
      }
      respond(response, id);
    } catch {
      response.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const keys = ["UREVIEW_TEST_GENERATOR_KEY", "UREVIEW_TEST_GRADER_KEY"] as const;
  const previous = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = "fixture-api-key";
  const models: ReviewModels = {
    generator: { vendor: "fixture-vendor-a", provider: "ureview-generator", model: "fixture-generator", api: "anthropic-messages", baseURL, apiKeyEnv: keys[0] },
    grader: { vendor: "fixture-vendor-b", provider: "ureview-grader", model: "fixture-grader", api: "anthropic-messages", baseURL, apiKeyEnv: keys[1] },
  };
  return {
    models, requests, scriptErrors,
    get compactionRequests() { return compactionRequests; },
    async dispose() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
    },
  };
}
