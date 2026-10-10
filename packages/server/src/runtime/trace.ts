import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent, SessionEventMap, TurnEndReason } from "@deepseek-ai/dsh-session";
import type { ToolResultView } from "@deepseek-ai/dsh-tools";
import type { ModelIdentity, ReadRange } from "../reviews/types.js";

export function workspacePath(cwd: string, path: string): string | undefined {
  const result = relative(cwd, isAbsolute(path) ? path : resolve(cwd, path));
  if (!result || result === ".." || result.startsWith(`..${sep}`) || isAbsolute(result)) return undefined;
  return result.split(sep).join("/");
}

export function presentedReads(name: string, view: ToolResultView | undefined): Array<{ path: string; lines: number[] }> {
  if (name === "read" && view?.card === "read") {
    return [{ path: view.path, lines: view.lines.map((line) => line.number) }];
  }
  if (name === "grep" && view?.card === "search" && view.shape === "matches") {
    return view.files.map((file) => ({ path: file.path, lines: file.matches.map((line) => line.lineNumber) }));
  }
  return [];
}

export class AgentTrace<Phase extends ReadRange["phase"] = ReadRange["phase"]> {
  // 读取证据来自实际工具结果；压缩只改模型对话表层，不清空这份累计账本。
  readonly reads: ReadRange[] = [];
  private readonly calls = new Map<string, SessionEventMap["tool/call"]>();
  completed = false;
  endReason: TurnEndReason | undefined;
  identity: ModelIdentity | undefined;
  invalid = false;

  constructor(private readonly cwd: string, readonly phase: Phase,
    private readonly expected: ModelIdentity) {}

  observe(ctx: Context, agent: Agent, event: SessionEvent): void {
    try {
      if (event.type === "turn/end") {
        this.endReason = event.data.reason;
        this.completed = event.data.reason.kind === "completed";
      }
      if (event.type === "request/header") {
        const { provider, model } = event.data.header.config;
        if (provider !== this.expected.provider || model !== this.expected.model) this.invalid = true;
        this.identity = { provider, model, vendor: this.expected.vendor };
      }
      if (event.type === "tool/call") this.calls.set(event.data.callId, event.data);
      if (event.type !== "tool/result") return;
      const { message, meta } = event.data;
      const call = this.calls.get(message.toolCallId);
      if (!call) return;
      if (message.isError) return;
      if (call.name !== "read" && call.name !== "grep") return;
      const view = ctx.tools.get(call.name, agent)?.presentResult?.(JSON.parse(call.arguments), {
        content: [...message.content], isError: false, ...(meta === undefined ? {} : { meta }),
      });
      for (const file of presentedReads(call.name, view)) this.record(file.path, file.lines, call.name);
    } catch {
      this.invalid = true;
    }
  }

  private record(rawPath: string, lineNumbers: number[], tool: "read" | "grep"): void {
    const path = workspacePath(this.cwd, rawPath);
    if (!path) { this.invalid = true; return; }
    const lines = [...new Set(lineNumbers)].sort((a, b) => a - b);
    let current: ReadRange | undefined;
    for (const line of lines) {
      if (!Number.isSafeInteger(line) || line < 1) { this.invalid = true; continue; }
      if (current && current.endLine + 1 === line) current.endLine = line;
      else {
        current = { path, startLine: line, endLine: line, tool, phase: this.phase };
        this.reads.push(current);
      }
    }
  }
}
