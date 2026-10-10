import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import type { SessionEvent } from "@deepseek-ai/dsh-session";
import { currentTeamId, withTeam } from "../db/tenant.js";
import { failureCategory } from "../logging.js";
import { ReviewError } from "../reviews/types.js";

export interface SessionRecordingInput {
  dshSessionId: string;
  kind: "review_reading" | "review_generator" | "review_grader" | "rule_generation";
  reviewId?: string;
  ruleSessionId?: string;
  provider: string;
  model: string;
}

export interface SessionRecorder {
  begin(input: SessionRecordingInput & { id: string }): Promise<unknown>;
  append(id: string, event: SessionEvent): Promise<unknown>;
  finish(id: string, status: "completed" | "failed", errorCode?: string): Promise<unknown>;
}

/** 会话事件按序写入，租户取自启动任务时的上下文，不依赖 dsh 回调的异步上下文。 */
export async function captureSession(ctx: Context, recorder: SessionRecorder | undefined,
  input: SessionRecordingInput, history: readonly SessionEvent[] = [],
  readHistory?: () => readonly SessionEvent[]): Promise<{ close(error?: unknown): Promise<void> } | undefined> {
  if (!recorder) return undefined;
  const teamId = currentTeamId();
  if (!teamId) throw new Error("会话记录缺少团队上下文");
  const scoped = <T>(run: () => T) => withTeam(teamId, run);
  const id = randomUUID();
  await scoped(() => recorder.begin({ ...input, id }));
  try { for (const event of history) await scoped(() => recorder.append(id, event)); }
  catch (error) { await scoped(() => recorder.finish(id, "failed", "recording_failed")); throw error; }
  let pending = Promise.resolve();
  let nextSeq = history.length;
  let ended = false;
  let errorCode: string | undefined;
  const off = ctx.on("session/event", (session, event) => {
    if (session.id !== input.dshSessionId) return;
    if (event.type === "turn/end") {
      ended = event.data.reason.kind === "completed";
      errorCode = ended ? undefined : failureCategory(JSON.stringify(event.data.reason));
    }
    // resume 可通过公开存储句柄追加恢复事件；这些事件不一定再次发出 session/event。
    try {
      const batch = event.seq > nextSeq && readHistory ? [...readHistory().slice(nextSeq, event.seq), event] : [event];
      nextSeq = Math.max(nextSeq, event.seq + 1);
      pending = pending.then(async () => { for (const item of batch) await scoped(() => recorder.append(id, item)); });
    } catch (error) { pending = pending.then(() => { throw error; }); }
    // 事件监听器不能等待数据库；close 会重新抛出写入错误。
    void pending.catch(() => {});
  }, { global: true });
  return { async close(error) {
    off();
    try {
      await pending;
      for (const event of readHistory?.().slice(nextSeq) ?? []) await scoped(() => recorder.append(id, event));
      await scoped(() => recorder.finish(id, ended && error === undefined ? "completed" : "failed",
        error instanceof ReviewError ? error.code : errorCode ?? (error === undefined ? undefined : failureCategory(error))));
    } catch (cause) {
      await scoped(() => recorder.finish(id, "failed", "recording_failed"));
      throw cause;
    }
  } };
}
